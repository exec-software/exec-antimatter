import type { Message, Thread } from '../types';

/**
 * Keeping the window's conversations and the main process's copy of them in step.
 *
 * The store is the authority and uses optimistic concurrency: every thread carries a revision,
 * and a write that names an older one is treated as a second writer working from stale state.
 * That is the right rule — a paired phone really can be writing at the same time — but it only
 * works if both sides move the number forward together.
 */

/**
 * Carry the store's revisions back into the threads that were just checkpointed.
 *
 * The store advances a thread's revision whenever it writes a change to it. A window that never
 * reads that number back keeps sending the revision it hydrated with, so its *second* checkpoint
 * looks exactly like a stale second writer: the store keeps its own copy, publishes a conflict,
 * and the conflict is applied by replacing the thread with the copy the store kept. Mid-turn
 * that discards every token streamed since the previous checkpoint, every few seconds, for the
 * length of the turn — the transcript whose prose has pieces missing and whose tool cards, still
 * anchored to offsets in text that no longer exists, pile up at the end of it.
 *
 * The host's frozen workspace also comes back, provided the user has not picked another folder
 * while this save was in flight. Streamed text stays exactly where it is.
 */
export function adoptThreadRevisions(
  current: Thread[],
  sent: readonly Thread[],
  stored: readonly Thread[]
): Thread[] {
  if (!sent.length || !stored.length) return current;
  const sentIds = new Set(sent.map((thread) => thread.id));
  const storedById = new Map(stored.map((thread) => [thread.id, thread]));
  let changed = false;
  const next = current.map((thread) => {
    if (!sentIds.has(thread.id)) return thread;
    const host = storedById.get(thread.id);
    const revision = host?.revision;
    if (typeof revision !== 'number' || !host) return thread;
    if (revision < (thread.revision ?? 0)) return thread;
    const sameDirectory = (thread.directory || null) === (host.directory || null);
    const binding = sameDirectory ? host.workspaceBinding : thread.workspaceBinding;
    if (revision === thread.revision && JSON.stringify(binding) === JSON.stringify(thread.workspaceBinding)) return thread;
    changed = true;
    return { ...thread, revision, workspaceBinding: binding };
  });
  return changed ? next : current;
}

/**
 * Fold the store's copy of a thread into the local one when a real conflict arrives.
 *
 * The store can only know the turn this window is streaming as far as the last checkpoint, so
 * for that one message the window is the better witness and its copy is kept. Everything else is
 * taken from the store, which is where another device's writes arrive, and anything the store
 * holds that this window has never seen is added at the end.
 */
export function mergeHostThread(local: Thread, host: Thread, liveMessageId: string | null): Thread {
  if (!liveMessageId || !local.messages.some((message) => message.id === liveMessageId)) return host;
  const hostById = new Map(host.messages.map((message) => [message.id, message]));
  const seen = new Set<string>();
  const messages: Message[] = local.messages.map((message) => {
    seen.add(message.id);
    return message.id === liveMessageId ? message : hostById.get(message.id) ?? message;
  });
  for (const message of host.messages) {
    if (!seen.has(message.id)) messages.push(message);
  }
  return { ...host, messages };
}
