import { autocompletion, snippet, pickedCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorView, hoverTooltip, keymap, ViewPlugin } from '@codemirror/view';
import type { EditorState, Extension } from '@codemirror/state';
import type { NyCompletionItem, NyDiagnostic, NyDocument, NyHover, NyLocation, NyPosition, NyStatus } from '../../../src/api/ny';
import { nyLocalCompletions } from './nyLanguage';
import { matrixLocalCompletions } from './matrixLanguage';

export interface NyEditorApi {
  status(): Promise<NyStatus>;
  completion(document: NyDocument): Promise<NyCompletionItem[]>;
  hover(document: NyDocument): Promise<NyHover | null>;
  definition(document: NyDocument): Promise<NyLocation[]>;
  diagnostics?(document: NyDocument): Promise<NyDiagnostic[]>;
}
export interface NyEditorOptions {
  api: () => NyEditorApi | undefined;
  reveal: (path: string, line: number) => void;
  onStatus: (message: string) => void;
  documents?: () => Array<{ path: string; text: string }>;
}

export function nyPosition(state: EditorState, offset: number): NyPosition {
  const line = state.doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

/** LSP and CodeMirror use UTF-16 offsets. Reject bad locations rather than jumping elsewhere. */
export function nyOffset(state: EditorState, position: NyPosition): number | null {
  if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0 || position.line >= state.doc.lines) return null;
  const line = state.doc.line(position.line + 1);
  return position.character <= line.length ? line.from + position.character : null;
}

function request(path: string, state: EditorState, offset: number): NyDocument {
  return { path, text: state.doc.toString(), ...nyPosition(state, offset) };
}

export function nyHoverText(hover: NyHover): string {
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  return contents.map((value) => typeof value === 'string' ? value : value.value).join('\n\n')
    .replace(/^```[^\n]*\n/gm, '').replace(/^```\s*$/gm, '').trim();
}

const completionTypes: Record<number, string> = {
  2: 'method', 3: 'function', 4: 'function', 5: 'property', 6: 'variable', 7: 'class',
  8: 'interface', 9: 'namespace', 10: 'property', 12: 'text', 13: 'enum', 14: 'keyword',
  15: 'keyword', 20: 'enum', 21: 'constant', 22: 'type', 25: 'type',
};

export function nyServerCompletion(item: NyCompletionItem, state: EditorState): Completion {
  const info = typeof item.documentation === 'string' ? item.documentation : item.documentation?.value;
  const from = item.textEdit ? nyOffset(state, item.textEdit.range.start) : null;
  const to = item.textEdit ? nyOffset(state, item.textEdit.range.end) : null;
  const completion: Completion = {
    label: item.label, detail: item.detail, info,
    type: completionTypes[item.kind ?? 0] ?? 'text', sortText: item.sortText, boost: 15,
  };
  const text = item.textEdit?.newText ?? item.insertText ?? item.label;
  const insertSnippet = item.insertTextFormat === 2 ? snippet(text) : null;
  completion.apply = (view, selected, defaultFrom, defaultTo) => {
    // CodeMirror may reuse a completion while the prefix grows. Only use the server's
    // original edit range if its document still matches; otherwise use the current range.
    const serverRange = view.state.doc.eq(state.doc) && from !== null && to !== null && from <= to;
    const start = serverRange ? from : defaultFrom, end = serverRange ? to : defaultTo;
    if (insertSnippet) insertSnippet(view, selected, start, end);
    else view.dispatch({ changes: { from: start, to: end, insert: text }, selection: { anchor: start + text.length }, annotations: pickedCompletion.of(selected) });
  };
  return completion;
}

