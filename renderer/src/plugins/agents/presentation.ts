import type { AgentTask, TaskSource, TaskState } from '../../types';
import { formatElapsedSeconds } from '../../lib/duration';

/** Shared labels and colours, so a task looks the same in both panels. */

export interface StateLook {
  label: string;
  /** What it means in the words someone reading the panel would use. */
  hint: string;
  chip: string;
}

export const STATES: Record<TaskState, StateLook> = {
  queued: { label: 'Queued', hint: 'Waiting for the runner.', chip: 'text-ink-2 border-line' },
  running: { label: 'Running', hint: 'Working now.', chip: 'text-primary border-primary/50 bg-primary/10' },
  done: { label: 'Done', hint: 'Finished. Open it to read what happened.', chip: 'text-accent border-accent/50 bg-accent/10' },
  failed: { label: 'Failed', hint: 'It stopped early; read the note.', chip: 'text-danger border-danger/50 bg-danger/10' },
  cancelled: { label: 'Cancelled', hint: 'Stopped by hand.', chip: 'text-ink-3 border-line' },
};

export const SOURCES: Record<TaskSource, string> = {
  manual: 'dispatched',
  schedule: 'scheduled',
  router: 'routed',
  chat: 'from a conversation',
};

export const relativeTime = (at: number | null): string => {
  if (!at) return '—';
  const seconds = (Date.now() - at) / 1000;
  if (seconds < 0) return `in ${Math.round(-seconds / 60) || 1}m`;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
};

/** How long a run took, or has been going. */
export function elapsed(task: AgentTask): string {
  if (!task.startedAt) return '';
  const end = task.state === 'running' ? Date.now() : task.finishedAt ?? task.startedAt;
  const seconds = Math.max(0, Math.round((end - task.startedAt) / 1000));
  return formatElapsedSeconds(seconds);
}

/** The one line under a task: who ran it, how it got here, and how it went. */
export function subtitle(task: AgentTask, agentName: string): string {
  const parts = [agentName, SOURCES[task.source]];
  if (task.schedule) parts.push(task.schedule);
  const took = elapsed(task);
  if (took) parts.push(took);
  if (task.summary) parts.push(task.summary);
  return parts.join(' · ');
}
