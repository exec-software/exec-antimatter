import type { Message } from '../../types';

/** Exchanges start at recorded user messages; leading context/imported replies remain visible. */
export interface AtlasExchange {
  id: string;
  number: number;
  messages: Message[];
  excerpt: string;
  actions: number;
  attachments: number;
}

export function atlasExcerpt(message: Message): string {
  const text = message.content.replace(/\s+/g, ' ').trim();
  if (text) return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  if (message.attachments?.length) return message.attachments.map((attachment) => attachment.name).join(', ').slice(0, 160);
  if (message.meta?.tools?.length) return message.meta.tools.map((tool) => tool.toolName).join(', ').slice(0, 160);
  return 'No text recorded';
}

export function atlasExchanges(messages: Message[]): AtlasExchange[] {
  const exchanges: AtlasExchange[] = [];
  for (const message of messages) {
    if (message.role === 'user' || !exchanges.length) {
      exchanges.push({ id: message.id, number: exchanges.length + 1, messages: [], excerpt: atlasExcerpt(message), actions: 0, attachments: 0 });
    }
    const exchange = exchanges[exchanges.length - 1];
    exchange.messages.push(message);
    exchange.actions += message.meta?.tools?.length ?? 0;
    exchange.attachments += message.attachments?.length ?? 0;
  }
  return exchanges;
}

/** Search recorded content only, never a generated title or guessed summary. */
export function atlasMessageMatches(message: Message, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [message.content, ...(message.attachments ?? []).map((file) => file.name),
    ...(message.meta?.tools ?? []).map((tool) => `${tool.toolName}\n${tool.args}\n${tool.result ?? ''}`)]
    .some((text) => text.toLocaleLowerCase().includes(needle));
}

export function atlasSpeaker(message: Message, assistantName: string): string {
  return message.role === 'user' ? 'You' : message.role === 'assistant' ? assistantName : message.role === 'system' ? 'Context' : 'Tool';
}
