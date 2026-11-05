import { agentFinished, startsAgent } from './conversation';
import type { Message, ToolActivity } from '../types';

export type FlowLane = 'approval' | 'working' | 'review' | 'done';
export interface FlowTurn { message: Message; index: number; prompt: string }

/** Labels are excerpts, never inferred goals or generated summaries. */
export function flowTurns(messages: readonly Message[]): FlowTurn[] {
  let prompt = '';
  return messages.flatMap((message, index) => {
    if (message.role === 'user') prompt = message.content.trim() || message.attachments?.map((file) => file.name).join(', ') || 'Attached files';
    return message.role === 'assistant' ? [{ message, index, prompt: prompt || 'Assistant reply' }] : [];
  });
}

/** Old pending records are interrupted history, never live approvals or active work. */
export function flowLane(activity: ToolActivity, active: boolean): FlowLane {
  if (activity.status === 'failed' || activity.status === 'denied') return 'review';
  if (activity.awaitingApproval) return active ? 'approval' : 'review';
  if (activity.status === 'pending' || activity.status === 'running') return active ? 'working' : 'review';
  if (startsAgent(activity) && activity.subagent && !agentFinished(activity)) return active ? 'working' : 'review';
  return 'done';
}

export function flowGroups(activities: readonly ToolActivity[], active: boolean): Record<FlowLane, ToolActivity[]> {
  const groups: Record<FlowLane, ToolActivity[]> = { approval: [], working: [], review: [], done: [] };
  for (const activity of activities) groups[flowLane(activity, active)].push(activity);
  return groups;
}
