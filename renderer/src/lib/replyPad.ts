import type { KeyGesture } from '../../../src/api/desktopPreferences';

export const REPLY_PAD_EVENT = 'antimatter:reply-pad';
export interface ReplyPadRequest {
  conversationId: string;
  text: string;
  action: 'insert' | 'send';
  modifiers: Pick<KeyGesture, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;
  respond(result: { accepted: boolean; error?: string }): void;
}
export function requestReplyPad(input: Omit<ReplyPadRequest, 'respond'>): Promise<{ accepted: boolean; error?: string }> {
  return new Promise((resolve) => {
    let answered = false;
    window.dispatchEvent(new CustomEvent<ReplyPadRequest>(REPLY_PAD_EVENT, { detail: { ...input, respond: (result) => { answered = true; resolve(result); } } }));
    if (!answered) resolve({ accepted: false, error: 'Open a chat before using a saved reply.' });
  });
}
