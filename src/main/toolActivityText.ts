import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateDirectory, writePrivateFileAtomic } from './privateState';

/**
 * Where a tool call's arguments and result live on disk, which is not with the conversation.
 *
 * A conversation's assistant messages carry a record of every tool call the turn made, and those
 * records held the full text of what was sent and what came back — a `write_file` call kept the
 * entire file it wrote. Measured on one real store: 17.78 MB of an 18.9 MiB
 * `conversations.json`, 94% of it, across 7,089 entries on 188 messages. The store is rewritten
 * while a turn streams, so that text was serialised, compared and fsynced every few seconds for
 * the length of every turn, and the file only ever grows, because nothing prunes it.
 *
 * None of it is needed to show a conversation. The interface shows this text only inside a
 * collapsed box on one expanded tool card, so it is read rarely and almost never in bulk. Here it
 * is one small file per thread, written when it changes and read when the thread is loaded, while
 * `conversations.json` keeps the anchors — which tool, when, what status, which offset into the
 * prose — and drops from 18.9 MiB to about 4.3.
 *
 * Capping the text instead was measured and rejected: only 1.6% of these fields are over 4 KB, so
 * the bulk is the sheer number of them. A 4 KB cap took the same store to 17.7 MiB and would have
 * truncated a third of the cards for nothing.
 */

/** What a tool card shows when it is expanded, and the only part kept out of the conversation. */
export interface ToolText {
  args?: string;
  result?: string;
}

/** One thread's text, by the activity id the conversation's tool record carries. */
export type ThreadToolText = Record<string, ToolText>;

interface SidecarFile {
  version: 1;
  entries: ThreadToolText;
}

/** The minimum of a conversation this module needs to know, so it never imports the store. */
interface ToolRecordLike {
  activityId?: string;
  args?: string;
  result?: string;
}
interface MessageLike {
  id: string;
  meta?: { tools?: ToolRecordLike[] };
}
interface ThreadLike {
  id: string;
  messages: MessageLike[];
}

let root = join(homedir(), '.antimatter', 'tool-activity');

/** Electron owns the real userData path; tests point this at a temporary directory. */
export const useRoot = (path: string): void => {
  root = path;
};

export const location = (): string => root;

const fileFor = (threadId: string): string => join(root, `${encodeURIComponent(threadId)}.json`);

/** One thread's stored text, or nothing. A missing or unreadable sidecar is never fatal. */
export function read(threadId: string): ThreadToolText {
  const path = fileFor(threadId);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const entries = (parsed as SidecarFile).entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return {};
    const out: ThreadToolText = {};
    for (const [key, value] of Object.entries(entries)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const text: ToolText = {};
      const { args, result } = value as ToolText;
      if (typeof args === 'string') text.args = args;
      if (typeof result === 'string') text.result = result;
      if (text.args !== undefined || text.result !== undefined) out[key] = text;
    }
    return out;
  } catch {
    // A sidecar that cannot be read costs the expanded view of some old tool cards. The carbon
    // still holds the full record, and losing the conversation over it would be the worse trade.
    return {};
  }
}

export function write(threadId: string, entries: ThreadToolText): void {
  if (!Object.keys(entries).length) {
    remove(threadId);
    return;
  }
  ensurePrivateDirectory(root);
  const file: SidecarFile = { version: 1, entries };
  writePrivateFileAtomic(fileFor(threadId), `${JSON.stringify(file)}\n`);
}

export function remove(threadId: string): void {
  rmSync(fileFor(threadId), { force: true });
}

/** Drop the sidecars of threads that no longer exist, so a deleted chat takes its text with it. */
export function keepOnly(threadIds: Iterable<string>): void {
  if (!existsSync(root)) return;
  const keep = new Set<string>();
  for (const id of threadIds) keep.add(`${encodeURIComponent(id)}.json`);
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.json') || keep.has(name)) continue;
    rmSync(join(root, name), { force: true });
  }
}

/**
 * Separate a thread from its tool text.
 *
 * Returns the thread as it should be stored and the text that belongs beside it. Entries without
 * an activity id keep their text inline: there is nothing stable to file it under, and a handful
 * of orphans in the conversation is better than text that cannot be found again.
 */
export function split<T extends ThreadLike>(thread: T): { thread: T; entries: ThreadToolText } {
  const entries: ThreadToolText = {};
  let changed = false;
  const messages = thread.messages.map((message) => {
    const tools = message.meta?.tools;
    if (!tools?.length) return message;
    let touched = false;
    const stripped = tools.map((tool) => {
      if (!tool.activityId || (tool.args === undefined && tool.result === undefined)) return tool;
      const text: ToolText = {};
      if (tool.args !== undefined) text.args = tool.args;
      if (tool.result !== undefined) text.result = tool.result;
      entries[tool.activityId] = text;
      touched = true;
      const { args: _args, result: _result, ...rest } = tool;
      return rest as ToolRecordLike;
    });
    if (!touched) return message;
    changed = true;
    return { ...message, meta: { ...message.meta, tools: stripped } };
  });
  // The cast is contained here rather than at every call site: each message keeps its own shape
  // and only `meta.tools` entries lose two optional string properties.
  return { thread: changed ? ({ ...thread, messages } as T) : thread, entries };
}

/** Put a thread's tool text back, for the conversation the interface is given. */
export function merge<T extends ThreadLike>(thread: T, entries: ThreadToolText): T {
  if (!Object.keys(entries).length) return thread;
  let changed = false;
  const messages = thread.messages.map((message) => {
    const tools = message.meta?.tools;
    if (!tools?.length) return message;
    let touched = false;
    const restored = tools.map((tool) => {
      const text = tool.activityId ? entries[tool.activityId] : undefined;
      if (!text) return tool;
      touched = true;
      return {
        ...tool,
        ...(text.args !== undefined ? { args: text.args } : {}),
        ...(text.result !== undefined ? { result: text.result } : {}),
      };
    });
    if (!touched) return message;
    changed = true;
    return { ...message, meta: { ...message.meta, tools: restored } };
  });
  return changed ? ({ ...thread, messages } as T) : thread;
}
