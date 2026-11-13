import type { SecurityReview } from '../../../src/api/security';

export interface SecurityReviewDraft { version: 1; base: SecurityReview; value: SecurityReview }
interface DraftState { draft: SecurityReviewDraft | null; error: string; unreadable?: boolean }
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const prefix = 'antimatter.security-review.';
export const securityReviewDraftKey = (workspace: string, report: string, finding: string) => JSON.stringify([workspace, report, finding]);
export const sameSecurityReview = (left: SecurityReview, right: SecurityReview) => left.status === right.status && left.note === right.note;
const validReview = (value: unknown): value is SecurityReview => {
  if (!value || typeof value !== 'object') return false;
  const review = value as SecurityReview;
  return ['open', 'dismissed', 'resolved'].includes(review.status) && typeof review.note === 'string' && review.note.length <= 1000;
};
const validDraft = (value: unknown): value is SecurityReviewDraft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as SecurityReviewDraft;
  return draft.version === 1 && validReview(draft.base) && validReview(draft.value);
};

/** Session recovery survives unavailable browser storage; failures stay visible after remount. */
export function createSecurityReviewDraftStore(storage: () => DraftStorage) {
  const session = new Map<string, DraftState>();
  const read = (key: string): DraftState => {
    const cached = session.get(key); if (cached) return cached;
    try {
      const text = storage().getItem(prefix + key);
      if (text === null) return { draft: null, error: '' };
      if (text.length > 16_384) throw new Error('Invalid draft');
      const draft: unknown = JSON.parse(text);
      if (!validDraft(draft)) throw new Error('Invalid draft');
      const state = { draft, error: '' }; session.set(key, state); return state;
    } catch {
      return { draft: null, unreadable: true, error: 'The saved review draft could not be read. It has not been removed. Retry recovery before editing, or explicitly discard it.' };
    }
  };
  const write = (key: string, draft: SecurityReviewDraft | null): DraftState => {
    let error = '';
    try {
      if (draft) storage().setItem(prefix + key, JSON.stringify(draft)); else storage().removeItem(prefix + key);
    } catch {
      error = draft ? 'This draft is kept for this session, but could not be saved for restart recovery. Retry storage before closing Antimatter.'
        : 'The stored draft could not be cleared. It may reappear after restarting Antimatter. Retry storage before closing.';
    }
    const state = { draft, error }; session.set(key, state); return state;
  };
  const clear = (key: string, expected: SecurityReviewDraft) => {
    const current = read(key);
    // A completed request must not erase edits made after the user left and reopened the form.
    if (JSON.stringify(current.draft) !== JSON.stringify(expected)) return { ...current, cleared: false };
    return { ...write(key, null), cleared: true };
  };
  const flush = (): string[] => {
    const errors: string[] = [];
    for (const [key, state] of session) if (state.error) {
      const retried = write(key, state.draft); if (retried.error) errors.push(retried.error);
    }
    return errors;
  };
  return { read, write, clear, flush };
}
export const securityReviewDrafts = createSecurityReviewDraftStore(() => localStorage);
export const flushSecurityReviewDrafts = (): string[] => securityReviewDrafts.flush();
