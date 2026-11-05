import { useEffect, useRef, useState } from 'react';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  keymap,
  type DecorationSet,
} from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { actions, analysisDocuments, breakpointsIn, pausedAt, useEnvironment, type OpenFile } from './store';
import { editorAppearanceFor, languageFor } from './highlight';
import { registerEditor } from './editorBridge';
import { getAppearance, subscribeAppearance } from '../appearance';
import { nyIntelligence } from './nyIntelligence';

/**
 * The editor.
 *
 * One CodeMirror view for the whole pane, with a saved EditorState per open file. Building a new
 * view per tab would be simpler and would throw away the cursor, the selection, the scroll
 * position and the undo history every time you glance at another file — which is most of what
 * makes tabs worth having.
 */

/** Breakpoints and the paused line arrive from outside the editor, so they come in as effects. */
const setBreakpointLines = StateEffect.define<number[]>();
const setVerifiedBreakpointLines = StateEffect.define<number[] | null>();
const setPausedLine = StateEffect.define<number | null>();
const setRevealedLine = StateEffect.define<number | null>();

const breakpointLines = StateField.define<number[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setBreakpointLines)) return effect.value;
    return value;
  },
});
const verifiedBreakpointLines = StateField.define<number[] | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setVerifiedBreakpointLines)) return effect.value;
    return value;
  },
});

class DotMarker extends GutterMarker {
  constructor(private readonly className: string, private readonly glyph: string, private readonly label?: string) {
    super();
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = this.className;
    span.textContent = this.glyph;
    if (this.label) { span.title = this.label; span.setAttribute('aria-label', this.label); }
    return span;
  }
}

const BREAKPOINT = new DotMarker('cm-breakpoint-dot', '●', 'Breakpoint');
const PENDING_BREAKPOINT = new DotMarker('cm-breakpoint-dot', '○', 'Breakpoint pending or not executable');
const SPACER = new DotMarker('cm-breakpoint-hover', '●');

/** The column left of the line numbers: click it to set or clear a breakpoint. */
const breakpointGutter = (toggle: (line: number) => void): Extension => [
  breakpointLines,
  verifiedBreakpointLines,
  gutter({
    class: 'cm-breakpoint-gutter',
    // An element per line, so the whole column is a target and hovering it says so.
    renderEmptyElements: true,
    lineMarker: (view, line) => {
      const number = view.state.doc.lineAt(line.from).number;
      const requested = view.state.field(breakpointLines).includes(number);
      const verified = view.state.field(verifiedBreakpointLines);
      if (verified?.includes(number)) return BREAKPOINT;
      return requested ? (verified === null ? BREAKPOINT : PENDING_BREAKPOINT) : null;
    },
    initialSpacer: () => SPACER,
    lineMarkerChange: (update) =>
      update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setBreakpointLines) || effect.is(setVerifiedBreakpointLines))
      ),
    domEventHandlers: {
      mousedown: (view, line) => {
        toggle(view.state.doc.lineAt(line.from).number);
        return true;
      },
    },
  }),
];

/** Highlights where execution is stopped, and briefly flashes a line something else jumped to. */
const markedLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let paused: number | null | undefined;
    let revealed: number | null | undefined;

    for (const effect of transaction.effects) {
      if (effect.is(setPausedLine)) paused = effect.value;
      if (effect.is(setRevealedLine)) revealed = effect.value;
    }
    if (paused === undefined && revealed === undefined) return value.map(transaction.changes);

    const decorations = [];
    const lineAt = (line: number) =>
      line >= 1 && line <= transaction.state.doc.lines ? transaction.state.doc.line(line) : null;

    const pausedLine = paused === undefined ? null : paused;
    if (pausedLine) {
      const line = lineAt(pausedLine);
      if (line) decorations.push(Decoration.line({ class: 'cm-paused-line' }).range(line.from));
    }
    const revealedLine = revealed === undefined ? null : revealed;
    if (revealedLine && revealedLine !== pausedLine) {
      const line = lineAt(revealedLine);
      if (line) decorations.push(Decoration.line({ class: 'cm-revealed-line' }).range(line.from));
    }
    return Decoration.set(decorations, true);
  },
  provide: (field) => EditorView.decorations.from(field),
});

interface Props {
  file: OpenFile;
}

