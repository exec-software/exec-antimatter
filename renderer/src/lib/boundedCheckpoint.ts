export interface CheckpointClock<Timer> {
  now(): number;
  set(callback: () => void, delayMs: number): Timer;
  clear(timer: Timer): void;
}

export interface BoundedCheckpoint {
  /** Marks the current snapshot dirty and schedules a coalesced checkpoint. */
  schedule(): void;
  /** Writes pending state immediately. `force` also writes a clean snapshot, for renderer exit. */
  flush(force?: boolean): void;
  /** Drops pending work without writing it. */
  cancel(): void;
}

/**
 * A debounce with a maximum wait.
 *
 * Quiet edits still collapse into one write, but a stream which changes more often than the quiet
 * delay cannot postpone persistence forever: it is checkpointed once the burst reaches maxWaitMs.
 */
export function createBoundedCheckpoint<Timer>(
  checkpoint: () => void,
  options: { quietMs: number; maxWaitMs: number | (() => number) },
  clock: CheckpointClock<Timer>
): BoundedCheckpoint {
  const quietMs = Math.max(0, options.quietMs);
  /**
   * Read per burst, so the bound can depend on what is happening.
   *
   * A quiet edit and a streaming turn want different answers. Typing wants the snapshot on disk
   * soon, and the burst is short anyway. A turn changes the transcript on every token for minutes,
   * and there the max-wait is not protecting against lost work — the carbon holds the turn, and
   * the renderer flushes on unload — it is just deciding how often the store is rewritten while
   * the tokens are arriving.
   */
  const maxWaitFor = () =>
    Math.max(0, typeof options.maxWaitMs === 'function' ? options.maxWaitMs() : options.maxWaitMs);
  let dirtySince: number | null = null;
  let scheduled: { timer: Timer } | null = null;

  const clearScheduled = () => {
    if (!scheduled) return;
    clock.clear(scheduled.timer);
    scheduled = null;
  };

  const write = () => {
    scheduled = null;
    if (dirtySince === null) return;
    dirtySince = null;
    checkpoint();
  };

  return {
    schedule() {
      const now = clock.now();
      if (dirtySince === null) dirtySince = now;

      clearScheduled();
      const elapsed = Math.max(0, now - dirtySince);
      const remaining = Math.max(0, maxWaitFor() - elapsed);
      scheduled = { timer: clock.set(write, Math.min(quietMs, remaining)) };
    },

    flush(force = false) {
      const dirty = dirtySince !== null;
      clearScheduled();
      dirtySince = null;
      if (dirty || force) checkpoint();
    },

    cancel() {
      clearScheduled();
      dirtySince = null;
    },
  };
}
