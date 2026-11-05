export interface CodeReviewSelection { path: string; startLine?: number; endLine?: number; workspace?: string }

export const CODE_REVIEW_SELECTION_EVENT = 'antimatter:code-review-selection';
let pending: CodeReviewSelection | null = null;

/** App reveals the existing panel; a hidden panel consumes the selection when it mounts. */
export function openCodeReviewSelection(selection: CodeReviewSelection): void {
  pending = { ...selection };
  window.dispatchEvent(new Event(CODE_REVIEW_SELECTION_EVENT));
}

export function consumeCodeReviewSelection(): CodeReviewSelection | null {
  const selection = pending;
  pending = null;
  return selection;
}
