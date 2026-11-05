import { HAG_SOURCE_ID, assertHagVisibleHistory, prepareHagPreview } from '../../../src/api/hag';
import type { Message } from '../types';
import { conversationRequestMessages } from './requestMessages';

const problem = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

/** Check visible metadata before transport flattens files and removes tool activity. */
export function hagPreviewHistoryProblem(providerId: string | undefined, history: readonly Message[]): string | undefined {
  if (providerId !== HAG_SOURCE_ID) return undefined;
  try { assertHagVisibleHistory(history); }
  catch (cause) { return problem(cause); }
  return undefined;
}

/** A local refusal keeps the unsent draft and transcript intact; the host validates again. */
export function hagPreviewSubmissionProblem(providerId: string, modelId: string, history: readonly Message[], user: Message): string | undefined {
  if (providerId !== HAG_SOURCE_ID) return undefined;
  try {
    assertHagVisibleHistory([...history, user]);
    const messages = conversationRequestMessages(history, user);
    prepareHagPreview({ providerId, model: modelId, messages, useTools: false }, messages);
  } catch (cause) { return problem(cause); }
  return undefined;
}
