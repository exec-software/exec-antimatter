import type { Attachment, Draft } from '../types';

export interface ComposerSubmissionResult {
  accepted: boolean;
  nextDraft: Draft;
}

/**
 * Offers the current draft to App and only consumes it when App accepts the turn.
 *
 * Submission can be rejected after a click if the selected source/model disappears between
 * renders. Keeping that decision synchronous prevents the composer from erasing text that was
 * never added to the conversation.
 */
export function submitComposerDraft(
  draft: Draft,
  submit: (text: string, attachments: Attachment[]) => boolean
): ComposerSubmissionResult {
  const accepted = submit(draft.text.trim(), draft.attachments);
  return {
    accepted,
    nextDraft: accepted ? { text: '', attachments: [] } : draft,
  };
}
