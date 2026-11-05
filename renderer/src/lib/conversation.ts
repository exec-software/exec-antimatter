import type { TranscriptPart } from './transcript';
import type { AgentTask, Attachment, Message, SubagentRef, ToolActivity, ToolStatus } from '../types';

/**
 * What a conversation has produced and used, read from its own messages.
 *
 * Everything here is derived rather than stored: the tool calls a turn made are already kept on
 * the message that made them, so the list beside the transcript is a view of the transcript, and
 * cannot disagree with it.
 */

/** Tools that leave a file behind. The path argument is what they changed. */
const WRITERS = new Set(['write_file', 'edit_file', 'coding_write_file', 'coding_edit_file']);

/** Starts an agent and returns at once; the row is updated with the report when the run ends. */
export const START_AGENT = 'start_agent';
export const WAIT_FOR_AGENTS = 'wait_for_agents';
/** Where in a turn an agent's report reached the model. */
export const AGENT_REPORT = 'agent_report';
/** Before start_agent: started an agent and returned only when it had finished. Kept in older conversations. */
const RUN_AGENT = 'run_agent';

/** A row that started an agent, in either form. */
export const startsAgent = (activity: ToolActivity): boolean =>
  activity.toolName === START_AGENT || activity.toolName === RUN_AGENT;

/**
 * Whether the run a start row made has ended. A run_agent call only settled when its run had; a
 * start_agent call settles at once and is marked when the run ends.
 */
export const agentFinished = (activity: ToolActivity): boolean =>
  activity.toolName === RUN_AGENT
    ? activity.status === 'done' || activity.status === 'failed' || activity.status === 'denied'
    : activity.subagent?.finished === true;

const argsOf = (activity: ToolActivity): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(activity.args || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const assistantTools = (messages: readonly Message[]) =>
  messages.flatMap((message) =>
    message.role === 'assistant'
      ? (message.meta?.tools ?? []).map((activity) => ({ activity, message }))
      : []
  );

export interface ConversationOutput {
  path: string;
  /** When the file was last written, as near as the transcript knows: the turn's start. */
  at: number;
  /** True when the last change was an edit rather than a whole new file. */
  edited: boolean;
}

/** Files the conversation wrote, most recent first, each once. Failed and refused writes wrote nothing. */
export function conversationOutputs(messages: readonly Message[]): ConversationOutput[] {
  const latest = new Map<string, ConversationOutput>();
  for (const { activity, message } of assistantTools(messages)) {
    if (!WRITERS.has(activity.toolName) || activity.status !== 'done') continue;
    const path = argsOf(activity).path;
    if (typeof path !== 'string' || !path.trim()) continue;
    // A Map keeps a key where it was first set; taking it out first moves a rewrite to the end.
    latest.delete(path.trim());
    latest.set(path.trim(), {
      path: path.trim(),
      at: message.meta?.createdAt ?? 0,
      edited: activity.toolName.endsWith('edit_file'),
    });
  }
  return [...latest.values()].reverse();
}

export interface ConversationPreview {
  id: string;
  kind: 'image' | 'page';
  /** Workspace-relative path for an image; an absolute http(s) URL for a page. */
  target: string;
  title: string;
  at: number;
  /** Canonical root the image path belongs to. Missing only on legacy rows and pages. */
  workspace?: string;
}

/** Same relative filename in two workspaces is two different previews. */
export const previewIdentity = (preview: Pick<ConversationPreview, 'kind' | 'target' | 'workspace'>): string =>
  `${preview.kind}\u0000${preview.workspace ?? ''}\u0000${preview.target}`;

/**
 * What the conversation has shown, newest first, each thing once.
 *
 * The call itself carries what it showed — a screenshot that took the default path never
 * mentioned that path in its arguments, so reading it back out of the arguments would miss
 * exactly the common case. A call that failed or was refused showed nothing, whatever it was
 * asked to show, and settled calls are the only ones with a preview on them.
 *
 * Deduplicated on kind, workspace and target rather than on the call: a debug loop screenshots the
 * same file a dozen times, and a section listing `screenshot.png` twelve times is a list of the
 * loop rather than a list of what there is to look at. The newest call keeps the place, while two
 * workspaces with the same relative filename remain distinct.
 */
export function conversationPreviews(messages: readonly Message[]): ConversationPreview[] {
  const latest = new Map<string, ConversationPreview>();
  for (const { activity, message } of assistantTools(messages)) {
    if (activity.status !== 'done' || !activity.preview) continue;
    const { kind, target, title, workspace } = activity.preview;
    if (!target) continue;
    const key = previewIdentity({ kind, target, workspace });
    latest.delete(key);
    latest.set(key, {
      // Activity ids are scoped to one model run (round:index:provider-id), so a provider that
      // reuses call ids can produce the same value in a later turn. The owning message makes the
      // React identity stable within a transcript and collision-free across turns.
      id: `${message.id}:${activity.activityId ?? activity.callId}`,
      kind,
      target,
      title: title || target,
      at: message.meta?.createdAt ?? 0,
      ...(workspace ? { workspace } : {}),
    });
  }
  return [...latest.values()].reverse();
}

export interface ConversationSubagent extends SubagentRef {
  /** The assistant message whose turn started it. */
  messageId: string;
  /** How the start row stands; the task store knows more once the run exists there. */
  status: ToolStatus;
  /** Whether the run has ended, as far as the start row knows. */
  finished: boolean;
  /** The agent's report, once it has one. */
  report: string | null;
}

/**
 * The agents a conversation handed work to, in the order it did so. A call the main process never
 * turned into a task — an unknown agent, an empty brief — started nothing and is not listed, and
 * neither is the mark where a report arrived: that agent is already listed by its start.
 */
export function conversationSubagents(messages: readonly Message[]): ConversationSubagent[] {
  return assistantTools(messages).flatMap(({ activity, message }) => {
    if (!startsAgent(activity) || !activity.subagent) return [];
    const finished = agentFinished(activity);
    return [
      {
        ...activity.subagent,
        messageId: message.id,
        status: activity.status,
        finished,
        report: finished ? activity.result ?? null : null,
      },
    ];
  });
}

export type SubagentPhase = 'starting' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'unstarted';

export const PHASE_LABEL: Record<SubagentPhase, string> = {
  starting: 'Starting',
  running: 'Running',
  done: 'Done',
  failed: 'Stopped',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  unstarted: 'Not started',
};

/**
 * Where a subagent stands, from its task when the store has it and from the start row otherwise.
 * The task is the better witness; the row only learns how the run went when the run is over.
 *
 * `started` is whether the call became a task at all, `finished` whether the row has heard the
 * run end, and `turnIsActive` whether the turn that started it is still going. A turn waits for
 * its agents, so once it is over, a run the row never heard end was cut off with it.
 */
export function subagentPhase(
  call: { status: ToolStatus; started: boolean; finished: boolean },
  task: AgentTask | null,
  turnIsActive: boolean
): SubagentPhase {
  if (task) return task.state === 'running' || task.state === 'queued' ? 'running' : task.state;
  if (!call.started) {
    if (call.status === 'pending' || call.status === 'running') return turnIsActive ? 'starting' : 'interrupted';
    return 'unstarted';
  }
  if (call.finished) return call.status === 'done' ? 'done' : 'failed';
  return turnIsActive ? 'running' : 'interrupted';
}

/** The agents a turn started that it has not heard back from, each once, in the order started. */
export function unfinishedSubagents(tools: readonly ToolActivity[]): SubagentRef[] {
  const seen = new Set<string>();
  return tools.flatMap((activity) => {
    const ref = activity.subagent;
    if (!startsAgent(activity) || !ref || agentFinished(activity) || seen.has(ref.taskId)) return [];
    seen.add(ref.taskId);
    return [ref];
  });
}

/** Files attached to the conversation, most recent first, each name once. */
export function conversationSources(messages: readonly Message[]): Attachment[] {
  const byName = new Map<string, Attachment>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      byName.delete(attachment.name);
      byName.set(attachment.name, attachment);
    }
  }
  return [...byName.values()].reverse();
}

