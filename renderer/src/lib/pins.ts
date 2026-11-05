import type { Draft, PinnedConversation, Thread } from '../types';
import type { ChatImportSource } from '../../../src/api/chatImports';

/**
 * Two things can be pinned, and they are different things.
 *
 * A conversation is pinned as a whole: the thread carries the moment it was pinned, it leaves
 * Recent, and it stays at the top of its project until someone unpins it. A message is pinned as
 * a bookmark into its conversation — a `PinnedConversation` entry, which is the older of the two
 * and keeps its name — and the conversation stays in Recent, because a bookmark is not a request
 * to move anything.
 */

export const isPinnedThread = (thread: Pick<Thread, 'pinnedAt'>): boolean => typeof thread.pinnedAt === 'number';

/** Returns the same array when nothing changes, so pinning twice is not a re-render and a save. */
export function pinThread(threads: Thread[], threadId: string, now: number): Thread[] {
  const target = threads.find((thread) => thread.id === threadId);
  if (!target || isPinnedThread(target)) return threads;
  return threads.map((thread) => (thread.id === threadId ? { ...thread, pinnedAt: now } : thread));
}

export function unpinThread(threads: Thread[], threadId: string): Thread[] {
  const target = threads.find((thread) => thread.id === threadId);
  if (!target || !isPinnedThread(target)) return threads;
  return threads.map((thread) => {
    if (thread.id !== threadId) return thread;
    const { pinnedAt: _pinnedAt, ...rest } = thread;
    return rest;
  });
}

export type PinnedRow =
  | { kind: 'conversation'; thread: Thread; at: number }
  | { kind: 'message'; thread: Thread; entry: PinnedConversation; at: number };

export interface SidebarLists {
  /** Pinned conversations and pinned messages together, most recently pinned first. */
  pinned: PinnedRow[];
  /** Native conversations that are not pinned as a whole, newest first. */
  recent: Thread[];
  /** Imported conversations have their own source group, never a second entry in Recent. */
  imported: Record<ChatImportSource, Thread[]>;
}

export type ImportedSidebarGroups = Record<ChatImportSource, boolean>;
export const IMPORTED_SIDEBAR_GROUPS_KEY = 'antimatter.sidebar.imported-groups';

/** Invalid/legacy origin metadata must not hide a conversation from every group. */
export function importedChatSource(thread: Pick<Thread, 'importedFrom'>): ChatImportSource | null {
  const source = thread.importedFrom?.source;
  return source === 'claude' || source === 'codex' || source === 'opencode' ? source : null;
}

export function loadImportedSidebarGroups(storage?: Pick<Storage, 'getItem'>): ImportedSidebarGroups {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    const saved: unknown = JSON.parse(target?.getItem(IMPORTED_SIDEBAR_GROUPS_KEY) ?? '{}');
    const value = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
    return { claude: value.claude === true, codex: value.codex === true, opencode: value.opencode === true };
  } catch {
    return { claude: false, codex: false, opencode: false };
  }
}

export function saveImportedSidebarGroups(value: ImportedSidebarGroups, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    target?.setItem(IMPORTED_SIDEBAR_GROUPS_KEY, JSON.stringify(value));
  } catch {
    // Restricted storage does not make the in-memory sidebar unusable.
  }
}

/** Search reveals matching rows temporarily, without writing over the user's collapsed state. */
export const importedSidebarGroupExpanded = (saved: boolean, query: string, matchingCount: number): boolean =>
  saved || (!!query.trim() && matchingCount > 0);

const lastContent = (thread: Thread) => thread.messages[thread.messages.length - 1]?.content ?? '';

/** What the sidebar lists for one project and one search, in the order it lists them. */
export function sidebarLists(
  threads: Thread[],
  pinnedMessages: PinnedConversation[],
  options: { projectId: string; query: string }
): SidebarLists {
  const query = options.query.trim().toLowerCase();
  const matches = (text: string) => !query || text.toLowerCase().includes(query);
  const inProject = threads.filter((thread) => thread.projectId === options.projectId);
  const byId = new Map(threads.map((thread) => [thread.id, thread]));

  const conversations: PinnedRow[] = inProject
    .filter((thread) => isPinnedThread(thread) && matches(`${thread.title} ${lastContent(thread)}`))
    .map((thread) => ({ kind: 'conversation', thread, at: thread.pinnedAt! }));

  const messages: PinnedRow[] = pinnedMessages.flatMap((entry) => {
    const thread = byId.get(entry.threadId);
    if (!thread || thread.projectId !== options.projectId || !matches(`${thread.title} ${entry.snippet}`)) return [];
    return [{ kind: 'message' as const, thread, entry, at: entry.createdAt }];
  });
  const unpinned = inProject
    .filter((thread) => !isPinnedThread(thread) && matches(`${thread.title} ${lastContent(thread)}`))
    .sort((a, b) => b.createdAt - a.createdAt);

  return {
    pinned: [...conversations, ...messages].sort((a, b) => b.at - a.at),
    recent: unpinned.filter((thread) => importedChatSource(thread) === null),
    imported: {
      claude: unpinned.filter((thread) => importedChatSource(thread) === 'claude'),
      codex: unpinned.filter((thread) => importedChatSource(thread) === 'codex'),
      opencode: unpinned.filter((thread) => importedChatSource(thread) === 'opencode'),
    },
  };
}

/**
 * What comes back from the last session. An empty thread is the one the app makes at startup and
 * not worth restoring — unless someone typed into it or pinned it, which are both a person saying
 * they mean to come back. A pinned message whose conversation did not come back is dropped rather
 * than kept pointing at nothing.
 */
export function restorable(
  threads: Thread[],
  drafts: Record<string, Draft>,
  pinnedMessages: PinnedConversation[]
): { threads: Thread[]; pinned: PinnedConversation[] } {
  const kept = threads.filter((thread) => thread.messages.length > 0 || !!drafts[thread.id]?.text || isPinnedThread(thread));
  const ids = new Set(kept.map((thread) => thread.id));
  return { threads: kept, pinned: pinnedMessages.filter((entry) => ids.has(entry.threadId)) };
}
