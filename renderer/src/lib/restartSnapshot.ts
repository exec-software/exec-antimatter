import type { Draft, PinnedConversation, Thread } from '../types';

export interface RestartConversationSnapshot {
  revision?: number;
  threads: Thread[];
  activeThreadId: string;
  pinned: PinnedConversation[];
  drafts: Record<string, Draft>;
}

/**
 * Overlay the composer's live controlled value onto App's debounced conversation snapshot.
 * The input is never mutated: an update save and React state can safely retain their own view.
 */
export function withLiveDraft(
  snapshot: RestartConversationSnapshot,
  threadId: string,
  draft: Draft | null
): RestartConversationSnapshot {
  if (!draft) return snapshot;
  const drafts = { ...snapshot.drafts };
  if (!draft.text && draft.attachments.length === 0) delete drafts[threadId];
  else drafts[threadId] = { ...draft };
  return { ...snapshot, drafts };
}

/** Restart preparation is rare; a whole-snapshot comparison is the clearest stability check. */
export const restartSnapshotFingerprint = (snapshot: RestartConversationSnapshot): string => JSON.stringify(snapshot);
