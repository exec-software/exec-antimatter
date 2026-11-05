import { randomUUID } from 'node:crypto';
import type { AccessMode, ThinkingLevel, ToolDefinition } from '../../api/types';
import * as carbon from '../carbon';
import * as mcp from '../mcp';
import { fitToBudget } from '../context';
import { projectInstructions } from '../memory/context';
import { instructionAllowance } from '../memory/instructions';
import { mergeInstructions, withSituation } from '../prompt';
import { runToolLoop, type StreamingProvider, type ToolActivity, type ToolRuntime } from '../toolLoop';
import { allowedUnattended, isTrustedTool } from '../toolPolicy';
import * as profiles from './profiles';
import * as registry from './registry';
import * as tasks from './tasks';
import * as transcripts from './transcripts';
import type { AgentDefinition, Task } from './types';

/**
 * Dispatching an agent.
 *
 * A run is one pass of the same tool loop the chat window uses, with three things swapped: the
 * agent's standing brief goes in front of the task, its allowlist narrows the toolset, and the
 * transcript is written to a carbon instead of a window. That last part is what makes a session
 * openable afterwards — there is no separate log format to invent, and a run that finished
 * yesterday reads exactly like a chat.
 *
 * Queue tasks run one at a time, while every run owns an isolated workspace-bound tool runtime.
 * That keeps a background task independent from interactive chat and orchestrator workers.
 */

export interface ProviderChoice {
  provider: StreamingProvider;
  providerId: string;
  model: string;
  /** Model-specific standing brief from the central Model Library. */
  instructions?: string;
  maxOutputTokens: number;
  thinkingLevel?: ThinkingLevel;
  /** From the model's profile: the widest batch one of its replies may ask for. */
  maxToolCalls?: number;
  /** What is left of the window for the prompt, so a long run can be trimmed back into it. */
  budgetTokens: number;
  /** Recomputes that budget from the definitions actually offered on a particular round. */
  budgetForTools?(tools: readonly ToolDefinition[]): number;
  sourceName: string;
}

/**
 * How a run ended, for whoever was waiting on it.
 *
 * The queue already records the shape of a run — rounds, tool calls, whether it failed. A
 * conversation that handed over its turn needs the other half: what the agent actually wrote.
 */
export interface TaskResult {
  agentName: string;
  /** Everything the agent wrote. Empty when it failed before writing anything. */
  content: string;
  /**
   * What it wrote after its last action: its report. The notes it wrote between calls ("Let me
   * read the file.") are how it got there, and read as noise to whoever asked for the work.
   * Empty when it ended on an action, and then `content` is all there is.
   */
  answer: string;
  /** Why it stopped, when that was not simply finishing. */
  ending: string | null;
  /** Rounds and tool calls, in the same words the queue uses. Null when it never started. */
  summary: string | null;
  /** The run's own carbon, when it got far enough to open one. */
  carbonId: string | null;
}

/**
 * What a caller running a task itself may change about the run.
 *
 * A chat turn that hands work to an agent is still open: its permissions bound the agent's, its
 * person is there to answer approval prompts, and stopping the turn stops the agent too.
 */
export interface RunOverrides {
  /** Exact calling conversation choice; never inherit another window's last-used model. */
  parentModel?: { providerId: string; model: string };
  /** Replaces the agent's own access for this run. The caller is responsible for never raising it. */
  mode?: AccessMode;
  currentMode?: () => AccessMode;
  onAccessChange?: (listener: () => void) => () => void;
  /**
   * Whether a screen capture may run without asking. Absent for a run nobody is watching, which is
   * the reading that asks — and an unwatched run has no one to ask, so it refuses.
   */
  screenCaptureWithoutAsking?: () => boolean;
  machineWideWithoutAsking?: () => boolean;
  workspaceConfirmed?: boolean;
  /** Aborting it stops the run, as the Stop button does. */
  signal?: AbortSignal;
  /** Who answers an approval prompt. Absent means nobody is watching, so the call is refused. */
  requestApproval?(activity: ToolActivity, signal?: AbortSignal): Promise<boolean>;
  /** Sees every tool event after the runner has, with its position in the run's text. */
  onActivity?(activity: ToolActivity): void;
}

