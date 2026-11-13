import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../api/types';
import type { ContextSnapshot } from './memory/context';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from './privateState';

/**
 * The renderer stores the messages people can see, while the model also needs the hidden tool
 * calls and tool results from earlier turns.  Those two representations deliberately have
 * different message ids, so continuity is tracked with explicit visible aliases rather than by
 * pretending the renderer knows about the internal transcript.
 */
interface StoredTranscript {
  messages: Message[];
  visibleIds: Set<string>;
  /** Visible assistant text already represented by the expanded history at the last checkpoint. */
  visibleContent: Map<string, string>;
  /** The instructions and notes the conversation started with; see memory/context.ts. */
  context?: ContextSnapshot;
}

const transcripts = new Map<string, StoredTranscript>();
const MAX_TRANSCRIPTS = 8;
const VERSION = 1;
let root = join(homedir(), '.antimatter', 'transcripts');

interface SerializedTranscript {
  version: typeof VERSION;
  threadId: string;
  messages: Message[];
  visibleIds: string[];
  visibleContent?: Array<[string, string]>;
  context?: ContextSnapshot;
  updatedAt: string;
}

const filename = (threadId: string): string =>
  join(root, `${createHash('sha256').update(threadId).digest('hex')}.json`);

/** Shape only: a snapshot that fails this is dropped, and the next turn builds a new one. */
const isContextSnapshot = (value: unknown): value is ContextSnapshot => {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ContextSnapshot>;
  return (
    typeof snapshot.key === 'string' &&
    (snapshot.text === null || typeof snapshot.text === 'string') &&
    !!snapshot.summary &&
    typeof snapshot.summary === 'object'
  );
};

const isMessage = (value: unknown): value is Message => {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<Message>;
  return (
    typeof message.id === 'string' &&
    typeof message.content === 'string' &&
    (message.role === 'system' ||
      message.role === 'user' ||
      message.role === 'assistant' ||
      message.role === 'tool')
  );
};

function cache(threadId: string, transcript: StoredTranscript): void {
  transcripts.delete(threadId);
  transcripts.set(threadId, transcript);

  while (transcripts.size > MAX_TRANSCRIPTS) {
    const oldest = transcripts.keys().next().value;
    if (oldest === undefined) break;
    transcripts.delete(oldest);
  }
}

function load(threadId: string): StoredTranscript | null {
  const path = filename(threadId);
  if (!existsSync(path)) return null;

  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    migratePrivateFile(path);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SerializedTranscript>;
    if (
      parsed.version !== VERSION ||
      parsed.threadId !== threadId ||
      !Array.isArray(parsed.messages) ||
      !parsed.messages.every(isMessage) ||
      !Array.isArray(parsed.visibleIds) ||
      !parsed.visibleIds.every((id) => typeof id === 'string') ||
      (parsed.visibleContent !== undefined &&
        (!Array.isArray(parsed.visibleContent) ||
          !parsed.visibleContent.every(
            (entry) => Array.isArray(entry) && entry.length === 2 && entry.every((value) => typeof value === 'string')
          )))
    ) {
      return null;
    }
    return {
      messages: parsed.messages,
      visibleIds: new Set(parsed.visibleIds),
      visibleContent: new Map(parsed.visibleContent ?? []),
      ...(isContextSnapshot(parsed.context) ? { context: parsed.context } : {}),
    };
  } catch (error) {
    console.warn(`[transcripts] could not restore ${threadId}:`, error);
    return null;
  }
}

/** Select a private transcript store. Changing it also drops the in-memory LRU. */
export function useRoot(path: string): void {
  root = path;
  transcripts.clear();
}

export const location = (): string => root;

/** Tighten transcript state created by older builds without making startup depend on it. */
export function migratePermissions(): void {
  if (!migratePrivateDirectory(root)) return;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) migratePrivateFile(join(root, entry.name));
    }
  } catch (error) {
    console.warn(`[transcripts] could not inspect ${root}:`, error);
  }
}

export function remember(
  threadId: string,
  messages: Message[],
  visibleIds: Iterable<string>,
  visibleContent: Iterable<readonly [string, string]> = [],
  context?: ContextSnapshot
): void {
  const stored: StoredTranscript = {
    messages: [...messages],
    visibleIds: new Set(visibleIds),
    visibleContent: new Map(visibleContent),
    ...(context ? { context } : {}),
  };
  cache(threadId, stored);
  try {
    const durable: SerializedTranscript = {
      version: VERSION,
      threadId,
      messages: stored.messages,
      visibleIds: [...stored.visibleIds],
      visibleContent: [...stored.visibleContent],
      ...(stored.context ? { context: stored.context } : {}),
      updatedAt: new Date().toISOString(),
    };
    writePrivateFileAtomic(filename(threadId), `${JSON.stringify(durable, null, 2)}\n`);
  } catch (error) {
    // Persistence improves continuity but must never turn a successful model turn into a failure.
    console.error(`[transcripts] could not persist ${threadId}:`, error);
  }
}

