import type { ServiceConfig } from '../orchestrator/config';
import type { Tracker } from '../orchestrator/tracker';
import type { Issue } from '../orchestrator/types';
import { isActiveStage, type ItemValue, type PipelineStage, type ProjectDetail, type SnitchItem } from './model';
import * as store from './store';

/**
 * The fix pipeline: one click on an issue, through the orchestrator, back as a verdict.
 *
 * It is written as a Tracker because that is all the orchestrator needs from it. Everything the
 * scheduler already does — claims, one workspace per item, retry with backoff, reconciliation —
 * applies unchanged; a dispatched item is simply an issue that appears in the candidate list.
 *
 * Two stages share one item. `Fixing` runs the change, `QA` reads the result and votes, and the
 * stage is encoded into the tracker id (`snitch:<project>/<item>#<stage>`) so the orchestrator
 * sees the QA pass as a new piece of work with a fresh first turn, not as a continuation of the
 * fix. The identifier stays the bare item id, so both stages share one workspace.
 */

export const FIXING_STATE = 'Fixing';
export const QA_STATE = 'QA';
export const VERIFIED_STATE = 'Verified';
export const FAILED_STATE = 'Failed';

export const SNITCH_ACTIVE_STATES = [FIXING_STATE, QA_STATE];
export const SNITCH_TERMINAL_STATES = [VERIFIED_STATE, FAILED_STATE];

/** How many fix→QA rounds an item gets before it is handed back to a person. */
const MAX_CYCLES = 3;
/** How many times a single stage may end in an error before the item is marked failed. */
const MAX_STAGE_FAILURES = 3;
/** Enough of the agent's closing summary to brief the next stage without resending the world. */
const NOTE_LIMIT = 1600;

export interface PipelineEntry {
  project: string;
  itemId: string;
  title: string;
  kind: 'issue' | 'request';
  stage: PipelineStage;
  attempt: number;
  failures: number;
  note: string | null;
  updatedAt: string | null;
  repo: string | null;
}

export interface PipelineDeps {
  /** Asks the orchestrator to poll now, because a dispatch just changed what is dispatchable. */
  wake(): void;
  log(event: {
    level: 'info' | 'warn' | 'error';
    message: string;
    itemId?: string;
    stage?: PipelineStage;
    previousStage?: PipelineStage;
    attempt?: number;
    failures?: number;
    runId?: string;
    sessionId?: string;
    rounds?: number;
    toolCalls?: number;
    reason?: string;
  }): void;
}

export interface TurnResult {
  ok: boolean;
  /** Deliberate cancellation is cleanup, not a failed fix/QA attempt. */
  cancelled?: boolean;
  content: string;
  error?: string;
  /** Present on results emitted by the orchestrator runner; optional for tracker tests/callers. */
  runId?: string;
  sessionId?: string;
  rounds?: number;
  toolCalls?: number;
  reason?: string;
}

const PREFIX = 'snitch:';

export interface ItemRef {
  project: string;
  itemId: string;
  stage: PipelineStage;
  generation: number;
}

export const encodeIssueId = (
  project: string,
  itemId: string,
  stage: PipelineStage,
  generation: number
): string => `${PREFIX}${project}/${itemId}#${stage}@${generation}`;

export function decodeIssueId(id: string): ItemRef | null {
  if (!id.startsWith(PREFIX)) return null;
  const body = id.slice(PREFIX.length);
  const slash = body.indexOf('/');
  const hash = body.lastIndexOf('#');
  if (slash === -1 || hash <= slash) return null;

  const stageAndGeneration = body.slice(hash + 1);
  const separator = stageAndGeneration.lastIndexOf('@');
  if (separator <= 0) return null;
  const generation = Number.parseInt(stageAndGeneration.slice(separator + 1), 10);
  if (!Number.isSafeInteger(generation) || generation < 0) return null;

  return {
    project: body.slice(0, slash),
    itemId: body.slice(slash + 1, hash),
    stage: stageAndGeneration.slice(0, separator) as PipelineStage,
    generation,
  };
}

/** Match an orchestrator-owned issue to the Snitch object a destructive action targets. */
export function ownsSnitchTarget(id: string, project: string, itemIds?: ReadonlySet<string>): boolean {
  const ref = decodeIssueId(id);
  return !!ref && ref.project === project && (!itemIds || itemIds.has(ref.itemId));
}

const stateFor = (stage: PipelineStage): string =>
  stage === 'qa' ? QA_STATE : stage === 'verified' ? VERIFIED_STATE : stage === 'failed' ? FAILED_STATE : FIXING_STATE;

/** Critical first. The orchestrator sorts ascending, and treats a missing priority as last. */
const PRIORITY: Record<ItemValue, number> = { critical: 1, high: 2, medium: 3, low: 4 };

