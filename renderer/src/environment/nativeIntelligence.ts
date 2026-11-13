import { autocompletion, pickedCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { lintGutter, lintKeymap, setDiagnostics } from '@codemirror/lint';
import { EditorView, hoverTooltip, keymap, ViewPlugin } from '@codemirror/view';
import type { EditorState, Extension, TransactionSpec } from '@codemirror/state';
import type { NativeProjectAPI } from '../../../src/api/nativeProject';
import type { NyCompletionItem, NyDocument } from '../../../src/api/ny';
import { nyEditorDiagnostics, nyHoverText, nyOffset, nyPosition, nyServerCompletion } from './nyIntelligence';

export interface NativeEditorOptions {
  api(): NativeProjectAPI['language'] | undefined;
  documents(): Array<{ path: string; text: string }>;
  reveal(path: string, line: number): void;
  onStatus(message: string): void;
}
export const isNativeSource = (path: string): boolean => /\.(?:rs|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(path);
const rustWords = 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while';
const cppWords = 'alignas auto bool break case catch char class const constexpr continue default delete do double else enum explicit false float for if inline int long namespace new noexcept nullptr private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while';

function sameDocuments(a: Array<{ path: string; text: string }>, b: Array<{ path: string; text: string }>): boolean {
  return a.length === b.length && a.every((item, index) => item.path === b[index].path && item.text === b[index].text);
}
function request(path: string, state: EditorState, offset: number, documents: NativeEditorOptions['documents']): NyDocument {
  return { path, text: state.doc.toString(), ...nyPosition(state, offset), documents: documents() };
}

/** Import edits and the insertion belong to one undo step. Server ranges expire after typing. */
export function nativeServerCompletion(item: NyCompletionItem, state: EditorState): Completion {
  const completion = nyServerCompletion(item, state);
  if (!item.additionalTextEdits?.length) {
    return completion;
  }
  const baseApply = completion.apply;
  completion.apply = (view, selected, defaultFrom, defaultTo) => {
    if (!view.state.doc.eq(state.doc)) {
      // Additional edits are absolute positions. Applying them after a buffer change can edit
      // unrelated text, so the completion must be requested again.
      return;
    }
    const edits = item.additionalTextEdits!.map((edit) => ({ from: nyOffset(state, edit.range.start), to: nyOffset(state, edit.range.end), insert: edit.newText }));
    if (edits.some((edit) => edit.from === null || edit.to === null || edit.from > edit.to)) {
      return;
    }
    // CodeMirror creates snippet fields against the intermediate buffer. Compose its spec
    // with imports before dispatch so one undo also removes the accompanying imports.
    const from = item.textEdit ? nyOffset(state, item.textEdit.range.start) : defaultFrom;
    const to = item.textEdit ? nyOffset(state, item.textEdit.range.end) : defaultTo;
    if (from === null || to === null || from > to || edits.some((edit) => edit.from! < to && edit.to! > from || edit.from === from)) {
      return;
    }
    const changes = edits.map((edit) => ({ from: edit.from!, to: edit.to!, insert: edit.insert })).sort((a, b) => a.from - b.from);
    if (changes.some((edit, index) => index > 0 && edit.from < changes[index - 1].to)) {
      return;
    }
    if (item.insertTextFormat === 2 && typeof baseApply === 'function') {
      const transaction = state.update({ changes, annotations: pickedCompletion.of(selected), userEvent: 'input.complete' });
      const editor = { state: transaction.state, dispatch(spec: TransactionSpec) {
        view.dispatch(state.update({ changes }, { ...spec, sequential: true }));
      } } as EditorView;
      baseApply(editor, selected, transaction.changes.mapPos(from, 1), transaction.changes.mapPos(to, 1));
    } else {
      const insert = item.textEdit?.newText ?? item.insertText ?? item.label;
      const transaction = state.update({ changes: [...changes, { from, to, insert }], annotations: pickedCompletion.of(selected), userEvent: 'input.complete' });
      const anchor = transaction.changes.mapPos(from, -1) + insert.length;
      view.dispatch({ changes: transaction.changes, selection: { anchor }, annotations: pickedCompletion.of(selected), userEvent: 'input.complete' });
    }
  };
  return completion;
}

export async function nativeCompletions(context: CompletionContext, path: string, options: NativeEditorOptions): Promise<CompletionResult | null> {
  const word = context.matchBefore(/[A-Za-z_]\w*$/);
  const previous = context.state.sliceDoc(Math.max(0, context.pos - 2), context.pos);
  if (!word && !context.explicit && !/[.:>]$/.test(previous)) {
    return null;
  }
  const from = word?.from ?? context.pos;
  const local: Completion[] = (/\.rs$/i.test(path) ? rustWords : cppWords).split(' ').map((label) => ({ label, type: 'keyword' }));
  const document = request(path, context.state, context.pos, options.documents);
  try {
    const api = options.api();
    const items = api ? await api.completion(document) : [];
    if (context.aborted || !sameDocuments(options.documents(), document.documents!)) {
      return null;
    }
    const merged = new Map(local.map((item) => [item.label, item]));
    for (const item of items) {
      merged.set(item.label, nativeServerCompletion(item, context.state));
    }
    return { from, options: [...merged.values()], validFor: /^\w*$/ };
  } catch (error) {
    if (!context.aborted) {
      options.onStatus(`Language tools · ${error instanceof Error ? error.message : 'Unavailable'}`);
    }
    return context.aborted ? null : { from, options: local, validFor: /^\w*$/ };
  }
}

export function nativeIntelligence(path: string, options: NativeEditorOptions): Extension {
  const language = /\.rs$/i.test(path) ? 'Rust' : /\.c$/i.test(path) ? 'C' : 'C++';
  let live = false;
  let generation = 0;
  const report = (error: unknown) => options.onStatus(`${language} · ${error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') : 'Language tools unavailable'}`);
  return [
    autocompletion({ activateOnTypingDelay: 250, override: [(context) => {
      const revision = generation;
      return nativeCompletions(context, path, { ...options, onStatus(message) {
        if (live && generation === revision) { options.onStatus(message); }
      } }).then((result) => live && generation === revision ? result : null);
    }] }),
    lintGutter(),
    keymap.of([...lintKeymap, { key: 'F12', preventDefault: true, run(view) {
      const api = options.api();
      if (!api) { return false; }
      const state = view.state;
      const revision = generation;
      const document = request(path, state, state.selection.main.head, options.documents);
      void api.definition(document).then((locations) => {
        if (!live || revision !== generation || view.state !== state || !sameDocuments(options.documents(), document.documents!)) { return; }
        const location = locations.find((item) => item.path !== undefined);
        if (location?.path !== undefined) { options.reveal(location.path, location.range.start.line + 1); }
        else { options.onStatus(`${language} · No definition found in this project`); }
      }).catch((error) => { if (live && revision === generation) { report(error); } });
      return true;
    } }]),
    hoverTooltip(async (view, offset) => {
      const api = options.api();
      const state = view.state;
      const revision = generation;
      if (!api || /comment|string/i.test(syntaxTree(state).resolveInner(offset, -1).name)) { return null; }
      const document = request(path, state, offset, options.documents);
      try {
        const hover = await api.hover(document);
        if (!hover || !live || revision !== generation || view.state !== state || !sameDocuments(options.documents(), document.documents!)) { return null; }
        const text = nyHoverText(hover);
        if (!text) { return null; }
        const start = hover.range ? nyOffset(state, hover.range.start) : null;
        const end = hover.range ? nyOffset(state, hover.range.end) : null;
        return { pos: start ?? offset, ...(end === null ? {} : { end }), above: true, create() {
          const dom = window.document.createElement('div'); dom.className = 'cm-native-hover'; dom.textContent = text; return { dom };
        } };
      } catch { return null; }
    }, { hoverTime: 350 }),
    EditorView.theme({ '.cm-native-hover': { padding: '8px 10px', maxWidth: 'min(520px, 75vw)', maxHeight: '280px', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '12px' } }),
    ViewPlugin.define((view) => {
      live = true;
      const revision = ++generation;
      options.onStatus(`${language} · Connecting language tools…`);
      let analysisRevision = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      const analyze = () => {
        clearTimeout(timer); clearTimeout(retry);
        const run = ++analysisRevision;
        timer = setTimeout(() => {
          const api = options.api();
          if (!api) { options.onStatus(`${language} · Language tools unavailable`); return; }
          const document = request(path, view.state, view.state.selection.main.head, options.documents);
          const current = () => live && generation === revision && run === analysisRevision && view.state.doc.toString() === document.text && sameDocuments(options.documents(), document.documents!);
          void api.diagnostics(document).then((items) => {
            if (!current()) { return; }
            view.dispatch(setDiagnostics(view.state, nyEditorDiagnostics(view.state, items, path)));
            window.dispatchEvent(new CustomEvent('antimatter:native-diagnostics', { detail: { path, text: document.text, diagnostics: items, documents: document.documents } }));
            options.onStatus(`${language} · Completion, hover, F12 definition`);
          }).catch((error) => { if (current()) { report(error); } }).finally(() => {
            // Push diagnostics may arrive after indexing; poll the cache while this view is live.
            if (current()) { retry = setTimeout(analyze, 3000); }
          });
        }, 500);
      };
      analyze();
      const restart = () => { void options.api()?.restart().then(() => { if (live && revision === generation) { analyze(); } }).catch((error) => { if (live && revision === generation) { report(error); } }); };
      window.addEventListener('antimatter:native-language-restart', restart);
      return {
        update(update) { if (update.docChanged) { analyze(); queueMicrotask(() => { if (live && revision === generation && view.state.doc === update.state.doc) { view.dispatch(setDiagnostics(view.state, [])); } }); } },
        destroy() { live = false; generation++; analysisRevision++; clearTimeout(timer); clearTimeout(retry); window.removeEventListener('antimatter:native-language-restart', restart); },
      };
    }),
  ];
}
