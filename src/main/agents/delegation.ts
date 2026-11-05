import type { AccessMode } from '../../api/types';
import type { McpTool, ToolCallResult } from '../mcp';
import type { BackgroundReport, BackgroundWork, IdleOutcome, ToolActivity, ToolCallOptions, ToolRuntime } from '../toolLoop';
import * as registry from './registry';
import { catalogue } from './router';
import * as runner from './runner';
import * as tasks from './tasks';
import type { AgentDefinition, Task } from './types';

/**
 * Agents as a tool of the conversation's own model.
 *
 * The chat model keeps the conversation. When part of the work belongs to a specialist it calls
 * start_agent, and the agent works alongside it — alone, with its own tools, in the same
 * workspace — while the model gets on with its own part. When the agent finishes, its report is
 * given to the model between steps; if the model cannot go on without it, wait_for_agents holds
 * until it arrives. The turn does not end while an agent it started is still working, so the
 * model that was asked is the one that answers, with every report in front of it.
 *
 * It used to be one call, run_agent, that returned the report. That made the turn stand still for
 * the whole run: asked to review a file and meanwhile fix a typo, the model fixed the typo only
 * once the review was over.
 *
 * The tools are served here rather than by an MCP server because they need the app's own queue,
 * runner and approval prompt — and because an agent must never be offered them. A subagent that
 * can start subagents has no bottom.
 */

export const SERVER_ID = 'antimatter.agents';
export const SERVER_NAME = 'Agents';
export const START_AGENT = 'start_agent';
export const WAIT_FOR_AGENTS = 'wait_for_agents';
export const SEND_AGENT_MESSAGE = 'send_agent_message';
export const STOP_AGENT = 'stop_agent';
/** The transcript's mark for the point where a report reached the model. Never offered as a tool. */
export const AGENT_REPORT = 'agent_report';

/** The longest one wait_for_agents call holds for when it is given a limit. */
const MAX_WAIT_SECONDS = 3600;

/** Which run a start_agent call became, so the conversation can list it and open it. */
export interface SubagentRef {
  taskId: string;
  agentId: string;
  agentName: string;
  title: string;
  /** Set once the run has ended, on the row that started it: its result is then the report. */
  finished?: boolean;
}

export interface DelegationContext {
  /** The assistant message this turn is writing. Its subagents are filed under it. */
  messageId: string;
  threadId: string;
  workspace: string;
  workspaceConfirmed: boolean;
  /** The conversation's permissions. An agent never runs with more than these. */
  mode: AccessMode;
  currentMode?: () => AccessMode;
  onAccessChange?: (listener: () => void) => () => void;
  /** The conversation's standing answer about screen capture; an agent gets no more than it. */
  screenCaptureWithoutAsking?: () => boolean;
  machineWideWithoutAsking?: () => boolean;
  /** The model of this conversation, not a process-global recently selected model. */
  parentModel?: { providerId: string; model: string };
  /** The conversation's approval prompt, so a subagent's question reaches the person watching. */
  requestApproval(activity: ToolActivity, signal?: AbortSignal): Promise<boolean>;
  /** A tool event for the conversation's transcript. */
  report(activity: ToolActivity): void;
}

/** One turn's agents: the tools that start and wait for them, and what the tool loop needs. */
export interface Delegation {
  runtime: ToolRuntime;
  background: BackgroundWork;
  /** Stops every agent still running. The turn that started them is over. */
  stop(): void;
}

const RANK: Record<AccessMode, number> = { read: 0, ask: 1, full: 2 };

/** The lesser of two permissions. */
export const narrower = (a: AccessMode, b: AccessMode): AccessMode => (RANK[a] <= RANK[b] ? a : b);