export async function nyCompletions(context: CompletionContext, path: string, api?: NyEditorApi, onError?: (error: unknown) => void): Promise<CompletionResult | null> {
  const local = /\.(?:matrix|mat)$/i.test(path) ? matrixLocalCompletions(context) : nyLocalCompletions(context);
  if (!local || !api) return local;
  try {
    const items = await api.completion(request(path, context.state, context.pos));
    if (context.aborted) return null;
    // The real server knows lexical scopes; fallback scanning deliberately does not. Retire
    // document guesses when the SDK answers so unrelated locals cannot leak into completion.
    const merged = new Map(local.options.filter((item) => item.detail !== 'This file').map((item) => [item.label, item]));
    for (const item of items) merged.set(item.label, nyServerCompletion(item, context.state));
    return { ...local, options: [...merged.values()] };
  } catch (error) {
    if (!context.aborted) onError?.(error);
    // A missing/restarting SDK must never take snippets and local suggestions away.
    return context.aborted ? null : local;
  }
}

export function nyEditorDiagnostics(state: EditorState, diagnostics: NyDiagnostic[], path: string): Diagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    if (diagnostic.path && diagnostic.path !== path) return [];
    const from = nyOffset(state, diagnostic.range.start), end = nyOffset(state, diagnostic.range.end);
    if (from === null || end === null || end < from) return [];
    return [{ from, to: end, message: diagnostic.message, source: diagnostic.source ?? (/\.(?:matrix|mat)$/i.test(path) ? 'Matrix compiler' : 'Ny compiler'),
      severity: diagnostic.severity === 2 ? 'warning' as const : diagnostic.severity === 3 || diagnostic.severity === 4 ? 'info' as const : 'error' as const }];
  });
}

