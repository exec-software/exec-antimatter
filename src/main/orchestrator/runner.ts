import type { AccessMode, ThinkingLevel, Message, ToolDefinition } from '../../api/types';
import { fitToBudget } from '../context';
import * as mcp from '../mcp';
import { projectInstructions } from '../memory/context';
import { instructionAllowance } from '../memory/instructions';
import { mergeInstructions, withSituation } from '../prompt';
import {
  runToolLoop,
  type StopReason,
  type StreamingProvider,
  type ToolActivity,
  type ToolRuntime,
} from '../toolLoop';
import { allowedUnattended, tierOf } from '../toolPolicy';
import type { ServiceConfig } from './config';
import type { AgentJob, LogEvent } from './orchestrator';
import { FALLBACK_PROMPT, renderPrompt } from './workflow';
import { assertRunnableIn } from './workspace';
import { OrchestratorError, type Issue } from './types';

/**
 * The agent runner (spec §10, §12), implemented against Antimatter itself.
 *
 * The specification launches a separate coding-agent app-server over stdio. Antimatter *is* the
 * coding agent, so a turn is a run of our own tool loop instead of a subprocess: same prompt
 * assembly, same continuation semantics, same per-issue workspace, no protocol in between.
 *
 * Approval policy (§10.5 requires one to be documented, and forbids hanging):
 *
 *   default                    read and write tools run; anything that executes commands or
 *                              posts outward is refused, and the model is told why.
 *   approval_policy: never     everything the tool policy allows runs unattended.
 *
 * Nobody is watching an orchestrated run, so it never waits on a human — it answers its own
 * approvals and records each decision.
 */

export interface ProviderChoice {
  provider: StreamingProvider;
  providerId: string;
  model: string;
  /** Model-specific standing brief from the central Model Library. */
  instructions?: string;
  /** From the model's profile, so an unattended run is bounded by the model, not by a constant. */
  maxOutputTokens: number;
  thinkingLevel?: ThinkingLevel;
  /** From the model's profile: the widest batch one of its replies may ask for. */
  maxToolCalls?: number;
  /** Prompt-side budget after reserving output and tool headroom. */
  budgetTokens: number;
  /** Recomputes the prompt budget from the definitions offered on this exact round. */
  budgetForTools?(tools: readonly ToolDefinition[]): number;
}

/** Stable identity and policy facts attached to every record emitted for one runner turn. */
export interface RunnerTurnContext {
  runId: string;
  sessionId: string;
  turn: number;
  attempt: number | null;
  providerId: string;
  model: string;
  accessMode: AccessMode;
  workspace: string;
  startedAt: number;
}

/**
 * The expanded conversation at an atomic tool-loop checkpoint.
 *
 * Visible stream text is not enough to audit or resume an agent: the decisions are in the
 * assistant tool calls and their tool results. This callback carries exactly the transcript the
 * model has seen, at the same safe checkpoints the interactive transcript store uses.
 */
export interface RunnerTranscriptSnapshot extends RunnerTurnContext {
  content: string;
  messages: Message[];
}

/** A complete, persistence-ready account of how one turn ended. */
export interface RunnerTurnResult extends RunnerTranscriptSnapshot {
  ok: boolean;
  /** True when reconciliation or app shutdown deliberately stopped this turn. */
  cancelled: boolean;
  endedAt: number;
  rounds: number;
  toolCalls: number;
  reason: StopReason | 'error';
  error?: string;
}