export function startDefinition(agents: AgentDefinition[]): McpTool {
  return {
    name: START_AGENT,
    description: [
      'Start one of the specialist agents below on a self-contained piece of work. This returns at once and',
      'the agent works alongside you, so carry on with your own part of the job meanwhile. Several can run',
      'at the same time. The agent works in this workspace with only its own tools. It sees nothing of this',
      'conversation except the task you write, and cannot ask you anything, so put everything it needs in',
      'the task.',
      '',
      'When an agent finishes, its report is given to you as a message. If you cannot go on without a',
      'report, call wait_for_agents. Your turn cannot end while an agent you started is still working:',
      'Antimatter waits for it and gives you the report first. You answer the user yourself.',
      'Use send_agent_message to guide a running agent and stop_agent to cancel work that is no longer needed.',
      '',
      'Use an agent for a job its description names, or to get independent pieces done at once. Do small',
      'steps yourself; an agent costs a whole run. Hand off only what you do not need for your own next step,',
      'and do not do the same work yourself while the agent does it.',
      '',
      'Agents:',
      catalogue(agents),
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: agents.map((agent) => agent.id), description: 'The agent, by id.' },
        task: {
          type: 'string',
          description:
            'The whole brief: what to do, where, what you already know, and what to report back. The agent reads nothing else.',
        },
        title: { type: 'string', description: 'A label of six words or fewer, shown to the user while it works.' },
      },
      required: ['agent', 'task'],
    },
    enabled: true,
  };
}

export function waitDefinition(): McpTool {
  return {
    name: WAIT_FOR_AGENTS,
    description:
      'Wait for agents you started with start_agent to finish, and get their reports. Only for when you ' +
      'cannot go on without a report; otherwise keep working, and reports arrive by themselves. The wait ' +
      'also ends when the user sends a message.',
    inputSchema: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Agent ids, or the task ids start_agent gave you. Leave out to wait for every agent still running.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Stop waiting after this long and report what has finished so far. Default: no limit.',
        },
      },
    },
    enabled: true,
  };
}

function controlDefinition(stop: boolean): McpTool {
  return {
    name: stop ? STOP_AGENT : SEND_AGENT_MESSAGE,
    description: stop
      ? 'Stop one agent started by this turn when its work is no longer needed. Its final status is still delivered to you.'
      : 'Send a correction or additional context to one running agent started by this turn. Use its task id when several runs use the same agent. This is not a new task or a message to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The task id returned by start_agent, or an unambiguous agent id.' },
        ...(!stop ? {
          message: { type: 'string', description: 'A concise correction or follow-up for this agent.' },
          interrupt: { type: 'boolean', description: 'Interrupt its current generation to apply the message now. Tools in flight finish safely.' },
        } : {}),
      },
      required: stop ? ['agent'] : ['agent', 'message'],
    },
    enabled: true,
  };
}