/**
 * A turn's work, and its answer.
 *
 * The answer is what the model wrote after its last action; everything before that — the notes it
 * wrote between calls, and the calls — is how it got there, which is folded away once the turn is
 * over. A turn with no actions is all answer.
 */
export function splitWork(parts: readonly TranscriptPart[]): { work: TranscriptPart[]; answer: TranscriptPart[] } {
  let last = -1;
  parts.forEach((part, index) => {
    if (part.kind === 'tools') last = index;
  });
  return { work: parts.slice(0, last + 1), answer: parts.slice(last + 1) };
}

/** A gap long enough that the next message reads as a new sitting rather than a reply. */
const SITTING_MS = 30 * 60 * 1000;

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Whether a time label belongs above a message sent at `at`, given the one before it. */
export function startsSitting(previousAt: number | undefined, at: number | undefined): boolean {
  if (!at) return false;
  if (!previousAt) return true;
  return at - previousAt >= SITTING_MS || !sameDay(new Date(previousAt), new Date(at));
}

/** "Today 2:14 PM", "Yesterday 9:13 AM", "Monday 9:13 AM" within the week, and a date beyond it. */
export function sittingLabel(at: number, now: number = Date.now(), locale?: string): string {
  const when = new Date(at);
  const today = new Date(now);
  const time = when.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(when, today)) return `Today ${time}`;

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(when, yesterday)) return `Yesterday ${time}`;

  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at < startOfToday && startOfToday - at < 6 * 24 * 3600 * 1000) {
    return `${when.toLocaleDateString(locale, { weekday: 'long' })} ${time}`;
  }
  const sameYear = when.getFullYear() === today.getFullYear();
  const date = when.toLocaleDateString(locale, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${date}, ${time}`;
}

/** The last path segment, and what comes before it, for a list that has room for one line each. */
export function splitPath(path: string): { name: string; directory: string } {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return cut < 0 ? { name: trimmed, directory: '' } : { name: trimmed.slice(cut + 1), directory: trimmed.slice(0, cut) };
}

/**
 * What a carbon says the run did: its entries without the file's header, and without the prompt
 * and brief it was given — the brief is shown above, and the standing prompt is not news.
 */
export const carbonActions = (markdown: string): string =>
  markdown
    .split(/^(?=## \[\d+\] )/m)
    .filter((section) => {
      const heading = /^## \[\d+\] (.*)$/m.exec(section.split('\n')[0]);
      return heading !== null && !/(?:^|· )(?:system|user)$/.test(heading[1].trim());
    })
    .join('');
