import type { Message, ChatRequest } from '../api/types';
import type { ModelProfile } from './modelProfiles';
import { compactionRequest } from './compactionRequest';
import { conversationTokens, fitToBudget, fitWithCompactionNotice, isCompactionNotice, promptBudget } from './context';

/** Background compaction never drops context merely because summarization failed. */
export async function summarizeIdleConversation(
  messages: Message[], profile: ModelProfile,
  chat: (request: ChatRequest, signal: AbortSignal) => Promise<string>, signal: AbortSignal,
): Promise<{ compactedMessages: number; payload: Message[] } | null> {
  const originalTokens = conversationTokens(messages);
  const budget = Math.min(promptBudget(profile, true), Math.floor(originalTokens * 0.75));
  if (budget < 1024) return null;
  const fit = fitToBudget(messages, budget);
  if (!fit.compacted || fit.overflowTokens > 0) return null;
  const input = [...fit.dropped, ...fit.messages.filter(isCompactionNotice)]
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
  const request = compactionRequest(profile, input);
  if (!request) return null;
  const summary = (await chat(request, signal)).trim();
  if (signal.aborted || !summary) return null;
  const result = fitWithCompactionNotice(messages, budget, summary);
  if (!result.compacted || result.overflowTokens > 0 || conversationTokens(result.messages) >= originalTokens
      || !result.messages.some((message) => isCompactionNotice(message) && message.content.includes(summary))) return null;
  return { compactedMessages: result.compacted, payload: result.messages };
}
