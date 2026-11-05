import type { Message, Role } from './types';
import { hasDeliveredVoiceGuidance, isOperationalPlaceholder, separateOperationalError, type OperationalMessage } from './operationalErrors';

export interface VisibleRequestMessage {
  id: string;
  role: Role;
  content: string;
  attachments?: readonly { name: string; content?: string }[];
  meta?: OperationalMessage['meta'];
}

/** Host-only reasoning must never be vouched for by caller-supplied provider/model strings. */
export function withoutReasoningHistory(message: Message): Message {
  if (!Object.hasOwn(message, 'reasoningHistory')) return message;
  const { reasoningHistory: _reasoning, ...visible } = message;
  return visible;
}

/** Preserve the same visible history when a conversation switches between desktop and phone. */
export function visibleRequestMessages(messages: readonly VisibleRequestMessage[]): Message[] {
  return messages.map(separateOperationalError).filter((message) => !isOperationalPlaceholder(message) ||
    hasDeliveredVoiceGuidance(message) || message.attachments?.some((file) => typeof file.content === 'string')).map((message) => ({
    id: message.id,
    role: message.role,
    content: [message.content, ...(message.attachments ?? [])
      .filter((file) => typeof file.content === 'string')
      .map((file) => `<file name="${file.name}">\n${file.content}\n</file>`)]
      .filter(Boolean)
      .join('\n\n'),
  }));
}

/** Apply host-owned error provenance to caller/cached messages without forwarding UI metadata. */
export function sanitizeConversationRequest(
  messages: readonly Message[],
  visible: readonly (OperationalMessage & { id: string })[] = [],
  options: { preserveVoiceGuidance?: boolean; trustedReasoningHistory?: boolean } = {},
): Message[] {
  const stored = new Map(visible.map((message) => [message.id, separateOperationalError(message)]));
  return messages.flatMap((incoming) => {
    const message = options.trustedReasoningHistory ? incoming : withoutReasoningHistory(incoming);
    if (message.role !== 'assistant') return [message];
    const authoritative = stored.get(message.id);
    let normalized = separateOperationalError(message);
    if (authoritative?.role === 'assistant') {
      const failure = authoritative.meta?.operationalError;
      const oldContent = failure ? `${authoritative.content}${authoritative.content ? '\n\n' : ''}Error: ${failure.message}` : undefined;
      // Only exact visible text or the exact removed footer can borrow its stored provenance.
      if (message.content === authoritative.content || message.content === oldContent) {
        normalized = { ...message, content: authoritative.content, meta: authoritative.meta } as typeof normalized;
      }
    }
    if (isOperationalPlaceholder(normalized) && !message.toolCalls?.length &&
        !(options.preserveVoiceGuidance && hasDeliveredVoiceGuidance(normalized))) return [];
    // Provider adapters and strict HAG admission receive only the provider message contract.
    const { meta: _diagnostic, ...clean } = normalized as typeof normalized & { meta?: unknown };
    return [clean];
  });
}
