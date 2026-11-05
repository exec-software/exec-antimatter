import type { AccessMode } from '../../api/types';

/**
 * Agents and the work they are given.
 *
 * An agent here is a profile, not a process: a name, a brief, the model that suits it and the
 * tools it is allowed to touch. Dispatching one runs a turn through the same provider and tool
 * loop the chat window uses, in a workspace chosen for the task. That is what makes "hundreds of
 * specialised agents" a data problem rather than a code one — a new agent is a file, not a
 * subclass.
 */

export interface AgentDefinition {
  id: string;
  name: string;
  /** One line. The router reads these to decide who a task belongs to, so it must be specific. */
  description: string;
  /** Free-form labels: code, assets, research. Used for grouping and for routing hints. */
  tags: string[];
  /** Source name and model id, when this agent needs a particular one. Otherwise the default. */
  provider: string | null;
  model: string | null;
  /**
   * Tool names this agent may call. Empty means everything the policy already allows — an
   * allowlist here narrows, it never widens, so an agent cannot grant itself anything.
   */
  tools: string[];
  maxRounds: number;
  /**
   * What this agent is permitted to do when nobody is watching.
   *
   * It has to be per-agent. A run is unattended by definition, so there is no one to answer an
   * approval prompt: under 'ask' every write and every command is refused, which is right for a
   * reviewer and useless for a test writer. Declaring it here makes the trade visible in the
   * agent's own file instead of hiding it in the runner, and the tool allowlist still bounds
   * what 'full' can reach.
   */
  access: AccessMode;
  /** The standing brief, prepended to whatever the task asks for. */
  prompt: string;
  /** Where the definition came from, so the UI can say what is editable. */
  path: string;
  builtin: boolean;
}

export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/**
 * Who asked. `chat` is the conversation's own model handing part of its turn to a specialist; the
 * turn waits for it, so unlike the others it is never queued and never resumed after a restart.
 */
export type TaskSource = 'manual' | 'schedule' | 'router' | 'chat';

/**
 * Where a routed task's answer belongs once it exists.
 *
 * A turn the router hands off ends in the conversation with a note naming who took it — and,
 * before this, ended there for good. The answer went to the run's carbon and nowhere else, so
 * the thread stopped at the handoff in Transcript, Atlas and Research alike, and the only copy
 * lived in a file nobody had been told to open. The address is recorded when the task is queued
 * because by the time it finishes the turn that created it is long over.
 */
export interface TaskReply {
  threadId: string;
  /** The assistant row the handoff note was written to. The answer joins that same row. */
  messageId: string;
}

/**
 * The chat turn a subagent is working for.
 *
 * Not a reply address: the turn is still open and receives the report as a tool result. This is
 * what lets the conversation list its subagents, and lets the run's record join the
 * conversation's carbon.
 */
export interface TaskParent {
  threadId: string;
  /** The assistant message whose turn called start_agent. */
  messageId: string;
}

export interface Task {
  id: string;
  agentId: string;
  title: string;
  /** What this particular run is being asked to do. */
  prompt: string;
  source: TaskSource;
  /** The conversation turn waiting on this run, or null when nothing is waiting. */
  reply: TaskReply | null;
  /** The chat turn this run is part of, for work the conversation's model handed out itself. */
  parent: TaskParent | null;
  state: TaskState;
  /** The directory the run works in. Inherited from the shell unless the task names one. */
  workspace: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** The conversation record for this run, so its session can be opened and read. */
  carbonId: string | null;
  /** A cron-ish spec when the task repeats; null for one-shot work. */
  schedule: string | null;
  /** A paused schedule keeps its configuration and history but cannot be claimed again. */
  paused: boolean;
  /** When a scheduled task is next due. */
  dueAt: number | null;
  error: string | null;
  /** Rounds and tool calls, once it has run. */
  summary: string | null;
}

export interface AgentActivity {
  taskId: string;
  agentId: string;
  agentName: string;
  title: string;
  state: TaskState;
  startedAt: number | null;
  carbonId: string | null;
}
