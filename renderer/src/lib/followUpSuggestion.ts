import type { Draft, Message } from '../types';

export interface FollowUpSuggestion { messageId: string; text: string }

/** Local, reviewable prompts: no extra model call, automatic permission, or automatic send. */
export function followUpSuggestion(messages: Message[], running: boolean): FollowUpSuggestion | null {
  const last = messages[messages.length - 1];
  if (running || !last || last.role !== 'assistant' || last.meta?.failed || !last.content.trim()) return null;
  if (last.meta?.tools?.some((tool) => tool.awaitingApproval || tool.status === 'pending' || tool.status === 'running')) return null;
  return {
    messageId: last.id,
    text: last.meta?.tools?.length
      ? 'Summarize the changes and any remaining work.'
      : 'Explain that in more detail.',
  };
}

export function canAcceptSuggestion(draft: Draft, suggestion: FollowUpSuggestion | null, running: boolean): boolean {
  return !!suggestion && !running && draft.text.length === 0 && draft.attachments.length === 0;
}
