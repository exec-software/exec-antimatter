import { backoffMs, CONTINUATION_DELAY_MS, validateForDispatch, type ServiceConfig } from './config';
import type { Tracker } from './tracker';
import { ensureWorkspace, removeWorkspace, runHook, runHookOrThrow, workspaceKey } from './workspace';
import {
  emptyState,
  normalizeState,
  OrchestratorError,
  type Issue,
  type OrchestratorState,
  type RunAttempt,
  type Workspace,
} from './types';

/**
 * The Symphony scheduler (spec §7–8).
 *
 * This is the only component that mutates scheduling state: every worker outcome comes back
 * here and becomes an explicit transition. It deliberately imports nothing from Electron or
 * from Antimatter's provider layer — the agent arrives as a callback — so the loop can be
 * reasoned about, and tested, on its own.
 */

export interface AgentJob {
  issue: Issue;
  workspace: Workspace;
  /** null on the first attempt; >= 1 on a retry or continuation (§12.3). */
  attempt: number | null;
  config: ServiceConfig;
  promptTemplate: string;
  /** Resolves when the orchestrator wants the run abandoned (terminal state, stall, shutdown). */
  signal: AbortSignal;
  /** 1-based coding-agent turn within this worker lifetime. */
  turn?: number;
  /** Re-checks the tracker after a completed turn and says whether this worker should continue. */
  shouldContinue(): Promise<boolean>;
  /**
   * Reports that the run is alive. Stall detection measures time since the last event, so a
   * runner that does not call this will be killed at the stall timeout for working quietly.
   */
  touch(event?: string, turnCount?: number): void;
}

export interface LogEvent {
  level: 'info' | 'warn' | 'error';
  message: string;
  issueId?: string;
  issueIdentifier?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface WorkflowSnapshot {
  config: ServiceConfig;
  promptTemplate: string;
  /** Reasons dispatch cannot run this tick; empty means go (§6.3). */
  problems: string[];
}

export interface OrchestratorDeps {
  /** Re-read on every tick so a fixed WORKFLOW.md recovers without a restart (§6.2). */
  loadWorkflow(): WorkflowSnapshot;
  createTracker(config: ServiceConfig): Tracker;
  /** Runs one agent session. Resolving means the turn loop ended cleanly. */
  runAgent(job: AgentJob): Promise<void>;
  /**
   * Where this issue's agent works. Defaults to a directory of its own under workspace.root
   * (§9.2); a source of work that already owns a checkout — Snitch points an issue at the repo
   * the bug is in — returns that instead. Cleanup still only ever touches workspace.root, so a
   * borrowed directory is never removed.
   */
  resolveWorkspace?(issue: Issue, config: ServiceConfig): Workspace;
  log(event: LogEvent): void;
  now?(): number;
}

interface Worker {
  controller: AbortController;
  startedAt: number;
  done: Promise<void>;
}

interface LoadedWorkflow {
  snapshot: WorkflowSnapshot;
  /** False when reconciliation is using the cached copy after a failed live reload. */
  dispatchAllowed: boolean;
}

type CancellationCause = 'shutdown' | 'terminal' | 'inactive' | 'stalled';

export class Orchestrator {
  private state: OrchestratorState;
  private readonly workers = new Map<string, Worker>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cancellations = new Map<string, CancellationCause>();
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private tickInFlight: Promise<void> | null = null;
  private readonly retryJobs = new Set<Promise<void>>();
  /**
   * Lifecycle requests are serialized, but each queued transition consults the newest requested
   * state when it actually runs. That makes rapid start/stop sequences converge on the last
   * request instead of allowing an older in-flight promise to swallow it.
   */
  private lifecycleTail: Promise<void> = Promise.resolve();
  private desiredRunning = false;
  private lifecycleEpoch = 0;
  private running = false;
  /** True only after terminal cleanup and the startup poll have both completed. */
  private activated = false;
  private lastGoodWorkflow: WorkflowSnapshot | null = null;

