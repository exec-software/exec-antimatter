import { assertHagPreview, hagPreviewPromptBound, HAG_PREVIEW_MAX_EVALUATED_TOKENS } from '../api/hag';
import type { ChatRequest, Message } from '../api/types';
import type { FitResult } from './context';

/** Every fitting boundary preserves the complete preview or refuses; it never compacts. */
export function fitHagPreview(request: ChatRequest, messages: Message[]): FitResult {
  assertHagPreview({ ...request, messages });
  return { messages, headCount: 1, compacted: 0, estimatedTokens: hagPreviewPromptBound(messages),
    budgetTokens: HAG_PREVIEW_MAX_EVALUATED_TOKENS - request.maxTokens! + 1,
    overflowTokens: 0, minimumRecentMet: true, dropped: [] };
}
