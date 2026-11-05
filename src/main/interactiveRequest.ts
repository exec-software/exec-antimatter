import type { ChatRequest, Message } from '../api/types';
import { fitToBudget } from './context';
import type { ModelProfile } from './modelProfiles';

/** Ground and fit resumed or visible history using the host's resolved model profile. */
export function prepareInteractiveRequest(
  request: ChatRequest,
  conversation: Message[],
  systemPrompt: string,
  profile: ModelProfile,
  budget: number
) {
  const grounded: Message[] = [
    { id: 'system', role: 'system', content: systemPrompt },
    ...conversation.filter((message) => message.role !== 'system'),
  ];
  const fit = fitToBudget(grounded, budget);
  return {
    grounded,
    fit,
    request: {
      ...request,
      messages: fit.messages,
      maxTokens: profile.maxOutputTokens,
      maxToolCalls: profile.maxToolCallsPerMessage,
      thinkingLevel: profile.thinkingLevel,
    },
  };
}