export interface RunnerDeps {
  /** Resolves the agent's preferred source and model, falling back to whatever chat would use. */
  resolveProvider(providerName: string | null, model: string | null, workload?: string | null): ProviderChoice | null;
  /**
   * Whether a model can perceive — see a picture, hear audio — as its source reports it.
   *
   * A chat child may inherit its conversation's model in place of a profile role, but not when
   * that role's model can perceive and the conversation's cannot: an image or audio agent sent to
   * a text-only model loses the one thing its role was bound for. Absent means the caller cannot
   * say, and inheritance is the answer.
   */
  perceives?(model: string): boolean;
  /** The workspace to use when neither the task nor the agent names one. */
  defaultWorkspace(): string;
  /** Whether that inherited workspace is one a person actually nominated. */
  defaultWorkspaceConfirmed(): boolean;
  onActivity(activity: ToolActivity & { sessionId: string; revision: number }): void;
  /** Streamed text, so a session can be watched live rather than only read afterwards. */
  onContent(taskId: string, chunk: string, sessionId: string, revision: number, contentOffset: number): void;
  /** Something in the queue changed: a claim, a result, a new due time. */
  onChange(): void;
  /**
   * A run is over, however it ended. Called for every terminal outcome, including the ones that
   * never reach the model: a turn that is waiting on this task has to hear "no agent by that
   * name" as reliably as it hears an answer, or it waits for one that is never coming.
   */
  onResult(task: Task, result: TaskResult): void;
  /** Where a run gets its tools. Tests supply their own; the app uses the MCP servers. */
  createRuntime?(workspace: string, signal: AbortSignal): Promise<RunRuntime>;
  /** App-owned progressive skill reader, without broadening this agent's permissions. */
  augmentRuntime?(runtime: ToolRuntime, workspace: string, context?: { interactive: boolean; threadId?: string; taskId?: string; agentName?: string }): ToolRuntime;
  additionalInstructions?(workspace: string): string;
}

/** The tools one run owns for its lifetime. */
export type RunRuntime = ToolRuntime & { shutdown(): Promise<void> };

let deps: RunnerDeps | null = null;
let pumping = false;
let shuttingDown = false;
const cancels = new Map<string, AbortController>();
const guidance = new Map<string, { queued: string[]; interrupt: AbortController }>();

/** Guide a live agent at a tool boundary, optionally interrupting only its current generation. */
export function sendMessage(taskId: string, message: string, immediately = false): void {
  const text = message.trim();
  if (!text || text.length > 12_000) throw new Error('Agent guidance must contain 1–12,000 characters.');
  if (tasks.find(taskId)?.state !== 'running') throw new Error('This agent is not running. Start a new task for follow-up work.');
  // A parent may guide the task in the same batch that started it, before its deferred launch.
  const mailbox = guidance.get(taskId) ?? { queued: [], interrupt: new AbortController() };
  guidance.set(taskId, mailbox);
  mailbox.queued.push(text);
  if (immediately) mailbox.interrupt.abort();
}

export function configure(next: RunnerDeps): void {
  deps = next;
  shuttingDown = false;
  tasks.onChange(() => {
    for (const taskId of guidance.keys()) if (tasks.find(taskId)?.state !== 'running') guidance.delete(taskId);
    next.onChange();
  });
}

/** True while a task is being worked, which is what the Agents view counts. */
export const busy = (): boolean => pumping;

export function stop(taskId: string): void {
  cancels.get(taskId)?.abort();
  tasks.cancel(taskId);
}

/** Abort live work and make it resumable on the next launch instead of stranding `running`. */
export function shutdown(): void {
  shuttingDown = true;
  for (const controller of cancels.values()) controller.abort();
  cancels.clear();
  tasks.requeueRunning();
}