export interface RunnerDeps {
  /** Picks the provider and model for a run, honouring any pin in the workflow. */
  resolveProvider(config: ServiceConfig): ProviderChoice;
  /** Test seam for the MCP runtime; production uses the globally leased runtime. */
  toolRuntime?: ToolRuntime;
  createRuntime?(workspace: string, signal?: AbortSignal): Promise<mcp.WorkspaceRuntime>;
  augmentRuntime?(runtime: ToolRuntime, workspace: string): ToolRuntime;
  additionalInstructions?(workspace: string): string;
  onActivity(activity: ToolActivity): void;
  onContent(runId: string, chunk: string): void;
  log(event: LogEvent): void;
  /** A turn is about to stream. Lets a multi-stage pipeline mark the work as actually started. */
  onTurnStart?(issue: Issue, attempt: number | null, context: RunnerTurnContext): void;
  /** Expanded transcript checkpoints, suitable for durable audit/Carbon storage. */
  onTranscript?(issue: Issue, snapshot: RunnerTranscriptSnapshot): void;
  /**
   * How the turn ended, before the orchestrator sees it. The pipeline that dispatched the issue
   * reads the transcript here — a QA verdict is in the text, not in the exit status — and
   * decides what the next stage is. Errors are reported and then rethrown unchanged, so the
   * orchestrator's own retry and backoff are untouched.
   */
  onTurnEnd?(issue: Issue, result: RunnerTurnResult): void;
}

/** §12.2 — the template sees a plain object, with keys the prompt can reach by dot path. */
const templateView = (issue: Issue): Record<string, unknown> => ({
  id: issue.id,
  identifier: issue.identifier,
  title: issue.title,
  description: issue.description ?? '',
  priority: issue.priority,
  state: issue.state,
  branchName: issue.branchName ?? '',
  url: issue.url ?? '',
  labels: issue.labels,
  blockedBy: issue.blockedBy.map((blocker) => ({ ...blocker })),
});

/**
 * §7.1 — the first turn carries the whole task. Continuation turns must not resend it: the
 * thread already holds it, and repeating it invites the model to start over.
 */
const continuationGuidance = (issue: Issue, turn: number): string =>
  `Continue working ${issue.identifier}. This is turn ${turn} in the same session; the task and everything ` +
  `you have already done are above. Check what is actually finished before doing more, then either ` +
  `carry on or state plainly that it is done or blocked.`;

/** A QA stage is an auditor: prompt wording is not a permission boundary. */
export const isQaIssue = (issue: Issue): boolean =>
  issue.state.trim().toLowerCase() === 'qa' || issue.labels.some((label) => label.trim().toLowerCase() === 'stage:qa');

