import type { EditorView } from '@codemirror/view';

/**
 * A handle on the live editor, for the things that are not editing.
 *
 * The store owns the text, and everything that changes a document should go through it. What the
 * store cannot hold is the caret: where you are looking, what you have selected, where a pasted
 * function should land. That lives in the view, and the floating assistant needs it — "write it
 * here" and "explain this" are both questions about the selection.
 */

let view: EditorView | null = null;

export const registerEditor = (next: EditorView | null): void => {
  view = next;
};

/** Puts text in at the caret, replacing the selection if there is one. */
export function insertAtCursor(text: string): boolean {
  if (!view) return false;

  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

export interface Cursor {
  line: number;
  column: number;
  selection: string;
  /** The lines the selection spans, for saying "lines 12–18" rather than quoting it twice. */
  from: number;
  to: number;
}

export function cursor(): Cursor | null {
  if (!view) return null;

  const range = view.state.selection.main;
  const start = view.state.doc.lineAt(range.from);
  const end = view.state.doc.lineAt(range.to);

  return {
    line: start.number,
    column: range.from - start.from + 1,
    selection: range.empty ? '' : view.state.sliceDoc(range.from, range.to),
    from: start.number,
    to: end.number,
  };
}
