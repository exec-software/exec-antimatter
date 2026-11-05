import type { ChatRequest, Message } from '../api/types';
import { CHARS_PER_TOKEN, messageTokens } from '../api/tokenEstimate';
import { isCompactionNotice } from './context';
import type { ModelProfile } from './modelProfiles';

const INSTRUCTION = 'Summarize this earlier part of a conversation so it can replace the original and ' +
  'still be worked from. Keep decisions, file names, identifiers, and anything left ' +
  'unfinished. Drop pleasantries. Write prose, no preamble.\n\n';

/** A handoff summary must itself fit the destination model, including its reply reservation. */
export function compactionRequest(profile: ModelProfile, dropped: readonly Message[]): ChatRequest | undefined {
  const window = Math.min(profile.contextTokens, profile.maxEvaluatedTokens ?? Infinity);
  const maxTokens = Math.min(512, profile.maxOutputTokens, Math.floor(window / 4));
  const budget = Math.max(0, Math.floor((window - maxTokens) * 0.9));
  const allowance = Math.min(24_000, Math.floor((budget - 4) * CHARS_PER_TOKEN) - INSTRUCTION.length);
  if (maxTokens < 1 || allowance < 80) return undefined;
  // Retain previous summaries before bulky tool results, then bound the material to the new
  // window. Keep both ends of oversized material so unfinished recent work survives the handoff.
  const prioritized = [...dropped.filter(isCompactionNotice), ...dropped.filter((message) => !isCompactionNotice(message))];
  let transcript = prioritized.map((message) => `${message.role}: ${message.content}`).join('\n\n');
  if (!transcript.trim()) return undefined;
  if (transcript.length > allowance) {
    const gap = '\n[…earlier material omitted…]\n';
    const head = Math.floor((allowance - gap.length) * 0.6);
    transcript = transcript.slice(0, head) + gap + transcript.slice(-(allowance - gap.length - head));
  }
  const message: Message = { id: 'compaction', role: 'user', content: INSTRUCTION + transcript };
  if (messageTokens(message) > budget) return undefined;
  return { messages: [message], model: profile.modelId, providerId: '', maxTokens, useTools: false };
}