/** Main owns the SDK process and workspace path checks; the renderer only sends editor buffers. */
export function nyIntelligence(path: string, options: NyEditorOptions): Extension {
  const language = /\.(?:matrix|mat)$/i.test(path) ? 'Matrix' : 'Ny';
  let available = true;
  let live = true;
  let generation = 0;
  const withDocuments = (document: NyDocument): NyDocument => ({ ...document, ...(options.documents ? { documents: options.documents() } : {}) });
  const checked = async <T,>(document: NyDocument, run: (input: NyDocument) => Promise<T>): Promise<T> => {
    const input = withDocuments(document), overlay = JSON.stringify(input.documents);
    const result = await run(input);
    if (options.documents && JSON.stringify(options.documents()) !== overlay) throw new Error('Source buffers changed; retry language query.');
    return result;
  };
  const client = (): NyEditorApi | undefined => {
    const api = available ? options.api() : undefined;
    if (!api) return undefined;
    return { status: () => api.status(), completion: (document) => checked(document, (input) => api.completion(input)),
      hover: (document) => checked(document, (input) => api.hover(input)), definition: (document) => checked(document, (input) => api.definition(input)),
      ...(api.diagnostics ? { diagnostics: (document: NyDocument) => api.diagnostics!(withDocuments(document)) } : {}) };
  };
  const unavailable = (error: unknown) => {
    if (live) options.onStatus(`${language} snippets · ${error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') : 'Language server unavailable'}`);
  };
  return [
    autocompletion({ activateOnTypingDelay: 250, override: [(context) => {
      const currentGeneration = generation;
      return nyCompletions(context, path, client(), (error) => { if (generation === currentGeneration) unavailable(error); }).then((result) => live && generation === currentGeneration ? result : null);
    }] }),
    lintGutter(),
    keymap.of([
      ...lintKeymap,
      { key: 'F12', preventDefault: true, run(view) {
        const api = client();
        if (!api) return false;
        const state = view.state, position = state.selection.main.head, currentGeneration = generation;
        void api.definition(request(path, state, position)).then((locations) => {
          if (!live || generation !== currentGeneration || view.state !== state) return;
          const destination = locations.find((location) => location.path !== undefined);
          if (destination?.path !== undefined) options.reveal(destination.path, destination.range.start.line + 1);
          else options.onStatus(`${language} · No definition found in this project`);
        }).catch((error) => { if (generation === currentGeneration) unavailable(error); });
        return true;
      } },
    ]),
    hoverTooltip(async (view, position) => {
      const api = client();
      const state = view.state;
      const currentGeneration = generation;
      const node = syntaxTree(state).resolveInner(position, -1);
      if (!api || /comment|string/i.test(node.name)) return null;
      try {
        const hover = await api.hover(request(path, state, position));
        if (!hover || !live || generation !== currentGeneration || view.state !== state) return null;
        const text = nyHoverText(hover);
        if (!text) return null;
        const start = hover.range ? nyOffset(state, hover.range.start) : null;
        const end = hover.range ? nyOffset(state, hover.range.end) : null;
        return {
          pos: start ?? position, ...(end === null ? {} : { end }), above: true,
          create() {
            const dom = document.createElement('div');
            dom.className = 'cm-ny-hover';
            dom.textContent = text;
            return { dom };
          },
        };
      } catch { return null; }
    }, { hoverTime: 350 }),
    EditorView.theme({ '.cm-ny-hover': { padding: '8px 10px', maxWidth: 'min(520px, 75vw)', maxHeight: '280px', overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: '12px' } }),
    ViewPlugin.define((view) => {
      live = true;
      const currentGeneration = ++generation;
      let analysisTimer: ReturnType<typeof setTimeout> | undefined;
      let analysisGeneration = 0;
      const analyze = () => {
        clearTimeout(analysisTimer);
        const revision = ++analysisGeneration;
        analysisTimer = setTimeout(() => {
          const api = options.api();
          if (!api?.diagnostics) return;
          const text = view.state.doc.toString(), documents = options.documents?.();
          const current = () => live && generation === currentGeneration && analysisGeneration === revision && view.state.doc.toString() === text &&
            (!options.documents || JSON.stringify(options.documents()) === JSON.stringify(documents));
          void api.diagnostics({ path, text, ...(documents ? { documents } : {}) }).then((items) => {
            if (!current()) return;
            window.dispatchEvent(new CustomEvent('antimatter:ny-diagnostics', { detail: { path, text, diagnostics: items, documents } }));
          }).catch((error: unknown) => {
            if (current()) options.onStatus(`${language} · Live analysis unavailable: ${error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') : 'Check SDK settings'}`);
          });
        }, 550);
      };
      const refresh = () => {
        analyze();
        options.onStatus(`${language} · Connecting language tools…`);
        const api = options.api();
        if (!api) { available = false; options.onStatus(`${language} · Local snippets`); }
        else void api.status().then((status) => {
          if (!live || generation !== currentGeneration) return;
          available = status.lsp || status.compiler;
          options.onStatus(status.lsp || status.compiler ? `${language} · Completion${status.lsp ? ", hover" : ""}, F12 definition` : `${language} snippets · ${status.message}`);
        }).catch((error) => { if (generation === currentGeneration) unavailable(error); });
      };
      refresh();
      const diagnostics = (event: Event) => {
        const result = (event as CustomEvent<{ path: string; text?: string; diagnostics: NyDiagnostic[] }>).detail;
        if (!result || result.path !== path || (result.text !== undefined && result.text !== view.state.doc.toString())) return;
        view.dispatch(setDiagnostics(view.state, nyEditorDiagnostics(view.state, result.diagnostics, path)));
      };
      window.addEventListener('antimatter:ny-diagnostics', diagnostics);
      window.addEventListener('antimatter:ny-sdk-changed', refresh);
      return {
        update(update) {
          if (update.docChanged) {
            analyze();
            // Compiler diagnostics describe the checked buffer. An edit retires those results.
            queueMicrotask(() => { if (live && view.state.doc === update.state.doc) view.dispatch(setDiagnostics(view.state, [])); });
          }
        },
        destroy() { live = false; generation++; analysisGeneration++; clearTimeout(analysisTimer); window.removeEventListener('antimatter:ny-diagnostics', diagnostics); window.removeEventListener('antimatter:ny-sdk-changed', refresh); },
      };
    }),
  ];
}