/** Remove hidden tool history when its visible conversation is explicitly removed or trimmed. */
export function remove(threadId: string): void {
  transcripts.delete(threadId);
  const path = filename(threadId);
  try {
    if (!existsSync(path)) return;
    const stats = lstatSync(path);
    // A malicious replacement must not turn cleanup into recursive deletion. Removing a file or
    // symlink is safe; an unexpected directory is left for a person to inspect.
    if (stats.isFile() || stats.isSymbolicLink()) rmSync(path, { force: true });
  } catch (error) {
    console.warn(`[transcripts] could not remove ${threadId}:`, error);
  }
}

/** Remove a family of opaque run ids, used when a Snitch item or project is deleted. */
export function removePrefix(prefix: string): void {
  for (const threadId of [...transcripts.keys()]) {
    if (threadId.startsWith(prefix)) transcripts.delete(threadId);
  }
  if (!existsSync(root)) return;

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const path = join(root, entry.name);
        const stats = lstatSync(path);
        if (!stats.isFile() || stats.isSymbolicLink()) continue;
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SerializedTranscript>;
        if (typeof parsed.threadId === 'string' && parsed.threadId.startsWith(prefix)) {
          rmSync(path, { force: true });
        }
      } catch (error) {
        console.warn(`[transcripts] could not inspect ${entry.name}:`, error);
      }
    }
  } catch (error) {
    console.warn(`[transcripts] could not remove prefix ${prefix}:`, error);
  }
}

/**
 * Resume only when every visible history row belongs to the transcript we cached for this
 * thread. The final incoming message is new and is appended to the expanded internal history.
 */
export function resume(threadId: string | undefined, incoming: Message[]): Message[] | null {
  if (!threadId || incoming.length < 2) return null;
  const kept = transcripts.get(threadId) ?? load(threadId);
  if (!kept?.messages.length) return null;
  cache(threadId, kept);

  const history = incoming.slice(0, -1);
  if (!history.every((message) => kept.visibleIds.has(message.id))) return null;

  const durableIds = new Set(kept.messages.map((message) => message.id));
  const recovered: Message[] = [];
  for (const message of history) {
    if (durableIds.has(message.id)) continue;
    const represented = kept.visibleContent.get(message.id);
    // Most aliases name a semantically equivalent hidden message. A content checkpoint marks the
    // one special case that is not interchangeable: the live renderer's accumulating answer.
    if (represented === undefined) continue;
    if (message.role !== 'assistant' || !message.content.startsWith(represented)) return null;
    const missing = message.content.slice(represented.length);
    if (missing) recovered.push({ ...message, content: missing });
  }

  return [...kept.messages, ...recovered, incoming[incoming.length - 1]];
}

/**
 * The standing context a thread's conversation started with, if it has one stored.
 *
 * Read whether or not its history resumes: a conversation someone edited no longer matches its
 * stored history, but it is the same conversation, and keeping its opening identical still lets a
 * local server reuse everything up to the edit.
 */
export function context(threadId: string | undefined): ContextSnapshot | null {
  if (!threadId) return null;
  const kept = transcripts.get(threadId) ?? load(threadId);
  if (!kept) return null;
  cache(threadId, kept);
  return kept.context ?? null;
}

export interface CompactionTranscriptSnapshot {
  fingerprint: string;
  messages: Message[];
}

function transcriptFingerprint(stored: StoredTranscript): string {
  return createHash('sha256').update(JSON.stringify({
    messages: stored.messages, visibleIds: [...stored.visibleIds], visibleContent: [...stored.visibleContent],
    context: stored.context,
  })).digest('hex');
}

/** Host-only snapshot; callers must recheck its identity before applying an asynchronous summary. */
export function snapshotForCompaction(threadId: string): CompactionTranscriptSnapshot | null {
  const stored = transcripts.get(threadId) ?? load(threadId);
  if (!stored?.messages.length) return null;
  return { fingerprint: transcriptFingerprint(stored), messages: structuredClone(stored.messages) };
}

/** Preserve visible aliases and standing context, and publish the new cache only after a durable write. */
export function commitCompaction(threadId: string, fingerprint: string, messages: Message[]): boolean {
  const previous = transcripts.get(threadId) ?? load(threadId);
  if (!previous || transcriptFingerprint(previous) !== fingerprint) return false;
  if (!messages.length || !messages.every(isMessage)) throw new Error('Invalid compacted transcript.');
  const stored: StoredTranscript = { ...previous, messages: structuredClone(messages) };
  const durable: SerializedTranscript = {
    version: VERSION, threadId, messages: stored.messages,
    visibleIds: [...stored.visibleIds], visibleContent: [...stored.visibleContent],
    ...(stored.context ? { context: stored.context } : {}), updatedAt: new Date().toISOString(),
  };
  writePrivateFileAtomic(filename(threadId), `${JSON.stringify(durable, null, 2)}\n`);
  cache(threadId, stored);
  return true;
}

/** Test and shutdown helper; runtime callers normally rely on the bounded LRU above. */
export function clear(): void {
  transcripts.clear();
}