export function createRunner(deps: RunnerDeps): (job: AgentJob) => Promise<void> {
  return async function runAgent(job: AgentJob): Promise<void> {
    const { issue, workspace, config, attempt } = job;

    // §9.5 invariant 1 — refuse to work anywhere but this issue's own workspace.
    assertRunnableIn(workspace, workspace.path);
    const choice = deps.resolveProvider(config);
    const qa = isQaIssue(issue);
    const mode: AccessMode = qa ? 'read' : config.runner.approvalPolicy === 'never' ? 'full' : 'ask';
    const toolAllowed = (toolName: string, serverId: string): boolean =>
      allowedUnattended(toolName, serverId) && (!qa || tierOf(toolName, serverId) === 'read');
    const threadId = `${issue.id}-${attempt ?? 0}-${Date.now().toString(36)}`;
    const ownedRuntime = deps.toolRuntime ? null : await (deps.createRuntime ?? mcp.createWorkspaceRuntime)(workspace.path, job.signal);
    const baseRuntime = deps.toolRuntime ?? ownedRuntime!;

    try {
      const runtime = deps.augmentRuntime?.(baseRuntime, workspace.path) ?? baseRuntime;
      // A Snitch fix runs in the project's own checkout, and that checkout's AGENTS.md is written for
      // exactly this: someone arriving to change the code without having been told how it is done.
      const rules = projectInstructions(workspace.path, instructionAllowance(choice.budgetTokens));
      const system = withSituation(mergeInstructions(choice.instructions, rules, deps.additionalInstructions?.(workspace.path)), {
        workspace: workspace.path,
        workspaceConfirmed: true,
        mode,
        tools: runtime
          .enabledTools()
          .filter((entry) => toolAllowed(entry.tool.name, entry.serverId))
          .map((entry) => entry.tool.name),
        maxOutputTokens: choice.maxOutputTokens,
      });
      let transcript: Message[] | null = null;

      for (let turn = 1; turn <= config.agent.maxTurns; turn += 1) {
      const turnId = `${threadId}-turn-${turn}`;
      const sessionId = `${threadId}-${turn}`;
      const prompt =
        turn > 1
          ? continuationGuidance(issue, turn)
          : job.promptTemplate.trim()
            ? renderPrompt(job.promptTemplate, templateView(issue), attempt)
            : `${FALLBACK_PROMPT}\n\n${issue.identifier}: ${issue.title}\n\n${issue.description ?? ''}`;
      const messages: Message[] = transcript
        ? [...transcript, { id: `${turnId}-user`, role: 'user', content: prompt }]
        : [
            { id: `${threadId}-system`, role: 'system', content: system },
            { id: `${turnId}-user`, role: 'user', content: prompt },
          ];

      const startedAt = Date.now();
      const context: RunnerTurnContext = {
        runId: turnId,
        sessionId,
        turn,
        attempt,
        providerId: choice.providerId,
        model: choice.model,
        accessMode: mode,
        workspace: workspace.path,
        startedAt,
      };
      let streamedContent = '';
      let latestTranscript = [...messages];

      job.touch('turn_started', turn);
      deps.onTurnStart?.(issue, attempt, context);
      deps.log({
        level: 'info',
        message: `turn started turn=${turn} model=${choice.model} mode=${mode} workspace=${workspace.path}`,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        sessionId,
        runId: turnId,
        turn,
        attempt,
        providerId: choice.providerId,
        model: choice.model,
        accessMode: mode,
        qaReadOnly: qa,
        startedAt,
      });

      const turnController = new AbortController();
      let timedOut = false;
      const cancel = () => turnController.abort();
      if (job.signal.aborted) cancel();
      else job.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        turnController.abort();
      }, config.runner.turnTimeoutMs);

      let result;
      try {
        result = await runToolLoop({
          provider: choice.provider,
          request: {
            messages,
            model: choice.model,
            providerId: choice.providerId,
            requestId: turnId,
            responseMessageId: `${turnId}-assistant`,
            maxTokens: choice.maxOutputTokens,
            thinkingLevel: choice.thinkingLevel,
            maxToolCalls: choice.maxToolCalls,
            accessMode: mode,
            useTools: true,
          },
          runId: turnId,
          mode,
          signal: turnController.signal,
          workspace: workspace.path,
          workspaceConfirmed: true,
          requireToolCall: true,
          fit: (conversation, tools) =>
            fitToBudget(conversation, choice.budgetForTools?.(tools) ?? choice.budgetTokens),
          toolFilter: toolAllowed,
          toolRuntime: runtime,
          // Every chunk and every tool transition is a sign of life; reconcile() reads these.
          onContent: (chunk) => {
            streamedContent += chunk;
            job.touch('content', turn);
            deps.onContent(turnId, chunk);
          },
          onTranscript: (next) => {
            latestTranscript = [...next];
            deps.onTranscript?.(issue, {
              ...context,
              content: streamedContent,
              messages: latestTranscript,
            });
          },
          onCompaction: (event) => {
            job.touch('compaction', turn);
            deps.log({
              level: 'info',
              message:
                `context compacted round=${event.round + 1} removed=${event.compacted} ` +
                `represented=${event.noticePersisted ? event.totalCompacted : 0} ` +
                `marker=${event.noticePersisted ? 'persisted' : 'omitted'}`,
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              sessionId,
              runId: turnId,
              turn,
              attempt,
              providerId: choice.providerId,
              model: choice.model,
              compacted: event.compacted,
              totalCompacted: event.totalCompacted,
              budgetTokens: event.budgetTokens,
              estimatedTokens: event.estimatedTokens,
              overflowTokens: event.overflowTokens,
            });
          },
          onAlive: () => job.touch('alive', turn),
          onActivity: (activity) => {
            job.touch(activity.status, turn);
            deps.onActivity(activity);
          },
          // Unattended: answer from policy rather than waiting for a person (§10.5). A command that
          // reaches past the workspace is only asked about because it is the user's call, and no
          // user is here to make it.
          requestApproval: async (activity) => {
            // QA should never reach this path because mutating tools are not offered, but keep
            // the approval boundary defensive too: a read-only run cannot auto-approve a write
            // if a provider fabricates or replays a stale call.
            const approved = mode !== 'read' && !activity.caution && (mode === 'full' || activity.tier !== 'danger');
            deps.log({
              level: approved ? 'info' : 'warn',
              message:
                `${approved ? 'approval_auto_approved' : 'approval_refused'} ${activity.toolName} (${activity.tier})` +
                (activity.caution ? `: ${activity.caution}` : ''),
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              sessionId,
            });
            return approved;
          },
        });
      } catch (error) {
        // A reconciliation stop is deliberate and must not spend the pipeline's persisted failure
        // budget. A stall is different: it is a failed attempt which will otherwise retry forever.
        const stalled = job.signal.aborted && job.signal.reason === 'stalled';
        const failure = timedOut
          ? new OrchestratorError('turn_timeout', `${issue.identifier}: turn ${turn} timed out after ${config.runner.turnTimeoutMs} ms.`)
          : stalled
            ? new OrchestratorError('turn_timeout', `${issue.identifier}: turn ${turn} exceeded the orchestrator stall timeout.`)
            : job.signal.aborted
            ? new OrchestratorError('turn_cancelled', `${issue.identifier}: the orchestrator cancelled turn ${turn}.`)
            : (error as Error);
        const endedAt = Date.now();
        deps.onTurnEnd?.(issue, {
          ...context,
          ok: false,
          cancelled: job.signal.aborted && !stalled,
          content: streamedContent,
          messages: latestTranscript,
          endedAt,
          rounds: 0,
          toolCalls: latestTranscript.filter((message) => message.role === 'tool').length,
          reason: 'error',
          error: failure.message,
        });
        throw failure;
      } finally {
        clearTimeout(timer);
        job.signal.removeEventListener('abort', cancel);
      }

      deps.log({
        level: 'info',
        message: `turn ended turn=${turn} rounds=${result.rounds} toolCalls=${result.toolCalls} chars=${result.content.length}`,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        sessionId,
        runId: turnId,
        turn,
        attempt,
        providerId: choice.providerId,
        model: choice.model,
        accessMode: mode,
        reason: result.reason,
        rounds: result.rounds,
        toolCalls: result.toolCalls,
        transcriptMessages: result.transcript.length,
        startedAt,
        endedAt: Date.now(),
      });

      const failure =
        result.reason === 'stalled'
          ? new OrchestratorError('turn_failed', `${issue.identifier}: the agent repeated the same tool call without progress.`)
          : result.reason === 'no-progress'
            ? new OrchestratorError('turn_failed', `${issue.identifier}: the agent repeated completion claims without productive tool work.`)
          : result.reason === 'flooding'
          ? new OrchestratorError('turn_failed', `${issue.identifier}: every reply asked for more tool calls than one reply may carry.`)
          : result.reason === 'truncated'
            ? new OrchestratorError('turn_failed', `${issue.identifier}: the model reached its output limit before answering.`)
          : result.stoppedAtLimit
            ? new OrchestratorError('turn_timeout', `${issue.identifier}: the tool loop reached its round ceiling.`)
            : null;

      const endedAt = Date.now();
      deps.onTurnEnd?.(issue, {
        ...context,
        ok: !failure,
        cancelled: false,
        content: result.content,
        messages: result.transcript,
        endedAt,
        rounds: result.rounds,
        toolCalls: result.toolCalls,
        reason: result.reason,
        ...(failure ? { error: failure.message } : {}),
      });
      if (failure) throw failure;

      transcript = result.transcript;
      // The tracker is authoritative after every normal turn, including the last allowed one.
      // A terminal transition there is what marks this workspace for cleanup before the worker
      // exits; short-circuiting on maxTurns used to strand it until the next app restart.
      const shouldContinue = await job.shouldContinue();
      if (turn >= config.agent.maxTurns || !shouldContinue) return;
      }
    } finally {
      await ownedRuntime?.shutdown();
    }
  };
}
