export interface RestartTarget {
  execPath: string;
  args: string[];
}

export interface AutomaticUpdateReadyState {
  automatic: boolean;
  status: string;
  readyVersion: string | null;
}

export interface AutomaticRestartReport {
  pending: boolean;
  blockers: string[];
  error: string | null;
}

export interface AutomaticRestartActivity {
  chatTurns: number;
  providerBusy: boolean;
  agentRunnerBusy: boolean;
  runningAgentTasks: number;
  orchestratorActive: boolean;
  orchestratorRuns: number;
  orchestratorRetries: number;
  recoveryBusy: boolean;
  liveTerminals: number;
  environmentRun: boolean;
  debuggerActive: boolean;
  editBusy: boolean;
}

export interface RendererRestartPreparation {
  blockers: string[];
  /** Lets the renderer accept input again when this attempt does not proceed to process exit. */
  release(): void;
}

/** User-facing reasons the desktop cannot safely discard process-local state yet. */
export function automaticRestartBlockers(activity: AutomaticRestartActivity): string[] {
  const blockers: string[] = [];
  if (activity.chatTurns) blockers.push('A chat turn is still running.');
  if (activity.providerBusy) blockers.push('An inference request is still running.');
  if (activity.agentRunnerBusy || activity.runningAgentTasks) blockers.push('An agent task is still running.');
  if (activity.orchestratorActive || activity.orchestratorRuns || activity.orchestratorRetries) {
    blockers.push('The orchestrator is active; stop it before Antimatter restarts automatically.');
  }
  if (activity.recoveryBusy) blockers.push('The recovery shell is still running a request.');
  if (activity.liveTerminals) blockers.push('A terminal session is still open.');
  if (activity.environmentRun) blockers.push('An environment command is still running.');
  if (activity.debuggerActive) blockers.push('A debug session is still active.');
  if (activity.editBusy) blockers.push('A file edit is still being committed.');
  return blockers;
}

export interface AutomaticRestartDeps {
  state(): AutomaticUpdateReadyState;
  /** Process-local work that must finish before renderer state is even requested. */
  blockers(): string[];
  /** Saves renderer-owned durable state, or reports state that must remain open. */
  prepareRenderer(version: string): Promise<RendererRestartPreparation>;
  target(): RestartTarget | null;
  /** Persists loop protection for this exact running/installed version pair. */
  claim(version: string): boolean;
  /** Prevents new work from entering after the final blocker check. */
  beginCommit(): void;
  endCommit(): void;
  relaunch(target: RestartTarget): Promise<void>;
  quit(): void;
  report(state: AutomaticRestartReport): void;
  log?(message: string, error?: unknown): void;
  retryMs?: number;
}

const unique = (items: string[]): string[] => [...new Set(items.filter(Boolean))];

/**
 * Coordinates a verified installed update with live work and renderer-owned state.
 *
 * There is deliberately no force path here. An automatic restart waits, while the explicit
 * Restart now action remains the user's escape hatch. The final blocker read and beginCommit are
 * synchronous in one event-loop turn, closing the race where new work could start after checking.
 */
export class AutomaticRestartCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private offered = false;
  private checking = false;
  private committed = false;
  private stopped = false;
  private epoch = 0;

  constructor(private readonly deps: AutomaticRestartDeps) {}

  offer(): void {
    if (this.stopped || this.committed) return;
    this.offered = true;
    this.schedule(0);
  }

  cancel(): void {
    this.offered = false;
    this.epoch += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deps.report({ pending: false, blockers: [], error: null });
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  /** One eligibility pass; public so lifecycle tests need no wall-clock sleeps. */
  async checkNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.attempt();
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.checking || !this.offered || this.committed || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.attempt();
    }, delayMs);
    this.timer.unref?.();
  }

  private ready(): { version: string } | null {
    const state = this.deps.state();
    return state.automatic && state.status === 'ready' && state.readyVersion
      ? { version: state.readyVersion }
      : null;
  }

  private async attempt(): Promise<void> {
    if (this.checking || !this.offered || this.committed || this.stopped) return;
    const ready = this.ready();
    if (!ready) {
      this.cancel();
      return;
    }

    this.checking = true;
    const epoch = this.epoch;
    let retry = false;
    let rendererPreparation: RendererRestartPreparation | null = null;
    let keepRendererFrozen = false;
    try {
      const processBlockers = unique(this.deps.blockers());
      if (processBlockers.length) {
        this.deps.report({ pending: true, blockers: processBlockers, error: null });
        retry = true;
        return;
      }

      let rendererBlockers: string[];
      try {
        rendererPreparation = await this.deps.prepareRenderer(ready.version);
        rendererBlockers = unique(rendererPreparation.blockers);
      } catch (error) {
        rendererBlockers = [`The window could not prepare for restart: ${(error as Error).message}`];
      }

      // Automatic updates can be disabled, or a newer release can become ready, while awaiting
      // the renderer. Never apply an acknowledgement to a different lifecycle generation.
      const stillReady = this.ready();
      if (this.epoch !== epoch) return;
      if (!stillReady) {
        this.cancel();
        return;
      }
      if (stillReady.version !== ready.version) {
        retry = true;
        return;
      }

      // Re-read every main-process blocker after the async renderer handshake. beginCommit follows
      // synchronously, so IPC guards can prevent anything new from entering after this point.
      const finalBlockers = unique([...rendererBlockers, ...this.deps.blockers()]);
      if (finalBlockers.length) {
        this.deps.report({ pending: true, blockers: finalBlockers, error: null });
        retry = true;
        return;
      }

      const target = this.deps.target();
      if (!target) {
        this.offered = false;
        this.deps.report({
          pending: false,
          blockers: [],
          error: 'The installed update has no valid relaunch target. Use Restart now after repairing the installation.',
        });
        return;
      }

      this.deps.beginCommit();
      if (!this.deps.claim(ready.version)) {
        this.deps.endCommit();
        this.offered = false;
        return;
      }

      this.committed = true;
      this.offered = false;
      this.deps.report({ pending: false, blockers: [], error: null });
      try {
        await this.deps.relaunch(target);
      } catch (error) {
        // The durable version-pair claim remains set: repeated automatic attempts by this old
        // binary would be a restart loop. The app stays usable and Restart now can be tried by hand.
        this.committed = false;
        this.deps.endCommit();
        this.deps.report({
          pending: false,
          blockers: [],
          error: `Could not start the update relaunch helper: ${(error as Error).message}`,
        });
        this.deps.log?.('[updates] relaunch helper failed', error);
        return;
      }

      this.deps.quit();
      keepRendererFrozen = true;
    } finally {
      if (rendererPreparation && !keepRendererFrozen) {
        try {
          rendererPreparation.release();
        } catch (error) {
          this.deps.log?.('[updates] could not release the renderer restart hold', error);
        }
      }
      this.checking = false;
      if (retry && this.epoch === epoch) this.schedule(this.deps.retryMs ?? 2_000);
    }
  }
}
