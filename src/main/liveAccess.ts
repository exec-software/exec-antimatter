import type { AccessMode } from '../api/types';

/** Run-scoped permission state. Subscriptions wake approval gates, not running tools. */
export class LiveAccess {
  private readonly runs = new Map<string, { mode: AccessMode; listeners: Set<() => void> }>();
  constructor(private readonly onListenerError: (error: unknown) => void = (error) => console.error('Permission listener failed:', error)) {}

  begin(runId: string, mode: AccessMode): void {
    if (this.runs.has(runId)) throw new Error('Permissions already initialized for this run.');
    this.runs.set(runId, { mode, listeners: new Set() });
  }

  get(runId: string): AccessMode | undefined { return this.runs.get(runId)?.mode; }

  update(runId: string, mode: AccessMode): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (run.mode === mode) return true;
    run.mode = mode;
    // A subscriber failure must not turn an applied permission change into a failed IPC
    // acknowledgement, or prevent other approval gates from receiving the update.
    for (const listener of [...run.listeners]) {
      try { listener(); } catch (error) { this.onListenerError(error); }
    }
    return true;
  }

  subscribe(runId: string, listener: () => void): () => void {
    const run = this.runs.get(runId);
    run?.listeners.add(listener);
    return () => { run?.listeners.delete(listener); };
  }

  end(runId: string): void {
    this.runs.get(runId)?.listeners.clear();
    this.runs.delete(runId);
  }
}
