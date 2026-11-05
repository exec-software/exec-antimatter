import type { Message, ToolDefinition } from './types';

/** Planning estimates only. The server's tokenizer remains authoritative for admission. */
export const CHARS_PER_TOKEN = 3.2;
const PER_MESSAGE_OVERHEAD = 4;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export const messageTokens = (message: Message): number =>
  estimateTokens(message.content ?? '') +
  (typeof message.reasoningHistory?.content === 'string' ? estimateTokens(message.reasoningHistory.content) : 0) +
  PER_MESSAGE_OVERHEAD +
  (message.toolCalls?.length ? estimateTokens(JSON.stringify(message.toolCalls)) : 0);

export const conversationTokens = (messages: Message[]): number =>
  messages.reduce((total, message) => total + messageTokens(message), 0);

export const toolDefinitionTokens = (tools: readonly ToolDefinition[]): number =>
  tools.length ? estimateTokens(JSON.stringify(tools)) + PER_MESSAGE_OVERHEAD : 0;