/** The first clause of the brief, when the model did not name the task. */
function label(brief: string): string {
  const first = brief.split(/[.\n!?]/)[0]?.trim() ?? '';
  return first.length > 58 ? `${first.slice(0, 55).trimEnd()}…` : first || 'Untitled task';
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Enough of a task id to name it; the model is given this form. */
const shortId = (taskId: string) => taskId.slice(0, 8);

/** Reports are context for the parent, not a replay of the child's entire transcript. */
export const MAX_REPORT_CHARS = 12_000;
export function boundedReport(result: Pick<runner.TaskResult, 'answer' | 'content' | 'carbonId'>): string {
  const report = (result.answer || result.content).trim() || '(It wrote nothing.)';
  if (report.length <= MAX_REPORT_CHARS) return report;
  const tail = result.carbonId ? ` Open the task transcript (carbon ${result.carbonId}) for the full output.` : '';
  return `${report.slice(0, MAX_REPORT_CHARS)}\n\n[Report shortened to protect the parent conversation's context.${tail}]`;
}

/** For a caller with no turn around it: the runs finish, or the time runs out. */
const settledOrTimedOut = (runs: Promise<unknown>[], timeoutMs?: number): Promise<IdleOutcome> =>
  new Promise((resolve) => {
    const timer = timeoutMs ? setTimeout(() => resolve('timeout'), timeoutMs) : undefined;
    void Promise.all(runs).then(() => {
      clearTimeout(timer);
      resolve('ready');
    });
  });

interface Finished {
  ref: SubagentRef;
  ok: boolean;
  /** The headline and the report, as both the model and the transcript read it. */
  text: string;
}

interface Running {
  task: Task;
  ref: SubagentRef;
  /** The start_agent row, as the conversation last heard of it. */
  call: ToolActivity | undefined;
  /** This agent's own stop. The turn's stop reaches it through here, and so does stop(). */
  controller: AbortController;
  /** Detaches it from the turn once it has ended. */
  release(): void;
  done: Promise<void>;
}

export function withAgents(runtime: ToolRuntime, context: DelegationContext): Delegation {
  const running = new Map<string, Running>();
  /** Finished, and not yet told to the model. */
  const unread: Finished[] = [];
  const listeners = new Set<() => void>();

  const settle = (entry: Running, result: runner.TaskResult): void => {
    const { task, ref, call } = entry;
    entry.release();
    running.delete(task.id);

    // Stopped from its own panel, not by the turn: the model should hear that it was the user's
    // decision, or it will start the same agent again.
    const byPerson = !entry.controller.signal.aborted && tasks.find(task.id)?.state === 'cancelled';
    const headline =
      result.ending === null
        ? `${ref.agentName} finished "${ref.title}"`
        : byPerson
          ? `${ref.agentName} was stopped by the user before it finished "${ref.title}"`
          : `${ref.agentName} stopped before it finished "${ref.title}": ${result.ending}`;
    const finished: Finished = {
      ref: { ...ref, finished: true },
      ok: result.ending === null,
      text:
        `${headline} (task ${shortId(task.id)}${result.summary ? `; ${result.summary}` : ''}).\n\n` +
        boundedReport(result),
    };
    unread.push(finished);
    // The row that started it now carries what it came back with.
    if (call) {
      context.report({ ...call, status: finished.ok ? 'done' : 'failed', result: finished.text, subagent: finished.ref });
    }
    for (const listener of [...listeners]) listener();
  };

  const start = async (args: Record<string, unknown>, options: ToolCallOptions | undefined): Promise<ToolCallResult> => {
    const id = text(args.agent);
    const agent = id ? registry.find(id) : null;
    if (!agent) {
      const installed = registry.list().map((entry) => entry.id).join(', ') || 'none';
      return { ok: false, text: `There is no agent named "${id}". Installed agents: ${installed}.`, attempted: false };
    }
    const brief = text(args.task);
    if (!brief) {
      return { ok: false, text: 'start_agent needs a task. The agent sees nothing but what you write there.', attempted: false };
    }

    const task = tasks.add({
      agentId: agent.id,
      title: text(args.title) || label(brief),
      prompt: brief,
      source: 'chat',
      workspace: context.workspace,
      parent: { threadId: context.threadId, messageId: context.messageId },
      startNow: true,
    });
    const ref: SubagentRef = { taskId: task.id, agentId: agent.id, agentName: agent.name, title: task.title };
    const call = options?.activity ? { ...options.activity, subagent: ref } : undefined;
    if (call) context.report(call);

    // A subagent's calls stay in its own transcript, except the ones somebody had to approve: the
    // question was asked in the conversation, so the conversation also shows how it went.
    const asked = new Set<string>();
    const inConversation = (activity: ToolActivity): ToolActivity => ({
      ...activity,
      // Occurrence ids have the same shape in every run; this keeps them apart from the chat's own.
      activityId: `${task.id}:${activity.activityId ?? activity.callId}`,
      contentOffset: undefined,
      serverName: `${agent.name} · ${activity.serverName}`,
    });

    // Its own controller, so the turn can stop what it started after this call has returned.
    const controller = new AbortController();
    const turn = options?.signal;
    const stopWithTurn = () => controller.abort();
    if (turn?.aborted) controller.abort();
    else turn?.addEventListener('abort', stopWithTurn, { once: true });

    const entry: Running = {
      task,
      ref,
      call,
      controller,
      release: () => turn?.removeEventListener('abort', stopWithTurn),
      done: Promise.resolve(),
    };
    running.set(task.id, entry);

    const launch = () =>
      runner
        .runNow(task, {
          parentModel: context.parentModel,
          mode: narrower(agent.access, context.currentMode?.() ?? context.mode),
          currentMode: () => narrower(agent.access, context.currentMode?.() ?? context.mode),
          onAccessChange: context.onAccessChange,
          screenCaptureWithoutAsking: context.screenCaptureWithoutAsking,
          machineWideWithoutAsking: context.machineWideWithoutAsking,
          workspaceConfirmed: context.workspaceConfirmed,
          signal: controller.signal,
          requestApproval: (activity, signal) => {
            asked.add(activity.activityId ?? activity.callId);
            return context.requestApproval(inConversation(activity), signal);
          },
          onActivity: (activity) => {
            if (asked.has(activity.activityId ?? activity.callId) && !activity.awaitingApproval) {
              context.report(inConversation(activity));
            }
          },
        })
        .then(
          (result) => settle(entry, result),
          // The runner reports every ending as a result; this is for one that could not even
          // start. A turn waits for its agents, so an agent never settled is a turn never ended.
          (error: Error) => {
            tasks.settle(task.id, { ok: false, error: error.message });
            settle(entry, { agentName: agent.name, content: '', answer: '', ending: error.message, summary: null, carbonId: null });
          }
        );
    // Started on the next tick, once this call has returned and the transcript has recorded it
    // as done. An agent that fails at once would otherwise report before its own start did, and
    // "started" would overwrite the failure.
    entry.done = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(launch);

    return {
      ok: true,
      text:
        `Started ${agent.name} on "${task.title}" as task ${shortId(task.id)}. It is working now, so carry on ` +
        `with your own part. Its report will be given to you when it finishes.`,
      attempted: true,
    };
  };

  const wait = async (args: Record<string, unknown>, options: ToolCallOptions | undefined): Promise<ToolCallResult> => {
    const named = Array.isArray(args.agents)
      ? args.agents.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
      : [];
    const wanted = (ref: SubagentRef) =>
      !named.length ||
      named.some(
        (name) =>
          name === ref.agentId ||
          name === ref.agentName.toLowerCase() ||
          // A short prefix of a random id would match by accident.
          (name.length >= 6 && ref.taskId.toLowerCase().startsWith(name))
      );
    const targets = () => [...running.values()].filter((entry) => wanted(entry.ref));

    if (!targets().length && !unread.some((entry) => wanted(entry.ref))) {
      return {
        ok: true,
        text: named.length
          ? 'None of those agents is running or has a report waiting. Every report so far has already been given to you.'
          : 'No agent is running, and every report has already been given to you.',
        attempted: true,
      };
    }

    const seconds = Number(args.timeout_seconds);
    const limitMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_WAIT_SECONDS) * 1000 : undefined;
    let outcome: IdleOutcome = 'ready';
    if (targets().length) {
      outcome = options?.idle
        ? await options.idle(() => targets().length === 0, limitMs)
        : await settledOrTimedOut(targets().map((entry) => entry.done), limitMs);
    }

    // Whatever of theirs has finished is told here, and so is not told again between steps.
    const reports = unread.filter((entry) => wanted(entry.ref));
    for (const report of reports) unread.splice(unread.indexOf(report), 1);
    // Every agent still out, not only the ones asked about: the turn waits for all of them.
    const still = [...running.values()].map((entry) => entry.ref.agentName);
    const why =
      outcome === 'steered'
        ? 'Stopped waiting because the user has sent a message, which follows.'
        : outcome === 'timeout'
          ? `Stopped waiting after ${(limitMs ?? 0) / 1000} seconds.`
          : '';
    return {
      ok: true,
      text: [
        why,
        ...reports.map((report) => report.text),
        still.length ? `Still running: ${still.join(', ')}. Each report will be given to you when it finishes.` : '',
      ]
        .filter(Boolean)
        .join('\n\n---\n\n'),
      attempted: true,
    };
  };

  const background: BackgroundWork = {
    take: (): BackgroundReport[] =>
      unread.splice(0).map((report) => ({
        note:
          'Antimatter: an agent you started has finished. This message is from the app, not from the user.\n\n' +
          report.text,
        activity: {
          callId: `report:${report.ref.taskId}`,
          activityId: `report:${report.ref.taskId}`,
          serverId: SERVER_ID,
          serverName: SERVER_NAME,
          toolName: AGENT_REPORT,
          tier: 'read',
          args: JSON.stringify({ agent: report.ref.agentId, title: report.ref.title }),
          status: report.ok ? 'done' : 'failed',
          result: report.text,
          subagent: report.ref,
        },
      })),
    running: () => running.size,
    ready: () => unread.length,
    onSettle: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const control = (args: Record<string, unknown>, stop: boolean): ToolCallResult => {
    const target = text(args.agent).toLowerCase();
    const matches = [...running.values()].filter(({ ref }) =>
      target === ref.agentId || target === ref.agentName.toLowerCase() || (target.length >= 6 && ref.taskId.startsWith(target)));
    if (matches.length !== 1) return { ok: false, attempted: false,
      text: matches.length ? 'More than one agent matches. Use the exact task id returned by start_agent.' : 'No running agent in this turn matches that id.' };
    const entry = matches[0];
    try {
      if (stop) {
        entry.controller.abort();
        runner.stop(entry.task.id);
      } else runner.sendMessage(entry.task.id, text(args.message), args.interrupt === true);
      return { ok: true, attempted: true, text: stop ? `Stopping task ${shortId(entry.task.id)}.` : `Guidance queued for task ${shortId(entry.task.id)}.` };
    } catch (error) {
      return { ok: false, attempted: false, text: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    runtime: {
      enabledTools: () => {
        const own = runtime.enabledTools();
        const agents = registry.list();
        if (!agents.length) return own;
        return [
          ...own,
          { serverId: SERVER_ID, serverName: SERVER_NAME, tool: startDefinition(agents) },
          { serverId: SERVER_ID, serverName: SERVER_NAME, tool: waitDefinition() },
          { serverId: SERVER_ID, serverName: SERVER_NAME, tool: controlDefinition(false) },
          { serverId: SERVER_ID, serverName: SERVER_NAME, tool: controlDefinition(true) },
        ];
      },
      prepareTool: async (serverId, toolName, args, options) => {
        if (serverId === SERVER_ID || !runtime.prepareTool) return { args };
        return runtime.prepareTool(serverId, toolName, args, options);
      },
      callTool: (serverId, toolName, args, options) => {
        if (serverId !== SERVER_ID) return runtime.callTool(serverId, toolName, args, options);
        if (toolName === START_AGENT) return start(args, options);
        if (toolName === WAIT_FOR_AGENTS) return wait(args, options);
        if (toolName === SEND_AGENT_MESSAGE) return Promise.resolve(control(args, false));
        if (toolName === STOP_AGENT) return Promise.resolve(control(args, true));
        return Promise.resolve({ ok: false, text: `Antimatter has no agent tool named ${toolName}.`, attempted: false });
      },
      connectionErrors: () => runtime.connectionErrors?.() ?? [],
    },
    background,
    stop: () => {
      for (const entry of running.values()) entry.controller.abort();
    },
  };
}