/**
 * The next stage needs the closing report, not the opening narration.
 *
 * Agent content contains every prose fragment across the tool loop. Keeping its first 1,600
 * characters routinely saved "I will inspect..." and discarded the file-by-file summary the
 * fixer deliberately put at the end. Preserve the tail and say how much earlier material moved
 * out of the handoff.
 */
export const clipHandoff = (text: string, max = NOTE_LIMIT): string => {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const tail = clean.slice(-max).trimStart();
  return `…[${clean.length - tail.length} earlier characters omitted]\n${tail}`;
};

const section = (heading: string, body: string) => (body.trim() ? `\n\n## ${heading}\n\n${body.trim()}` : '');

/** What the agent is told, built fresh on every fetch so it always reflects the current file. */
function describe(item: SnitchItem, project: ProjectDetail): string {
  const label = item.kind === 'issue' ? 'severity' : 'priority';
  const header =
    `Project: ${project.name}\n` +
    `Item: ${item.id} (${item.kind}, ${label} ${item.value})\n` +
    `Working directory: ${project.repo ?? 'a scratch workspace — this project has no repository set'}`;

  const report =
    header +
    section('Report', item.description) +
    (item.steps.length
      ? `\n\n## Steps to reproduce\n\n${item.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`
      : '') +
    section('Expected behavior', item.expected) +
    section('Actual behavior', item.actual);

  if (item.pipeline.stage === 'qa') {
    return (
      `You are the QA pass for ${item.id}. The fix has already been attempted; your job is to ` +
      `check it, not to redo it.` +
      section('What the fix attempt reported', item.pipeline.note ?? '(the fix run said nothing)') +
      `\n\n---\n\n${report}` +
      section(
        'What this run must do',
        'Read the code that the fix touched and judge whether the reported behaviour is actually ' +
          'fixed. Check the expected behaviour above against what the code now does, and look for ' +
          'anything the change obviously broke on its way past. Do not rewrite the fix — if it is ' +
          'wrong, say what is wrong.\n\n' +
          'End your final message with exactly one line, on its own:\n\n' +
          '`QA: PASS` — the reported behaviour is fixed.\n' +
          '`QA: FAIL — <one sentence>` — it is not, and this is what is still wrong.\n\n' +
          'A run with no verdict line counts as a fail.'
      )
    );
  }

  const priorFeedback =
    item.pipeline.attempt > 0 && item.pipeline.note
      ? section(
          `Why attempt ${item.pipeline.attempt} came back`,
          `QA rejected the previous fix:\n\n${item.pipeline.note}\n\nDo not repeat it.`
        )
      : '';

  return (
    report +
    priorFeedback +
    section(
      'What this run must do',
      'Fix this, in the working directory above. Read the code that produces the behaviour before ' +
        'changing it, and make the smallest change that actually fixes it.\n\n' +
        'Finish with a short summary of what you changed, file by file, and what a reviewer should ' +
        'look at to confirm it. A QA pass reads only that summary and the code, so leave nothing ' +
        'important out of it.'
    )
  );
}

function toIssue(project: ProjectDetail, item: SnitchItem): Issue {
  // `queued` is only the UI's pre-start state for a fixing run. The tracker id must stay stable
  // when onTurnStart flips it to `fixing`, otherwise reconciliation thinks the live worker
  // vanished at its very first poll and aborts it as inactive.
  const ownedStage: PipelineStage = item.pipeline.stage === 'queued' ? 'fixing' : item.pipeline.stage;
  return {
    id: encodeIssueId(project.name, item.id, ownedStage, item.pipeline.generation),
    identifier: item.id,
    title: item.title,
    description: describe(item, project),
    priority: PRIORITY[item.value],
    state: stateFor(item.pipeline.stage),
    branchName: null,
    url: null,
    labels: [item.kind, item.value, `stage:${item.pipeline.stage}`],
    blockedBy: [],
    createdAt: Date.parse(item.created) || null,
    updatedAt: Date.parse(item.updated) || null,
  };
}

export class Pipeline implements Tracker {
  /** The first UI snapshot after a process restart is the safe point to wake persisted work. */
  private resumeChecked = false;

  constructor(private readonly deps: PipelineDeps) {}

  // -------------------------------------------------------------------------
  // Tracker (spec §11.1)
  // -------------------------------------------------------------------------