export function CodeEditor({ file }: Props) {
  const state = useEnvironment();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** Per-file editor state, so switching tabs keeps the cursor and the undo history. */
  const states = useRef(new Map<string, EditorState>());
  const appearance = useRef(new Compartment());
  const editing = useRef(new Compartment());
  const [nyStatus, setNyStatus] = useState('NIL · Local snippets');
  /** The listener lives as long as the view, so it reads the current path rather than closing over one. */
  const activePath = useRef(file.path);
  activePath.current = file.path;

  // Build the view once. Everything else reconfigures or dispatches into it.
  useEffect(() => {
    if (!host.current || view.current) return;

    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: '' }),
    });
    view.current = editor;
    // The floating assistant needs the caret, which only the view has.
    registerEditor(editor);
    const stopAppearance = subscribeAppearance((settings) => {
      const extension = editorAppearanceFor(settings);
      for (const [path, saved] of states.current) {
        states.current.set(path, saved.update({ effects: appearance.current.reconfigure(extension) }).state);
      }
      if (appearance.current.get(editor.state)) {
        editor.dispatch({ effects: appearance.current.reconfigure(extension) });
      }
    });

    return () => {
      stopAppearance();
      registerEditor(null);
      editor.destroy();
      view.current = null;
      states.current.clear();
    };
  }, []);

  const makeState = (content: OpenFile): EditorState => {
    const language = languageFor(content.path);
    return EditorState.create({
      doc: content.text,
      extensions: [
        breakpointGutter((line) => actions.toggleBreakpoint(activePath.current, line)),
        markedLines,
        basicSetup,
        appearance.current.of(editorAppearanceFor(getAppearance())),
        ...(language ? [language] : []),
        ...(/\.(?:ny|matrix|mat)$/i.test(content.path) ? [nyIntelligence(content.path, {
          api: () => window.electronAPI.ny,
          documents: analysisDocuments,
          reveal: (path, line) => { void actions.reveal(path, line); },
          onStatus: setNyStatus,
        })] : []),
        keymap.of([
          indentWithTab,
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              void actions.save(activePath.current);
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) actions.edit(activePath.current, update.state.doc.toString());
        }),
        editing.current.of(EditorState.readOnly.of(content.binary || state.busy || state.workspaceSwitching)),
      ],
    });
  };

  // Swap documents when the tab changes, keeping the outgoing one's state.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;

    const existing = states.current.get(file.path);
    if (existing) {
      editor.setState(existing.update({ effects: appearance.current.reconfigure(editorAppearanceFor(getAppearance())) }).state);
    } else {
      editor.setState(makeState(file));
    }
    editor.focus();

    return () => {
      if (view.current) states.current.set(file.path, view.current.state);
    };
  }, [file.path]);

  useEffect(() => {
    view.current?.dispatch({ effects: editing.current.reconfigure(EditorState.readOnly.of(file.binary || state.busy || state.workspaceSwitching)) });
  }, [file.path, file.binary, state.busy, state.workspaceSwitching]);

  /**
   * The store is the truth for the text, so an edit made elsewhere — the assistant inserting a
   * function, a revert — has to reach the document. Edits typed here are already in it.
   */
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === file.text) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: file.text },
    });
  }, [file.path, file.text]);

  // Breakpoints for this file.
  useEffect(() => {
    const verifyNy = /\.(?:ny|matrix|mat|nil)$/i.test(file.path) && state.debug.phase !== 'stopped';
    view.current?.dispatch({ effects: [
      setBreakpointLines.of(breakpointsIn(file.path)),
      setVerifiedBreakpointLines.of(verifyNy ? state.debug.resolved.filter((breakpoint) => breakpoint.file === file.path).map((breakpoint) => breakpoint.line) : null),
    ] });
  }, [state.breakpoints, state.debug, file.path]);

  // Where execution is stopped, and scrolling there.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;

    const line = pausedAt(file.path);
    editor.dispatch({ effects: setPausedLine.of(line) });
    if (line && line <= editor.state.doc.lines) {
      editor.dispatch({ effects: EditorView.scrollIntoView(editor.state.doc.line(line).from, { y: 'center' }) });
    }
  }, [state.debug, file.path]);

  // Somebody else asked for a line: scroll to it, flash it, then let it be.
  useEffect(() => {
    const editor = view.current;
    const reveal = state.reveal;
    if (!editor || !reveal || reveal.path !== file.path) return;
    if (reveal.line < 1 || reveal.line > editor.state.doc.lines) return;

    const line = editor.state.doc.line(reveal.line);
    editor.dispatch({
      effects: [setRevealedLine.of(reveal.line), EditorView.scrollIntoView(line.from, { y: 'center' })],
      selection: { anchor: line.from },
    });
    const timer = window.setTimeout(() => {
      view.current?.dispatch({ effects: setRevealedLine.of(null) });
      actions.clearReveal();
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [state.reveal, file.path]);

  if (file.binary) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-ink-3">
        <div>
          <p className="text-ink-2">{file.path}</p>
          <p className="mt-1">This file is not text, so there is nothing to edit here.</p>
        </div>
      </div>
    );
  }

  return <div className="flex h-full min-h-0 flex-col overflow-hidden">
    <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
    {/\.(?:ny|matrix|mat)$/i.test(file.path) && <div className="shrink-0 truncate border-t border-line bg-surface-2 px-3 py-1 text-[10px] text-ink-3" title={`${nyStatus} · Ctrl+Space completion · F12 definition · Ctrl+Shift+M diagnostics`} role="status">{nyStatus}</div>}
  </div>;
}
