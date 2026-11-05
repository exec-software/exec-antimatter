import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { constants } from 'node:fs';

import type { BotChatStore } from './botChat';

/**
 * A way in for agents that do not run inside Antimatter.
 *
 * The reason this exists: a model working in another harness had no way to
 * reach the public channel, so a person sat between them copying text, and the
 * copies went wrong — a truncated paste, an identifier with no message
 * attached. The fix is a door the outside can push things through.
 *
 * It is a watched directory rather than a socket because the store is owned by
 * one process: `BotChatStore` loads once and keeps its state in memory, so a
 * second writer editing the JSON would simply be overwritten on the next save,
 * silently. A dropped file does not touch the store at all. It also survives
 * Antimatter being closed — the message is waiting at the next start — and it
 * needs no port, no listener and no credential.
 *
 * WHAT A DROPPED FILE CANNOT DO
 *
 * It cannot choose its sender kind. Everything arriving here posts as
 * `external`, so nothing can present itself as the person at the keyboard or
 * as a local agent with a thread to open. It cannot reach a channel that is
 * archived or paused, exceed the body limit, or mention more participants than
 * any other poster may: it goes through `postExternal`, which is the same path
 * every other message takes, because a second way in is a second thing to get
 * wrong.
 *
 * The name a file gives is self-declared and carries no authority. Anything
 * able to write to this directory can claim any name, which is the same trust
 * as being able to write the store itself. It is there to tell two outside
 * agents apart, not to establish who either of them is.
 */

/** A dropped file larger than this is refused unread. */
const MAX_FILE_BYTES = 64 * 1024;
/** How many files one sweep will take, so a flood cannot hold the loop. */
const MAX_PER_SWEEP = 32;
/** Rejected files kept for inspection before the oldest are discarded. */
const MAX_REJECTED = 64;

export interface InboxDependencies {
  /** Resolve a channel name to its id, or null when there is no such channel. */
  channelId(name: string): string | null;
  post(channelId: string, body: string, name: string, clientMessageId: string, replyTo?: string): void;
  now(): number;
  warn(message: string): void;
}

interface Dropped {
  channel: string;
  author: string;
  body: string;
  replyTo?: string;
  clientMessageId?: string;
}

/** Only a plain name, so nothing can steer the read out of this directory. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Parse without inheriting anything. A dropped file is untrusted input, and
 * `__proto__` in a JSON object is the oldest way to turn parsing into an
 * effect; the reviver drops those keys before any of it is reachable.
 */
const parse = (text: string): unknown =>
  JSON.parse(text, (key, value) =>
    key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value);

const field = (source: Record<string, unknown>, key: string, limit: number, required: boolean): string | undefined => {
  const value = source[key];
  if (value === undefined || value === null) {
    if (required) throw new Error(`'${key}' is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Error(`'${key}' must be text`);
  if (value.length > limit) throw new Error(`'${key}' is longer than ${limit} characters`);
  return value;
};

export class BotChatInbox {
  private readonly rejected: string;

  constructor(private readonly directory: string, private readonly dependencies: InboxDependencies) {
    this.rejected = join(directory, 'rejected');
  }

  /** Create the directory so there is somewhere to drop a file before one is dropped. */
  prepare(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    mkdirSync(this.rejected, { recursive: true, mode: 0o700 });
  }

  /**
   * Take what is waiting. Returns how many messages were posted.
   *
   * A file that cannot be used is moved aside rather than deleted. Discarding
   * it silently would be the same failure this whole mechanism exists to
   * avoid: somebody's message disappearing with nothing to show for it.
   */
  sweep(): number {
    if (!existsSync(this.directory)) return 0;
    let posted = 0;
    const names = readdirSync(this.directory).filter((name) => NAME.test(name)).sort().slice(0, MAX_PER_SWEEP);
    for (const name of names) {
      const path = join(this.directory, name);
      try {
        posted += this.ingest(path, name) ? 1 : 0;
      } catch (error) {
        this.reject(path, name, error instanceof Error ? error.message : String(error));
      }
    }
    return posted;
  }

  private ingest(path: string, name: string): boolean {
    // lstat, not stat: a symlink here must be refused rather than followed,
    // and O_NOFOLLOW closes the window between the check and the open.
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('not a regular file');
    if (stats.size === 0) throw new Error('empty');
    if (stats.size > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES} bytes`);

    const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      text = readFileSync(handle, 'utf8');
    } finally {
      closeSync(handle);
    }

    const parsed = parse(text);
    if (!isPlainObject(parsed)) throw new Error('not a JSON object');
    const dropped: Dropped = {
      channel: field(parsed, 'channel', 64, true)!,
      author: field(parsed, 'author', 64, true)!,
      body: field(parsed, 'body', MAX_FILE_BYTES, true)!,
      replyTo: field(parsed, 'replyTo', 64, false),
      clientMessageId: field(parsed, 'clientMessageId', 64, false),
    };

    const channelId = this.dependencies.channelId(dropped.channel);
    if (!channelId) throw new Error(`no channel named '${dropped.channel}'`);

    // The store rejects a duplicate occurrence, so a file redelivered after a
    // crash posts once rather than twice.
    const occurrence = dropped.clientMessageId ?? `inbox-${name}-${stats.mtimeMs}`;
    this.dependencies.post(channelId, dropped.body, dropped.author, occurrence, dropped.replyTo);
    unlinkSync(path);
    return true;
  }

  private reject(path: string, name: string, reason: string): void {
    this.dependencies.warn(`bot chat inbox refused ${name}: ${reason}`);
    try {
      renameSync(path, join(this.rejected, `${this.dependencies.now()}-${name}`));
      const kept = readdirSync(this.rejected).sort();
      for (const old of kept.slice(0, Math.max(0, kept.length - MAX_REJECTED)))
        unlinkSync(join(this.rejected, old));
    } catch {
      // A file that cannot even be moved aside is dropped, having already been
      // reported. Leaving it would make every later sweep fail on it.
      try { unlinkSync(path); } catch { /* nothing further to try */ }
    }
  }
}
