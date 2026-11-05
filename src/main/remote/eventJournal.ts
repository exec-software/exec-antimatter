import { randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  canonicalJson,
  REMOTE_LIMITS,
  RemoteProtocolError,
  type EventCursor,
  type JsonValue,
} from './protocol';

export interface RemoteEventEnvelope {
  workspaceId: string;
  cursor: EventCursor;
  occurredAt: number;
  event: JsonValue;
}

interface JournalEntry {
  envelope: RemoteEventEnvelope;
  bytes: number;
}

export type CursorResetReason = 'missing_cursor' | 'epoch_changed' | 'cursor_expired' | 'cursor_ahead';

export type JournalReplay =
  | {
      kind: 'events';
      events: RemoteEventEnvelope[];
      cursor: EventCursor;
      minimumSequence: number;
    }
  | {
      kind: 'reset';
      reason: CursorResetReason;
      cursor: EventCursor;
      minimumSequence: number;
    };

export interface EventJournalOptions {
  workspaceId: string;
  epoch?: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  maxEvents?: number;
  maxBytes?: number;
  /** Maximum encoded body returned by one replay request. */
  maxReplayBytes?: number;
  maxWaitMs?: number;
}

interface Waiter {
  after: EventCursor;
  resolve(value: JournalReplay): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout> | null;
  signal?: AbortSignal;
  abort?: () => void;
}

const cloneEnvelope = (envelope: RemoteEventEnvelope): RemoteEventEnvelope =>
  JSON.parse(JSON.stringify(envelope)) as RemoteEventEnvelope;

/** Process-epoch event replay for one device-visible stream. */
export class EventJournal {
  private readonly workspaceId: string;
  private readonly epoch: string;
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly maxReplayBytes: number;
  private readonly maxWaitMs: number;
  private readonly entries: JournalEntry[] = [];
  private readonly waiters = new Set<Waiter>();
  private sequence = 0;
  private bytes = 0;

  constructor(options: EventJournalOptions) {
    this.workspaceId = options.workspaceId;
    this.now = options.now ?? Date.now;
    this.maxEvents = options.maxEvents ?? 10_000;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.maxReplayBytes = options.maxReplayBytes ?? REMOTE_LIMITS.eventResponseBytes;
    this.maxWaitMs = options.maxWaitMs ?? 30_000;
    if (
      !this.workspaceId ||
      this.maxEvents <= 0 ||
      this.maxBytes <= 0 ||
      this.maxReplayBytes <= 0 ||
      this.maxWaitMs < 0
    ) {
      throw new Error('Event journal options are invalid.');
    }
    if (options.epoch) {
      this.epoch = options.epoch;
    } else {
      const random = (options.randomBytes ?? nodeRandomBytes)(16);
      if (!Buffer.isBuffer(random) || random.length !== 16) throw new Error('Random source returned the wrong byte count.');
      this.epoch = random.toString('base64url');
    }
  }

  cursor(): EventCursor {
    return { epoch: this.epoch, sequence: this.sequence };
  }

  append(event: JsonValue): RemoteEventEnvelope {
    // Canonicalization validates JSON-compatibility before the stream position is consumed.
    canonicalJson(event);
    const envelope: RemoteEventEnvelope = {
      workspaceId: this.workspaceId,
      cursor: { epoch: this.epoch, sequence: this.sequence + 1 },
      occurredAt: this.now(),
      event: JSON.parse(JSON.stringify(event)) as JsonValue,
    };
    const bytes = Buffer.byteLength(canonicalJson(envelope));
    if (bytes > this.maxBytes) {
      throw new RemoteProtocolError('EVENT_TOO_LARGE', 'A remote event exceeds the journal limit.', 413);
    }
    // Every accepted event must be consumable by itself. Use the largest possible sequence value
    // for the wrapper so later retention changes cannot strand a once-valid event.
    const singletonBytes = Buffer.byteLength(canonicalJson({
      kind: 'events',
      events: [envelope],
      cursor: envelope.cursor,
      minimumSequence: Number.MAX_SAFE_INTEGER,
    }));
    if (singletonBytes > this.maxReplayBytes) {
      throw new RemoteProtocolError('EVENT_TOO_LARGE', 'A remote event exceeds the replay response limit.', 413);
    }
    this.sequence += 1;
    this.entries.push({ envelope, bytes });
    this.bytes += bytes;
    while (this.entries.length > this.maxEvents || this.bytes > this.maxBytes) {
      const removed = this.entries.shift();
      if (removed) this.bytes -= removed.bytes;
    }
    this.flushWaiters();
    return cloneEnvelope(envelope);
  }