  constructor(private readonly deps: OrchestratorDeps) {
    let snapshot: WorkflowSnapshot | null = null;
    try {
      const candidate = this.deps.loadWorkflow();
      const problems = this.problems(candidate);
      if (!problems.length) {
        snapshot = candidate;
        this.lastGoodWorkflow = candidate;
      }
    } catch (error) {
      this.deps.log({ level: 'error', message: `workflow load failed: ${(error as Error).message}` });
    }
    this.state = emptyState(
      snapshot?.config.pollIntervalMs ?? 30_000,
      snapshot?.config.agent.maxConcurrentAgents ?? 10
    );
  }

  private problems(snapshot: WorkflowSnapshot): string[] {
    return snapshot.problems.length ? snapshot.problems : validateForDispatch(snapshot.config);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private safeWorkflow(): LoadedWorkflow | null {
    try {
      const snapshot = this.deps.loadWorkflow();
      const problems = this.problems(snapshot);
      if (problems.length) throw new Error(problems.join('; '));
      this.lastGoodWorkflow = snapshot;
      return { snapshot, dispatchAllowed: true };
    } catch (error) {
      // §6.2 — keep reconciling live work with the last-good config, but an invalid current
      // workflow must never dispatch new work until the file is valid again.
      this.deps.log({ level: 'error', message: `workflow reload failed: ${(error as Error).message}` });
      return this.lastGoodWorkflow ? { snapshot: this.lastGoodWorkflow, dispatchAllowed: false } : null;
    }
  }

  private currentLifecycle(epoch: number): boolean {
    return this.desiredRunning && this.running && this.lifecycleEpoch === epoch;
  }

  private active(epoch: number): boolean {
    return this.activated && this.currentLifecycle(epoch);
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    // A failed startup must reject its own caller without poisoning every later lifecycle request.
    const queued = this.lifecycleTail.catch(() => undefined).then(operation);
    this.lifecycleTail = queued.catch(() => undefined);
    return queued;
  }

  /** §8.1 — validate, clean up stale terminal workspaces, then tick immediately and on cadence. */
  start(): Promise<void> {
    this.desiredRunning = true;
    return this.enqueueLifecycle(async () => {
      if (!this.desiredRunning || this.running) return;
      await this.startCurrentLifecycle();
    });
  }

  private async startCurrentLifecycle(): Promise<void> {
    if (!this.desiredRunning || this.running) return;
    // Startup is intentionally strict. Last-good fallback applies only after the service has
    // successfully started; otherwise a broken workflow would look like a healthy idle daemon.
    const snapshot = this.deps.loadWorkflow();
    const problems = this.problems(snapshot);
    if (problems.length) throw new Error(`workflow validation failed: ${problems.join('; ')}`);
    this.lastGoodWorkflow = snapshot;

    const epoch = ++this.lifecycleEpoch;
    this.running = true;
    this.activated = false;
    let startupCompleted = false;
    try {
      await this.cleanupTerminalWorkspaces(snapshot, epoch);
      if (!this.currentLifecycle(epoch)) return;
      // The immediate startup poll is internal: public poll and workflow-change requests remain
      // gated until this barrier completes, so cleanup can never race a dispatched workspace.
      await this.tickCurrentLifecycle(epoch, true);
      if (!this.currentLifecycle(epoch)) return;
      this.activated = true;
      this.schedule();
      startupCompleted = true;
    } finally {
      // A stop intent can interrupt startup before its immediate tick or schedule. Relinquish
      // ownership in that case so a newer start request cannot mistake this for a live service.
      if (!startupCompleted && this.lifecycleEpoch === epoch) {
        this.activated = false;
        this.running = false;
        this.lifecycleEpoch += 1;
      }
    }
  }

  stop(): Promise<void> {
    this.desiredRunning = false;
    return this.enqueueLifecycle(async () => {
      if (this.desiredRunning) return;
      await this.stopCurrentLifecycle();
    });
  }

  private async stopCurrentLifecycle(): Promise<void> {
    this.activated = false;
    this.running = false;
    this.lifecycleEpoch += 1;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = null;

    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.state.retryAttempts.clear();
    this.state.claimed.clear();

    const workers = [...this.workers.entries()];
    for (const [issueId, worker] of workers) {
      this.cancellations.set(issueId, 'shutdown');
      worker.controller.abort();
    }
    await Promise.allSettled([
      ...workers.map(([, worker]) => worker.done),
      ...this.retryJobs,
      ...(this.tickInFlight ? [this.tickInFlight] : []),
    ]);
    this.workers.clear();
    this.state.running.clear();
    this.cancellations.clear();
  }

  /** Apply a watched WORKFLOW.md change immediately, including a new polling cadence. */
  async workflowChanged(): Promise<void> {
    if (!this.active(this.lifecycleEpoch)) return;
    await this.tick();
    this.schedule();
  }

  private schedule(): void {
    if (!this.active(this.lifecycleEpoch)) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => void this.tick().finally(() => this.schedule()), this.state.pollIntervalMs);
  }