/** The brief the model actually receives: who it is, then what it was asked for. */
function compose(agent: AgentDefinition, task: Task, workspace: string): string {
  return [
    agent.prompt.trim(),
    '',
    `You are working in ${workspace}.`,
    '',
    // An agent that does not know its budget cannot spend it. Left unsaid, a model with fourteen
    // rounds available stops after seven and offers to continue if asked — but nobody is there to
    // ask, so the offer is where the work ends. Told there was no reason to stop short of the
    // budget, though, a shell runner asked for a Python version ran pip list four ways and was
    // stopped at its ceiling with the answer long since in hand. Done is what ends a run.
    `This run allows at most ${agent.maxRounds} rounds of tool calls, and reaching the last one ends ` +
      `the run wherever it stands. Answer as soon as the task is done: a reply with no tool call ends ` +
      `the run, and that reply is your report. Do not stop before the task is done, either: nobody is ` +
      `there to ask you to continue.`,
    '',
    `## Task: ${task.title}`,
    '',
    task.prompt.trim(),
  ].join('\n');
}

async function runTask(task: Task, overrides: RunOverrides = {}): Promise<TaskResult> {
  if (!deps) throw new Error('the agent runner has no dependencies yet');

  // start_agent returns before launching. A stop in that interval must not start inference or tools.
  if (overrides.signal?.aborted || tasks.find(task.id)?.state !== 'running') {
    tasks.cancel(task.id);
    return { agentName: task.agentId, content: '', answer: '', ending: 'the task was stopped', summary: null, carbonId: null };
  }

  const agent = registry.find(task.agentId);
  if (!agent) {
    const missing = `no agent named ${task.agentId} is installed`;
    tasks.settle(task.id, { ok: false, error: missing });
    const result = { agentName: task.agentId, content: '', answer: '', ending: missing, summary: null, carbonId: null };
    deps.onResult(task, result);
    return result;
  }

  // Which model answers, most specific statement first.
  //
  // An agent that pins its own source or model keeps it: naming a model in the agent's file is a
  // more specific statement than anything a caller or a profile supplies.
  //
  // Next, a child a chat turn started runs on that conversation's model. The turn is open and its
  // source is already serving it; a profile role naming a different source could start a second
  // engine, and the local coder units are kept mutually exclusive on purpose, so the chat's own
  // server would be stopped mid-answer. The conversation is the more specific statement.
  //
  // The exception is a role the conversation's model cannot serve at all. An image or audio agent
  // bound to a model that can perceive must keep that binding: sent to a text-only conversation
  // model it would lose the one thing its role was bound for. So the profile wins when its role
  // can see or hear and the inherited model cannot, and the inherited model wins otherwise — a
  // coder role that merely names another text model would only start a second engine.
  //
  // An unattended run — a schedule, the router — has no chat model to inherit. There the selected
  // orchestration profile is the background-agent policy that supplies the role's model and
  // workload, so a coder writes the patch and a generalist does the rest inside one run.
  const pinned = !!(agent.provider || agent.model);
  const inherits = !pinned ? overrides.parentModel : undefined;
  const profile = pinned ? null : profiles.selected();
  const binding = profile ? profiles.bindingFor(agent, profile) : null;
  const keepsPerception = !!binding && !!inherits &&
    (deps.perceives?.(binding.model) ?? false) && !(deps.perceives?.(inherits.model) ?? false);
  const useInherits = !!inherits && !keepsPerception;
  const useBinding = !!binding && !useInherits;
  let choice: ProviderChoice | null;
  try {
    // The workload travels with the binding that chose the model. An agent pinning its own model,
    // or a child inheriting its parent's, is using a model the role's workload does not belong to.
    choice = deps.resolveProvider(
      useInherits ? inherits!.providerId : agent.provider ?? (useBinding ? binding!.provider : null) ?? null,
      useInherits ? inherits!.model : agent.model ?? (useBinding ? binding!.model : null) ?? null,
      useBinding && !agent.provider && !agent.model ? binding!.workload : null);
  } catch (error) {
    const unavailable = (error as Error).message || String(error);
    tasks.settle(task.id, { ok: false, error: unavailable });
    const result = {
      agentName: agent.name,
      content: '',
      answer: '',
      ending: unavailable,
      summary: null,
      carbonId: null,
    };
    deps.onResult(task, result);
    return result;
  }
  if (!choice) {
    const disconnected = 'no inference source is connected';
    tasks.settle(task.id, { ok: false, error: disconnected });
    const result = { agentName: agent.name, content: '', answer: '', ending: disconnected, summary: null, carbonId: null };
    deps.onResult(task, result);
    return result;
  }

  // A task that names its directory was aimed there deliberately, which is what the write guard
  // wants to know. One that falls back to the shell's directory inherits its standing too — an
  // agent must not be the way a turn gets to write somewhere nobody chose.
  const workspace = task.workspace || deps.defaultWorkspace();
  const chosen = overrides.workspaceConfirmed ?? (!!task.workspace || deps.defaultWorkspaceConfirmed());
  const mode: AccessMode = overrides.currentMode?.() ?? overrides.mode ?? agent.access;

  // A carbon per run, keyed by its own id: two runs of a scheduled task are two sessions.
  const sessionId = randomUUID();
  const record = carbon.ensure({
    threadId: sessionId,
    model: choice.model,
    sourceName: choice.sourceName,
    workspace,
    accessMode: mode,
  });
  transcripts.retain(new Set(tasks.list().map((entry) => entry.id)));
  transcripts.begin(task.id, record.id);
  tasks.update(task.id, { carbonId: record.id });
  // A run done for a conversation — routed there, or handed out by its own model — is part of
  // that conversation, so its record goes into the conversation's carbon as well as its own.
  // Exporting the chat then gives the whole exchange, every tool call included.
  const replyCarbon = task.parent?.threadId ?? task.reply?.threadId ?? null;
  const keep = (entry: carbon.CarbonEntry): void => {
    const recorded = { ...entry, runId: task.id, model: choice.model };
    carbon.add(sessionId, recorded);
    if (replyCarbon) carbon.add(replyCarbon, { ...recorded, label: `${agent.name} · ${entry.label ?? entry.kind}` });
  };
  const note = (text: string): void => keep({ kind: 'note', label: 'note', body: text });
  note(`${agent.name} — ${task.title} (${task.source}); model ${choice.model} on ${choice.sourceName}; carbon ${record.id}`);

  const controller = new AbortController();
  cancels.set(task.id, controller);
  const mailbox = guidance.get(task.id) ?? { queued: [] as string[], interrupt: new AbortController() };
  guidance.set(task.id, mailbox);
  const stopWithCaller = () => controller.abort();
  if (overrides.signal?.aborted) controller.abort();
  else overrides.signal?.addEventListener('abort', stopWithCaller, { once: true });
  // Where each tool event sits in the run's text, the same anchoring the chat window gives its own
  // calls, so a run can be drawn as a transcript rather than as two unrelated lists.
  let written = 0;
  const offsets = new Map<string, number>();
  const allowed = new Set(agent.tools);
  const toolFilter = allowed.size
    ? (name: string, serverId: string) => allowed.has(name) && isTrustedTool(name, serverId)
    : allowedUnattended;
  let runtime: RunRuntime | null = null;

  try {
    runtime = await (deps.createRuntime ?? mcp.createWorkspaceRuntime)(workspace, controller.signal);
    const tooling = deps.augmentRuntime?.(runtime, workspace, {
      interactive: !!overrides.requestApproval,
      threadId: task.parent?.threadId ?? task.reply?.threadId,
      taskId: task.id,
      agentName: agent.name,
    }) ?? runtime;
    const offeredToolNames = tooling
      .enabledTools()
      .filter((entry) => toolFilter(entry.tool.name, entry.serverId))
      .map((entry) => entry.tool.name);
    const prompt = compose(agent, task, workspace);
    // The same grounding interactive chat gets: an unattended agent that decides it cannot run
    // commands fails the task and leaves a transcript that reads like a refusal.
    // The repository's own rules bind an agent working in it as much as the conversation. The
    // conversation's notes stay with the conversation, which writes what the task needs into the brief.
    const rules = projectInstructions(workspace, instructionAllowance(choice.budgetTokens));
    const extra = offeredToolNames.includes('read_skill') ? deps.additionalInstructions?.(workspace) : '';
    const systemPromptForMode = (effectiveMode: AccessMode) => withSituation(mergeInstructions(choice.instructions, rules, extra), {
      workspace,
      workspaceConfirmed: chosen,
      mode: effectiveMode,
      tools: offeredToolNames,
      maxOutputTokens: choice.maxOutputTokens,
    });
    const system = systemPromptForMode(overrides.currentMode?.() ?? mode);

    keep({ kind: 'system', body: system });
    keep({ kind: 'user', body: prompt });
    const result = await runToolLoop({
      provider: choice.provider,
      request: {
        messages: [
          { id: 'system', role: 'system', content: system },
          { id: sessionId, role: 'user', content: prompt },
        ],
        model: choice.model,
        providerId: choice.providerId,
        requestId: sessionId,
        threadId: sessionId,
        maxTokens: choice.maxOutputTokens,
        thinkingLevel: choice.thinkingLevel,
        maxToolCalls: choice.maxToolCalls,
        accessMode: mode,
        useTools: true,
      },
      runId: task.id,
      mode,
      currentMode: overrides.currentMode,
      onAccessChange: overrides.onAccessChange,
      screenCaptureWithoutAsking: overrides.screenCaptureWithoutAsking,
      machineWideWithoutAsking: overrides.machineWideWithoutAsking,
      systemPromptForMode,
      maxRounds: agent.maxRounds,
      signal: controller.signal,
      workspaceConfirmed: chosen,
      workspace,
      // Agents run many rounds by design; their own tool results would otherwise overflow.
      fit: (conversation, tools) =>
        fitToBudget(conversation, choice.budgetForTools?.(tools) ?? choice.budgetTokens),
      toolFilter,
      toolRuntime: tooling,
      requireToolCall: true,
      // Nobody can say "continue" to a background run, so one that is stopped still reports.
      reportWhenStopped: true,
      steer: {
        take: () => mailbox.queued.length ? mailbox.queued.splice(0).join('\n\n') : null,
        pending: () => mailbox.queued.length > 0,
        get interrupt() { return mailbox.interrupt.signal; },
        rearm: () => { if (mailbox.interrupt.signal.aborted) mailbox.interrupt = new AbortController(); },
      },
      onSteer: (text) => keep({ kind: 'user', label: 'Guidance', body: text }),
      onContent: (chunk) => {
        const offset = written;
        written += chunk.length;
        const snapshot = transcripts.append(task.id, chunk);
        deps!.onContent(task.id, chunk, snapshot.sessionId, snapshot.revision, offset);
      },
      onActivity: (activity) => {
        const key = activity.activityId ?? activity.callId;
        if (!offsets.has(key)) offsets.set(key, written);
        const positioned = { ...activity, contentOffset: offsets.get(key) };
        if (activity.status === 'done' || activity.status === 'failed' || activity.status === 'denied') {
          keep({
            kind: 'tool',
            label: activity.toolName,
            body: `args: ${activity.args}\n\n${activity.result ?? ''}`,
          });
        }
        const snapshot = transcripts.activity(task.id, positioned);
        if (activity.status === 'done' || activity.status === 'failed' || activity.status === 'denied') {
          transcripts.persist(task.id);
        }
        deps!.onActivity({ ...positioned, sessionId: snapshot.sessionId, revision: snapshot.revision });
        overrides.onActivity?.(positioned);
      },
      onCompaction: (event) =>
        note(
          `Context compaction folded ${event.compacted} message(s) at round ${event.round + 1}; ` +
            (event.noticePersisted
              ? `${event.totalCompacted} message(s) are represented by the transcript marker.`
              : 'the optional marker was omitted to preserve the current request.')
        ),
      // Unless the caller has someone to ask, an 'ask' decision is a refusal with a reason the
      // model can read and work around. An agent that needs to write says so in its own access mode.
      requestApproval: async (activity, signal) => {
        if (overrides.requestApproval) return overrides.requestApproval(activity, signal);
        note(`${activity.toolName} needed approval; nobody was watching, so it was refused.`);
        return false;
      },
    });

    // Why it ended matters to whoever reads the task later: out of rounds is not the same
    // failure as going round in circles, and neither is the same as finishing.
    const ending =
      result.reason === 'finished'
        ? null
        : result.reason === 'stalled'
          ? 'it kept repeating the same tool call'
          : result.reason === 'no-progress'
            ? 'it repeated completion claims without productive tool work'
          : result.reason === 'flooding'
            ? 'every reply asked for more tool calls than one reply may carry'
            : result.reason === 'truncated'
              ? 'it reached its output limit before writing an answer'
              : `it reached its ${agent.maxRounds}-round ceiling with work still to do`;

    keep({ kind: 'assistant', body: result.content });
    note(`${result.rounds} round(s), ${result.toolCalls} tool call(s)${ending ? `; ended because ${ending}` : ''}.`);
    const summary = `${result.rounds} round(s), ${result.toolCalls} tool call(s)`;
    tasks.settle(task.id, {
      ok: result.reason === 'finished',
      carbonId: record.id,
      summary,
      error: ending ?? undefined,
    });
    // The loop records the round that ended the run as the transcript's last message: an answer,
    // the report of a run it stopped, or a note that no answer came.
    const last = result.transcript[result.transcript.length - 1];
    const answer = last?.role === 'assistant' && !last.toolCalls?.length ? (last.content ?? '').trim() : '';
    const outcome = { agentName: agent.name, content: result.content, answer, ending, summary, carbonId: record.id };
    deps!.onResult(task, outcome);
    return outcome;
  } catch (error) {
    const message = (error as Error).message || String(error);
    note(`failed: ${message}`);
    // Stopped because whoever was waiting stopped: that is a cancellation, not a failure of the
    // agent's. Only the caller's signal counts — a shutdown aborts runs too, and those go back
    // to the queue.
    if (overrides.signal?.aborted) tasks.cancel(task.id);
    tasks.settle(task.id, { ok: false, carbonId: record.id, error: message });
    const outcome = { agentName: agent.name, content: '', answer: '', ending: message, summary: null, carbonId: record.id };
    deps!.onResult(task, outcome);
    return outcome;
  } finally {
    transcripts.persist(task.id);
    overrides.signal?.removeEventListener('abort', stopWithCaller);
    try {
      await runtime?.shutdown();
    } catch (error) {
      console.error('[agents] tool-runtime cleanup failed:', error);
    } finally {
      cancels.delete(task.id);
      guidance.delete(task.id);
    }
  }
}