  replay(after: EventCursor | null): JournalReplay {
    const current = this.cursor();
    const minimumSequence = this.minimumSequence();
    if (!after) return { kind: 'reset', reason: 'missing_cursor', cursor: current, minimumSequence };
    if (after.epoch !== this.epoch) {
      return { kind: 'reset', reason: 'epoch_changed', cursor: current, minimumSequence };
    }
    if (!Number.isSafeInteger(after.sequence) || after.sequence < 0 || after.sequence > this.sequence) {
      return { kind: 'reset', reason: 'cursor_ahead', cursor: current, minimumSequence };
    }
    if (after.sequence < minimumSequence) {
      return { kind: 'reset', reason: 'cursor_expired', cursor: current, minimumSequence };
    }
    const pending = this.entries.filter((entry) => entry.envelope.cursor.sequence > after.sequence);
    const selected: JournalEntry[] = [];
    let eventBytes = 0;
    for (const entry of pending) {
      const nextEventBytes = eventBytes + entry.bytes + (selected.length ? 1 : 0);
      const wrapperBytes = Buffer.byteLength(canonicalJson({
        kind: 'events',
        events: [],
        cursor: entry.envelope.cursor,
        minimumSequence,
      }));
      // The empty array's brackets are already in wrapperBytes. Populating it adds exactly the
      // canonical envelopes and the commas between them.
      if (wrapperBytes + nextEventBytes > this.maxReplayBytes) break;
      selected.push(entry);
      eventBytes = nextEventBytes;
    }
    const replayCursor = selected.length
      ? selected[selected.length - 1].envelope.cursor
      : current;
    return {
      kind: 'events',
      events: selected.map((entry) => cloneEnvelope(entry.envelope)),
      cursor: { ...replayCursor },
      minimumSequence,
    };
  }

  wait(after: EventCursor, waitMs: number, signal?: AbortSignal): Promise<JournalReplay> {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > this.maxWaitMs) {
      return Promise.reject(new RemoteProtocolError('INVALID_WAIT', 'waitMs is outside the supported range.'));
    }
    const immediate = this.replay(after);
    if (immediate.kind === 'reset' || immediate.events.length || waitMs === 0) return Promise.resolve(immediate);
    if (signal?.aborted) return Promise.reject(this.abortError());

    return new Promise((resolve, reject) => {
      const waiter: Waiter = { after: { ...after }, resolve, reject, timer: null, signal };
      const settle = (value: JournalReplay) => {
        this.removeWaiter(waiter);
        resolve(value);
      };
      waiter.resolve = settle;
      if (waitMs > 0) {
        waiter.timer = setTimeout(() => settle(this.replay(waiter.after)), waitMs);
        waiter.timer.unref?.();
      }
      if (signal) {
        waiter.abort = () => {
          this.removeWaiter(waiter);
          reject(this.abortError());
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  close(reason = new Error('Event journal closed.')): void {
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.reject(reason);
    }
  }

  private minimumSequence(): number {
    // A cursor immediately before the oldest retained event is still replayable.
    return this.entries.length ? this.entries[0].envelope.cursor.sequence - 1 : this.sequence;
  }

  private flushWaiters(): void {
    for (const waiter of [...this.waiters]) {
      const replay = this.replay(waiter.after);
      if (replay.kind === 'reset' || replay.events.length) waiter.resolve(replay);
    }
  }

  private removeWaiter(waiter: Waiter): void {
    if (!this.waiters.delete(waiter)) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
  }

  private abortError(): Error {
    const error = new Error('Event wait was aborted.');
    error.name = 'AbortError';
    return error;
  }
}
