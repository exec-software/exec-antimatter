import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import {
  DEFAULT_IDLE_COMPACTION, validateIdleCompactionPatch,
  type IdleCompactionPreferences, type IdleCompactionState,
} from '../api/idleCompaction';
import { writePrivateFileAtomic } from './privateState';

export interface IdleCompactionCandidate<T> {
  threadId: string;
  fingerprint: string;
  estimatedTokens: number;
  payload: T;
}

export interface IdleCompactionResult<T> {
  compactedMessages: number;
  payload: T;
}

/** Only idle, unchanged transcripts may be replaced. Visible messages are never edited here. */
export class IdleCompaction<T, R> {
  private preferences: IdleCompactionPreferences = { ...DEFAULT_IDLE_COMPACTION };
  private threadId: string | null = null;
  private activityAt: number;
  private generation = 0;
  private phase: IdleCompactionState['phase'] = 'off';
  private lastCompletedAt: number | null = null;
  private lastCompactedMessages = 0;
  private error: string | null = null;
  private attempted = new Map<string, string>();
  private controller: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly options: {
    file: string;
    now?(): number;
    candidate(threadId: string): IdleCompactionCandidate<T> | null;
    busy(): boolean;
    compact(candidate: IdleCompactionCandidate<T>, signal: AbortSignal): Promise<IdleCompactionResult<R> | null>;
    commit(candidate: IdleCompactionCandidate<T>, result: IdleCompactionResult<R>): boolean;
    changed?(state: IdleCompactionState): void;
    write?: typeof writePrivateFileAtomic;
  }) {
    this.activityAt = this.now();
    let descriptor: number | undefined;
    try {
      descriptor = openSync(options.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stats = fstatSync(descriptor);
      if (stats.isFile() && stats.size <= 4096) {
        const buffer = Buffer.alloc(4097);
        const size = readSync(descriptor, buffer, 0, buffer.length, 0);
        if (size <= 4096) {
          const stored = JSON.parse(buffer.subarray(0, size).toString('utf8'));
          if (stored?.version === 1) {
            this.preferences = { ...DEFAULT_IDLE_COMPACTION, ...validateIdleCompactionPatch(stored.preferences) };
          }
        }
      }
    } catch { /* Missing, invalid, or unsafe settings leave automatic inference off. */ }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
    this.phase = this.preferences.enabled ? 'waiting' : 'off';
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private changed(): void { this.options.changed?.(this.state()); }

  state(): IdleCompactionState {
    return {
      preferences: { ...this.preferences }, phase: this.phase, threadId: this.threadId,
      lastCompletedAt: this.lastCompletedAt, lastCompactedMessages: this.lastCompactedMessages,
      error: this.error,
    };
  }

  update(value: unknown): IdleCompactionState {
    const next = { ...this.preferences, ...validateIdleCompactionPatch(value) };
    (this.options.write ?? writePrivateFileAtomic)(this.options.file,
      `${JSON.stringify({ version: 1, preferences: next }, null, 2)}\n`);
    this.preferences = next;
    this.attempted.clear();
    this.activity(this.threadId);
    return this.state();
  }

  activity(threadId: string | null): void {
    if (threadId !== null && (typeof threadId !== 'string' || !threadId || threadId.length > 256)) {
      throw new Error('Invalid conversation.');
    }
    this.threadId = threadId;
    this.activityAt = this.now();
    this.generation++;
    this.controller?.abort();
    this.phase = this.preferences.enabled ? 'waiting' : 'off';
    this.error = null;
    this.changed();
  }

  /** Foreground inference waits for cancellation to release its provider reservation. */
  async cancelAndWait(): Promise<void> {
    this.activity(this.threadId);
    await this.pending;
  }

  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => { void this.poll(); }, 10_000);
    this.timer.unref();
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.controller?.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.disposed || this.pending || !this.preferences.enabled || !this.threadId || this.options.busy()) return;
    if (this.now() - this.activityAt < this.preferences.idleMinutes * 60_000) return;
    let candidate: IdleCompactionCandidate<T> | null;
    try { candidate = this.options.candidate(this.threadId); }
    catch { return; }
    if (!candidate || candidate.threadId !== this.threadId || !Number.isFinite(candidate.estimatedTokens)
      || candidate.estimatedTokens < this.preferences.minimumTokens
      || this.attempted.get(candidate.threadId) === candidate.fingerprint) return;
    this.attempted.delete(candidate.threadId);
    this.attempted.set(candidate.threadId, candidate.fingerprint);
    while (this.attempted.size > 32) this.attempted.delete(this.attempted.keys().next().value!);
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.phase = 'running';
    this.error = null;
    this.changed();
    const operation = async () => {
      try {
        const result = await this.options.compact(candidate, controller.signal);
        if (this.disposed || controller.signal.aborted || generation !== this.generation) return;
        if (this.options.busy()) { this.phase = 'waiting'; return; }
        const latest = this.options.candidate(candidate.threadId);
        if (!result || result.compactedMessages < 1 || latest?.fingerprint !== candidate.fingerprint) {
          this.phase = 'waiting';
          return;
        }
        if (!this.options.commit(candidate, result)) {
          this.phase = 'waiting';
          return;
        }
        const saved = this.options.candidate(candidate.threadId);
        if (saved) this.attempted.set(candidate.threadId, saved.fingerprint);
        this.lastCompletedAt = this.now();
        this.lastCompactedMessages = result.compactedMessages;
        this.phase = 'complete';
      } catch (error) {
        if (!controller.signal.aborted && generation === this.generation && !this.disposed) {
          this.phase = 'error';
          this.error = error instanceof Error ? error.message : 'Could not compact this conversation.';
        }
      } finally {
        if (this.controller === controller) this.controller = null;
        if (!this.disposed) this.changed();
      }
    };
    this.pending = operation();
    try { await this.pending; }
    finally { this.pending = null; }
  }
}