  /** §8.1 — one poll tick. Reconciliation always runs, even when dispatch is blocked. */
  async tick(): Promise<void> {
    if (!this.active(this.lifecycleEpoch)) return;
    if (this.tickInFlight) return this.tickInFlight;
    const epoch = this.lifecycleEpoch;
    const operation = this.tickCurrentLifecycle(epoch);
    this.tickInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.tickInFlight === operation) this.tickInFlight = null;
    }
  }

  private async tickCurrentLifecycle(epoch: number, duringStartup = false): Promise<void> {
    const canPoll = () => duringStartup ? this.currentLifecycle(epoch) : this.active(epoch);
    if (!canPoll()) return;
    const loaded = this.safeWorkflow();
    if (!loaded) return;
    const { snapshot, dispatchAllowed } = loaded;

    this.state.pollIntervalMs = snapshot.config.pollIntervalMs;
    this.state.maxConcurrentAgents = snapshot.config.agent.maxConcurrentAgents;

    await this.reconcile(snapshot, epoch);
    if (!canPoll() || !dispatchAllowed) return;

    await this.dispatchCycle(snapshot, epoch);
  }

  /** §8.2 — eligibility. Every clause here is a reason not to start duplicate work. */
  private eligible(issue: Issue, config: ServiceConfig): boolean {
    const active = new Set(config.tracker.activeStates.map(normalizeState));
    const terminal = new Set(config.tracker.terminalStates.map(normalizeState));
    const state = normalizeState(issue.state);

    if (!active.has(state) || terminal.has(state)) return false;
    if (this.state.running.has(issue.id) || this.state.claimed.has(issue.id)) return false;

    // The spec's sanitized workspace key is not injective (ABC/1 and ABC?1 both become ABC_1).
    // Serialize colliding identifiers so two otherwise distinct issues never share it at once.
    const key = workspaceKey(issue.identifier);
    for (const entry of this.state.running.values()) {
      if (entry.issue.id !== issue.id && workspaceKey(entry.issue.identifier) === key) return false;
    }
    for (const retry of this.state.retryAttempts.values()) {
      if (retry.issueId !== issue.id && workspaceKey(retry.identifier) === key) return false;
    }

    // A Todo with a live blocker would generate code against work that does not exist yet.
    if (state === 'todo' && issue.blockedBy.some((blocker) => !blocker.state || !terminal.has(normalizeState(blocker.state)))) {
      return false;
    }
    return true;
  }

  /** §8.2 — priority ascending with unknown last, then oldest, then identifier. */
  private static sortCandidates(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      const left = a.priority ?? Number.POSITIVE_INFINITY;
      const right = b.priority ?? Number.POSITIVE_INFINITY;
      if (left !== right) return left - right;

      const created = (a.createdAt ?? Number.POSITIVE_INFINITY) - (b.createdAt ?? Number.POSITIVE_INFINITY);
      if (created !== 0) return created;

      return a.identifier.localeCompare(b.identifier);
    });
  }

  /** §8.3 — per-state caps fall back to the global limit. */
  private stateSlots(state: string, config: ServiceConfig): number {
    const limit = config.agent.maxConcurrentAgentsByState[normalizeState(state)];
    const cap = limit ?? config.agent.maxConcurrentAgents;
    let used = 0;
    for (const entry of this.state.running.values()) {
      if (normalizeState(entry.issue.state) === normalizeState(state)) used += 1;
    }
    return Math.max(cap - used, 0);
  }

  private async dispatchCycle(snapshot: WorkflowSnapshot, epoch: number): Promise<void> {
    const { config } = snapshot;
    let tracker: Tracker;
    try {
      tracker = this.deps.createTracker(config);
    } catch (error) {
      this.deps.log({ level: 'error', message: `tracker unavailable: ${(error as Error).message}` });
      return;
    }

    let candidates: Issue[];
    try {
      candidates = await tracker.fetchCandidateIssues();
    } catch (error) {
      // §11.4 — a candidate fetch failure skips this tick; running work is untouched.
      this.deps.log({ level: 'error', message: `candidate fetch failed: ${(error as Error).message}` });
      return;
    }
    if (!this.currentLifecycle(epoch)) return;

    for (const issue of Orchestrator.sortCandidates(candidates)) {
      if (!this.currentLifecycle(epoch)) return;
      const globalSlots = Math.max(this.state.maxConcurrentAgents - this.state.running.size, 0);
      if (globalSlots <= 0) break;
      if (!this.eligible(issue, config)) continue;
      if (this.stateSlots(issue.state, config) <= 0) continue;

      this.launch(issue, snapshot, null);
    }
  }

  /** Claims the issue and runs one attempt. Never awaited by the tick, so a slow agent cannot stall polling. */
  private launch(issue: Issue, snapshot: WorkflowSnapshot, attempt: number | null): void {
    const { config } = snapshot;
    this.state.claimed.add(issue.id);

    const controller = new AbortController();
    const startedAt = this.now();
    const run: RunAttempt = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt,
      workspacePath: '',
      startedAt,
      phase: 'PreparingWorkspace',
    };

    const worker: Worker = { controller, startedAt, done: Promise.resolve() };
    this.workers.set(issue.id, worker);
    this.state.running.set(issue.id, { issue, attempt: run, session: null, startedAt });
    this.deps.log({
      level: 'info',
      message: `dispatch started attempt=${attempt ?? 0}`,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
    });

    worker.done = this.execute(issue, snapshot, attempt, run, controller)
      .then(
        () => this.finish(issue, config, attempt, null, worker, run),
        (error: Error) => this.finish(issue, config, attempt, error, worker, run)
      )
      .catch((error: Error) =>
        this.deps.log({
          level: 'error',
          message: `worker cleanup failed: ${error.message}`,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
        })
      );
  }

  /** Cleanup stays best-effort, but an advisory hook failure must remain visible in the audit log. */
  private cleanupWorkspace(issue: Issue, config: ServiceConfig): Promise<boolean> {
    return removeWorkspace(config.workspaceRoot, issue.identifier, config.hooks, (message) => {
      this.deps.log({
        level: 'warn',
        message,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        hook: 'before_remove',
      });
    });
  }

  private async execute(
    issue: Issue,
    snapshot: WorkflowSnapshot,
    attempt: number | null,
    run: RunAttempt,
    controller: AbortController
  ): Promise<void> {
    const { config } = snapshot;

    const workspace = this.deps.resolveWorkspace
      ? this.deps.resolveWorkspace(issue, config)
      : ensureWorkspace(config.workspaceRoot, issue.identifier);
    run.workspacePath = workspace.path;

    if (workspace.createdNow) {
      try {
        await runHookOrThrow('afterCreate', config.hooks.afterCreate, workspace.path, config.hooks.timeoutMs, controller.signal);
      } catch (error) {
        // A failed initializer leaves a partial directory. Removing only the directory this call
        // just created lets the next retry run after_create again instead of inheriting debris.
        await this.cleanupWorkspace(issue, config).catch(() => false);
        throw error;
      }
    }
    await runHookOrThrow('beforeRun', config.hooks.beforeRun, workspace.path, config.hooks.timeoutMs, controller.signal);

    run.phase = 'StreamingTurn';
    let cleanupAfterRun = false;
    try {
      await this.deps.runAgent({
        issue,
        workspace,
        attempt,
        config,
        promptTemplate: snapshot.promptTemplate,
        signal: controller.signal,
        shouldContinue: async () => {
          const disposition = await this.continuationDisposition(issue.id, config);
          if (disposition === 'terminal') cleanupAfterRun = true;
          return disposition === 'active';
        },
        touch: (event, turnCount) => this.touch(issue.id, event, turnCount),
      });
      run.phase = 'Succeeded';
    } finally {
      // §9.4 — after_run runs on every outcome once the workspace exists, and its failure is
      // logged rather than raised: it must never turn a completed run into a failed one.
      const after = await runHook(config.hooks.afterRun, workspace.path, config.hooks.timeoutMs);
      if (after.ran && (after.timedOut || after.code !== 0)) {
        this.deps.log({
          level: 'warn',
          message: `after_run hook ${after.timedOut ? 'timed out' : `exited ${after.code}`}`,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
        });
      }
      if (cleanupAfterRun) {
        await this.cleanupWorkspace(issue, config).catch(() => false);
      }
    }
  }

  /** §7.3 — worker exit. Clean exits schedule a short continuation; failures back off. */
  private async finish(
    issue: Issue,
    config: ServiceConfig,
    launchedAttempt: number | null,
    error: Error | null,
    worker: Worker,
    run: RunAttempt
  ): Promise<void> {
    const entry = this.state.running.get(issue.id);
    if (entry) {
      this.state.totals.secondsRunning += Math.max(0, (this.now() - entry.startedAt) / 1000);
    }
    try {
      const cancellation = this.cancellations.get(issue.id);
      if (cancellation === 'terminal') {
        run.phase = 'CanceledByReconciliation';
        await this.cleanupWorkspace(issue, config).catch(() => false);
        this.release(issue.id);
        return;
      }
      if (cancellation === 'inactive' || cancellation === 'shutdown' || !this.desiredRunning || !this.running) {
        run.phase = 'CanceledByReconciliation';
        this.release(issue.id);
        return;
      }
      if (cancellation === 'stalled') {
        if (!error || (error instanceof OrchestratorError && error.code === 'turn_cancelled')) {
          error = new OrchestratorError('turn_timeout', `${issue.identifier}: worker stopped after the stall timeout.`);
        }
        run.phase = 'Stalled';
      }

      if (error) {
        const code = error instanceof OrchestratorError ? error.code : 'turn_failed';
        if (run.phase !== 'Stalled') {
          run.phase = code === 'turn_timeout' || code === 'response_timeout' ? 'TimedOut' : 'Failed';
        }
        run.error = error.message;
        // The retry entry is removed when its timer fires, so the launched attempt itself is the
        // only durable source of the next exponent.
        const attempt = (launchedAttempt ?? 0) + 1;
        this.deps.log({
          level: 'error',
          message: `attempt failed (${code}): ${error.message}`,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
        });
        this.queueRetry(issue, attempt, backoffMs(attempt, config.agent.maxRetryBackoffMs), error.message);
        return;
      }

      this.state.completed.add(issue.id);
      this.deps.log({ level: 'info', message: 'attempt completed', issueId: issue.id, issueIdentifier: issue.identifier });
      // §7.1 — a clean exit is not "done forever": re-check shortly in case the issue is still active.
      this.queueRetry(issue, 1, CONTINUATION_DELAY_MS, null);
    } finally {
      // Keep ownership visible through asynchronous terminal cleanup so stop() can await it.
      // Identity checks prevent a stale completion from deleting a newer lifecycle's worker.
      if (this.state.running.get(issue.id)?.attempt === run) this.state.running.delete(issue.id);
      if (this.workers.get(issue.id) === worker) this.workers.delete(issue.id);
      this.cancellations.delete(issue.id);
    }
  }

  /** §8.4 — one timer per issue; a new retry always replaces the old one. */
  private queueRetry(issue: Issue, attempt: number, delayMs: number, error: string | null): void {
    const existing = this.timers.get(issue.id);
    if (existing) clearTimeout(existing);

    this.state.claimed.add(issue.id);
    this.state.retryAttempts.set(issue.id, {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt,
      dueAt: this.now() + delayMs,
      error,
    });

    this.timers.set(issue.id, setTimeout(() => {
      const job = this.fireRetry(issue.id, attempt);
      this.retryJobs.add(job);
      void job.finally(() => this.retryJobs.delete(job));
    }, delayMs));
  }

  /** §8.4 — on fire, re-fetch candidates; the issue may have moved on while we waited. */
  private async fireRetry(issueId: string, attempt: number): Promise<void> {
    const epoch = this.lifecycleEpoch;
    this.timers.delete(issueId);
    this.state.retryAttempts.delete(issueId);
    // Stopped, or only ever ticked once: release the claim rather than leaving the issue
    // looking permanently in flight, so a later start() can pick it up again.
    if (!this.active(epoch)) return this.release(issueId);

    const loaded = this.safeWorkflow();
    if (!loaded || !loaded.dispatchAllowed) return this.release(issueId);
    const { snapshot } = loaded;

    let candidates: Issue[];
    try {
      candidates = await this.deps.createTracker(snapshot.config).fetchCandidateIssues();
    } catch (error) {
      this.deps.log({ level: 'warn', message: `retry fetch failed: ${(error as Error).message}`, issueId });
      return this.release(issueId);
    }
    if (!this.active(epoch)) return;

    const issue = candidates.find((candidate) => candidate.id === issueId);
    if (!issue) return this.release(issueId);

    this.state.claimed.delete(issueId);
    if (!this.eligible(issue, snapshot.config)) return this.release(issueId);

    if (this.state.running.size >= this.state.maxConcurrentAgents) {
      this.queueRetry(issue, attempt, backoffMs(attempt, snapshot.config.agent.maxRetryBackoffMs), 'no available orchestrator slots');
      return;
    }
    if (this.stateSlots(issue.state, snapshot.config) <= 0) {
      this.queueRetry(issue, attempt, backoffMs(attempt, snapshot.config.agent.maxRetryBackoffMs), 'no available slots for issue state');
      return;
    }
    this.launch(issue, snapshot, attempt);
  }

  private release(issueId: string): void {
    this.state.claimed.delete(issueId);
    this.state.retryAttempts.delete(issueId);
  }

  /**
   * §8.5 liveness. The orchestrator stays the only thing that mutates its own state, so a
   * runner reports progress here rather than writing the session itself. Without this,
   * reconcile() measures from startedAt and aborts a healthy turn on a slow local model the
   * moment it passes the stall timeout.
   */
  private touch(issueId: string, event?: string, turnCount?: number): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    const at = this.now();
    entry.session = entry.session
      ? {
          ...entry.session,
          lastEvent: event ?? entry.session.lastEvent,
          lastEventAt: at,
          turnId: String(turnCount ?? entry.session.turnCount),
          sessionId: `${entry.issue.identifier}-${entry.attempt.attempt ?? 0}-${turnCount ?? entry.session.turnCount}`,
          turnCount: turnCount ?? entry.session.turnCount,
        }
      : {
          sessionId: `${entry.issue.identifier}-${entry.attempt.attempt ?? 0}-${turnCount ?? 1}`,
          threadId: `${entry.issue.id}-${entry.startedAt}`,
          turnId: String(turnCount ?? 1),
          lastEvent: event ?? null,
          lastEventAt: at,
          lastMessage: null,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          reportedInputTokens: 0,
          reportedOutputTokens: 0,
          reportedTotalTokens: 0,
          turnCount: turnCount ?? 1,
        };
  }

  /** Re-check tracker state between successful turns in one worker (§7.1). */
  private async continuationDisposition(
    issueId: string,
    config: ServiceConfig
  ): Promise<'active' | 'terminal' | 'inactive'> {
    const states = await this.deps.createTracker(config).fetchIssueStatesByIds([issueId]);
    const current = states.get(issueId);
    if (!current) return 'inactive';

    const state = normalizeState(current);
    const terminal = new Set(config.tracker.terminalStates.map(normalizeState));
    if (terminal.has(state)) return 'terminal';

    const active = new Set(config.tracker.activeStates.map(normalizeState));
    if (!active.has(state)) return 'inactive';

    const entry = this.state.running.get(issueId);
    if (entry) entry.issue = { ...entry.issue, state: current };
    return 'active';
  }

  /** §8.5 — stall detection, then a tracker state refresh for everything still running. */
  private async reconcile(snapshot: WorkflowSnapshot, epoch: number): Promise<void> {
    const { config } = snapshot;

    if (config.runner.stallTimeoutMs > 0) {
      for (const [issueId, entry] of [...this.state.running]) {
        if (this.cancellations.has(issueId)) continue;
        const last = entry.session?.lastEventAt ?? entry.startedAt;
        if (this.now() - last <= config.runner.stallTimeoutMs) continue;

        this.deps.log({ level: 'warn', message: 'stalled; terminating', issueId, issueIdentifier: entry.issue.identifier });
        this.cancellations.set(issueId, 'stalled');
        this.workers.get(issueId)?.controller.abort('stalled');
      }
    }

    const ids = [...this.state.running.keys()];
    if (!ids.length) return;

    let states: Map<string, string>;
    try {
      states = await this.deps.createTracker(config).fetchIssueStatesByIds(ids);
    } catch (error) {
      // §8.5 — keep workers running and try again next tick.
      this.deps.log({ level: 'warn', message: `state refresh failed: ${(error as Error).message}` });
      return;
    }
    if (!this.currentLifecycle(epoch)) return;

    const active = new Set(config.tracker.activeStates.map(normalizeState));
    const terminal = new Set(config.tracker.terminalStates.map(normalizeState));

    for (const [issueId, entry] of [...this.state.running]) {
      const current = states.get(issueId);
      if (!current) {
        if (!this.cancellations.has(issueId)) {
          this.cancellations.set(issueId, 'inactive');
          this.workers.get(issueId)?.controller.abort();
          this.deps.log({ level: 'info', message: 'missing from tracker; stopped', issueId, issueIdentifier: entry.issue.identifier });
        }
        continue;
      }
      const state = normalizeState(current);

      if (terminal.has(state)) {
        this.cancellations.set(issueId, 'terminal');
        this.workers.get(issueId)?.controller.abort();
        this.deps.log({ level: 'info', message: `terminal (${current}); stopped`, issueId, issueIdentifier: entry.issue.identifier });
      } else if (active.has(state)) {
        entry.issue = { ...entry.issue, state: current };
      } else {
        // Neither active nor terminal: stop, but leave the workspace alone.
        this.cancellations.set(issueId, 'inactive');
        this.workers.get(issueId)?.controller.abort();
        this.deps.log({ level: 'info', message: `no longer active (${current}); stopped`, issueId });
      }
    }
  }

  /** §8.6 — drop workspaces for issues that finished while we were not running. */
  private async cleanupTerminalWorkspaces(snapshot: WorkflowSnapshot, epoch: number): Promise<void> {
    const { config } = snapshot;
    try {
      const finished = await this.deps.createTracker(config).fetchIssuesByStates(config.tracker.terminalStates);
      for (const issue of finished) {
        if (!this.currentLifecycle(epoch)) return;
        await this.cleanupWorkspace(issue, config).catch(() => false);
      }
    } catch (error) {
      // A cleanup failure is a warning, never a reason to refuse to start.
      this.deps.log({ level: 'warn', message: `startup cleanup skipped: ${(error as Error).message}` });
    }
  }

  /** §13.3 — the runtime snapshot a dashboard or IPC handler reads. */
  snapshot() {
    const activeSeconds = [...this.state.running.values()].reduce(
      (total, entry) => total + Math.max(0, (this.now() - entry.startedAt) / 1000),
      0
    );

    return {
      active: this.active(this.lifecycleEpoch),
      running: [...this.state.running.values()].map((entry) => ({
        issueId: entry.issue.id,
        identifier: entry.issue.identifier,
        title: entry.issue.title,
        state: entry.issue.state,
        phase: entry.attempt.phase,
        attempt: entry.attempt.attempt,
        startedAt: entry.startedAt,
        turnCount: entry.session?.turnCount ?? 0,
        sessionId: entry.session?.sessionId ?? null,
      })),
      retrying: [...this.state.retryAttempts.values()],
      totals: { ...this.state.totals, secondsRunning: this.state.totals.secondsRunning + activeSeconds },
      rateLimits: this.state.rateLimits,
      pollIntervalMs: this.state.pollIntervalMs,
      maxConcurrentAgents: this.state.maxConcurrentAgents,
    };
  }
}