/**
 * Runs a task now, outside the queue, and resolves with how it ended.
 *
 * For a chat turn that hands work to an agent and waits for it. Several can run at once: every
 * run owns its tool runtime, and the queue's one-at-a-time rule exists for unattended work, which
 * nobody is waiting on. The task must already be marked running (tasks.add with startNow), or the
 * queue's worker could claim it as well.
 */
export async function runNow(task: Task, overrides: RunOverrides = {}): Promise<TaskResult> {
  try {
    return await runTask(task, overrides);
  } finally {
    deps?.onChange();
  }
}

/**
 * Works the queue until nothing is ready. Safe to call from anywhere, as often as you like:
 * a second caller returns immediately rather than starting a second worker.
 */
export async function pump(): Promise<void> {
  if (pumping || !deps || shuttingDown) return;
  pumping = true;
  deps.onChange();

  try {
    for (;;) {
      if (shuttingDown) break;
      const task = tasks.claim();
      if (!task) break;
      try {
        await runTask(task);
      } catch (error) {
        // A failure inside settle or carbon must not strand the queue.
        console.error('[agents] run collapsed:', error);
        tasks.settle(task.id, { ok: false, error: (error as Error).message });
      }
    }
  } finally {
    pumping = false;
    deps.onChange();
  }
}

/** Checks for work that has come due. Called on a timer, so schedules fire without a nudge. */
export const tick = (): void => {
  void pump();
};
