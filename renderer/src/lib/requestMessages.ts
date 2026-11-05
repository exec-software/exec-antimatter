import type { Message as RequestMessage } from '../../../src/api/types';
import { visibleRequestMessages } from '../../../src/api/requestMessages';
import type { Message } from '../types';

/** Snapshot visible history plus the new user row before adding the empty assistant placeholder. */
export function conversationRequestMessages(history: readonly Message[], user: Message): RequestMessage[] {
  return visibleRequestMessages([...history, user]);
}