  private rows(): Issue[] {
    return store.activeItems().map(({ project, item }) => toIssue(project, item));
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return store
      .activeItems()
      .filter(({ item }) => isActiveStage(item.pipeline.stage))
      .map(({ project, item }) => toIssue(project, item));
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    return this.rows().filter((issue) => wanted.has(issue.state.toLowerCase()));
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Map<string, string>> {
    const wanted = new Set(ids);
    const states = new Map<string, string>();
    for (const issue of this.rows()) {
      if (wanted.has(issue.id)) states.set(issue.id, issue.state);
    }
    return states;
  }

  // -------------------------------------------------------------------------
  // One-click dispatch
  // -------------------------------------------------------------------------

  /** Puts an item in the queue and pokes the orchestrator. This is the whole "Fix it" button. */
  dispatch(project: string, itemId: string): PipelineEntry[] {
    const item = store.findItem(project, itemId);
    if (!item) throw new Error(`No item ${itemId} in ${project}.`);
    if (isActiveStage(item.pipeline.stage)) return this.snapshot();

    // This is live work, not recovery. dispatch() wakes it explicitly below, so its returned
    // snapshot must not also describe the item as one restored from a previous process.
    this.resumeChecked = true;
    store.setPipeline(project, itemId, {
      stage: 'queued',
      generation: item.pipeline.generation + 1,
      attempt: 0,
      failures: 0,
      note: null,
    }, 'in_progress');
    this.deps.log({ level: 'info', message: `queued for fixing`, itemId, stage: 'queued', attempt: 0 });
    this.deps.wake();
    return this.snapshot();
  }

  /** Takes an item back out. A run already in flight is stopped by reconciliation (§8.5). */
  cancel(project: string, itemId: string): PipelineEntry[] {
    const item = store.findItem(project, itemId);
    if (!item) throw new Error(`No item ${itemId} in ${project}.`);

    store.setPipeline(project, itemId, {
      stage: 'idle',
      generation: item.pipeline.generation + 1,
      failures: 0,
      note: 'Cancelled.',
    }, 'open');
    this.deps.log({ level: 'info', message: 'cancelled', itemId });
    this.deps.wake();
    return this.snapshot();
  }

  // -------------------------------------------------------------------------
  // Stage machine, driven by the runner's turn hooks
  // -------------------------------------------------------------------------

  /** A queued item becomes a running one only once a turn actually starts. */
  onTurnStart(issueId: string): void {
    const ref = decodeIssueId(issueId);
    if (!ref) return;

    const item = store.findItem(ref.project, ref.itemId);
    if (item?.pipeline.stage === 'queued' && item.pipeline.generation === ref.generation) {
      store.setPipeline(ref.project, ref.itemId, { stage: 'fixing' });
      this.deps.log({
        level: 'info',
        message: 'fixing started',
        itemId: ref.itemId,
        previousStage: 'queued',
        stage: 'fixing',
        attempt: item.pipeline.attempt,
      });
    }
  }

  onTurnEnd(issueId: string, result: TurnResult): void {
    const ref = decodeIssueId(issueId);
    if (!ref) return;

    const item = store.findItem(ref.project, ref.itemId);
    if (!item || item.pipeline.generation !== ref.generation || result.cancelled) return;
    if (!isActiveStage(item.pipeline.stage) || item.pipeline.stage !== ref.stage) return;

    if (!result.ok) return this.recordFailure(ref.project, item, issueId, result.error ?? 'the run failed');

    if (item.pipeline.stage === 'qa') this.settleQa(ref.project, item, result);
    else this.settleFix(ref.project, item, result);
  }

  private settleFix(project: string, item: SnitchItem, result: TurnResult): void {
    store.setPipeline(project, item.id, {
      stage: 'qa',
      failures: 0,
      note: clipHandoff(result.content) || 'The fix run reported nothing.',
    });
    this.deps.log({
      level: 'info',
      message: 'fix finished; queued for QA',
      itemId: item.id,
      previousStage: item.pipeline.stage,
      stage: 'qa',
      attempt: item.pipeline.attempt,
      runId: result.runId,
      sessionId: result.sessionId,
      rounds: result.rounds,
      toolCalls: result.toolCalls,
      reason: result.reason,
    });
    this.deps.wake();
  }

  private settleQa(project: string, item: SnitchItem, result: TurnResult): void {
    const verdict = readVerdict(result.content);

    if (verdict.pass) {
      store.setPipeline(project, item.id, { stage: 'verified', failures: 0, note: verdict.note }, 'resolved');
      this.deps.log({
        level: 'info',
        message: `QA passed: ${verdict.note}`,
        itemId: item.id,
        previousStage: 'qa',
        stage: 'verified',
        attempt: item.pipeline.attempt,
        runId: result.runId,
        sessionId: result.sessionId,
        rounds: result.rounds,
        toolCalls: result.toolCalls,
        reason: result.reason,
      });
      return;
    }

    const attempt = item.pipeline.attempt + 1;
    if (attempt >= MAX_CYCLES) {
      store.setPipeline(project, item.id, {
        stage: 'failed',
        attempt,
        failures: 0,
        note: `QA failed ${attempt} times. Last verdict: ${verdict.note}`,
      });
      this.deps.log({
        level: 'warn',
        message: `gave up after ${attempt} QA failures`,
        itemId: item.id,
        previousStage: 'qa',
        stage: 'failed',
        attempt,
        runId: result.runId,
        sessionId: result.sessionId,
        rounds: result.rounds,
        toolCalls: result.toolCalls,
        reason: result.reason,
      });
      return;
    }

    store.setPipeline(project, item.id, { stage: 'fixing', attempt, failures: 0, note: verdict.note });
    this.deps.log({
      level: 'warn',
      message: `QA failed; re-fixing (attempt ${attempt}): ${verdict.note}`,
      itemId: item.id,
      previousStage: 'qa',
      stage: 'fixing',
      attempt,
      runId: result.runId,
      sessionId: result.sessionId,
      rounds: result.rounds,
      toolCalls: result.toolCalls,
      reason: result.reason,
    });
    this.deps.wake();
  }

  /**
   * An errored turn is the orchestrator's business first — it retries with backoff — so this
   * only counts, and only steps in once the same stage has failed too many times to be worth
   * retrying forever.
   */
  private recordFailure(project: string, item: SnitchItem, issueId: string, error: string): void {
    const count = item.pipeline.failures + 1;

    if (count < MAX_STAGE_FAILURES) {
      store.setPipeline(project, item.id, {
        failures: count,
        note: `${item.pipeline.stage} attempt failed (${count}/${MAX_STAGE_FAILURES}): ${clipHandoff(error, 400)}`,
      });
      this.deps.log({
        level: 'warn',
        message: `${item.pipeline.stage} attempt failed (${count}): ${error}`,
        itemId: item.id,
        stage: item.pipeline.stage,
        attempt: item.pipeline.attempt,
      });
      return;
    }

    store.setPipeline(project, item.id, {
      stage: 'failed',
      failures: count,
      note: `The ${item.pipeline.stage} stage failed ${count} times. Last error: ${clipHandoff(error, 400)}`,
    });
    this.deps.log({
      level: 'error',
      message: `gave up after ${count} failed runs: ${error}`,
      itemId: item.id,
      previousStage: item.pipeline.stage,
      stage: 'failed',
      attempt: item.pipeline.attempt,
      failures: count,
    });
  }

  /** Everything in flight, for the pipeline tool window. */
  snapshot(): PipelineEntry[] {
    const entries = store.activeItems().map(({ project, item }) => ({
      project: project.name,
      itemId: item.id,
      title: item.title,
      kind: item.kind,
      stage: item.pipeline.stage,
      attempt: item.pipeline.attempt,
      failures: item.pipeline.failures,
      note: item.pipeline.note,
      updatedAt: item.pipeline.updatedAt,
      repo: project.repo,
    }));
    // Pipeline stage lives in the item files, while wake timers are process-local. The renderer
    // asks for this snapshot as it starts, after providers and the main window are ready; use that
    // first safe observation to restore work that survived an app restart.
    if (!this.resumeChecked) {
      this.resumeChecked = true;
      const pending = entries.filter((entry) => isActiveStage(entry.stage));
      if (pending.length) {
        this.deps.log({
          level: 'info',
          message: `resuming ${pending.length} persisted pipeline item${pending.length === 1 ? '' : 's'}`,
        });
        this.deps.wake();
      }
    }
    return entries;
  }

  /** Clears a finished or failed dispatch out of the list without touching the item itself. */
  acknowledge(project: string, itemId: string): PipelineEntry[] {
    const item = store.findItem(project, itemId);
    if (item && !isActiveStage(item.pipeline.stage)) store.clearPipeline(project, itemId);
    return this.snapshot();
  }
}

/**
 * Reads the QA verdict off the end of a transcript. The last verdict line wins, because a model
 * that reasons out loud about what a fail would look like still has to commit at the end.
 */
export function readVerdict(content: string): { pass: boolean; note: string } {
  const matches = [...content.matchAll(/^[^\S\n]*`?QA:\s*(PASS|FAIL)\b`?[^\S\n]*[—:-]?[^\S\n]*(.*)$/gim)];
  const last = matches[matches.length - 1];

  if (!last) return { pass: false, note: 'The QA run ended without a verdict line.' };

  const pass = last[1].toUpperCase() === 'PASS';
  const reason = last[2].replace(/`/g, '').trim();
  return { pass, note: reason || (pass ? 'Verified.' : 'No reason given.') };
}
