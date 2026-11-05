import type { Message } from '../types';
import { formatElapsedSeconds } from './duration';
import { codeSegments } from './markdown';

/**
 * Streams rarely report usage. Most OpenAI-compatible servers emit about one token per
 * chunk; batching providers send longer chunks, so fall back to ~4 characters per token.
 */
export const estimateTokens = (chunks: number, chars: number) => Math.max(chunks, Math.round(chars / 4));

export const formatSeconds = (seconds: number) =>
  seconds < 60 && Number.isFinite(seconds)
    ? `${Math.max(0, seconds).toFixed(1)}s`
    : formatElapsedSeconds(seconds);

export const formatClock = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Function words counted by the research view; fn% is their share of all words.
const FUNCTION_WORDS = new Set(
  (
    'the and of to a in is it that i you he she was for on are with as at be this have but not or by we ' +
    'what all were when your can there an each which do how their if will up out them then me my no so him her one'
  ).split(' ')
);

export interface TurnTelemetry {
  index: number;
  role: Message['role'];
  time: number | null;
  model: string | null;
  source: string | null;
  /** Seconds from request to first token. */
  ttft: number | null;
  /** Seconds from request to finish; live while a reply is in flight. */
  latency: number | null;
  tokens: number | null;
  /** Tokens per second of generation (first token to last). */
  rate: number | null;
  chars: number;
  words: number;
  avgWord: number | null;
  functionWordPct: number | null;
  codeBlocks: number;
  files: number;
  failed: boolean;
}

/** True for the assistant turn that is still receiving model/tool events. */
export const isActiveReply = (message: Message, isLast: boolean, isStreaming: boolean) =>
  isStreaming && isLast && message.role === 'assistant';

/** True for the empty assistant placeholder before any visible model text arrives. */
export const isAwaitingReply = (message: Message, isLast: boolean, isStreaming: boolean) =>
  isActiveReply(message, isLast, isStreaming) && !message.content;

export function describeTurn(message: Message, index: number, now: number): TurnTelemetry {
  const { content, meta } = message;
  const isAssistant = message.role === 'assistant';
  const words = content.match(/[A-Za-z]+/g) ?? [];
  const started = meta?.createdAt ?? null;
  const firstToken = meta?.firstTokenAt ?? null;
  const end = meta?.finishedAt ?? (isAssistant && started ? now : null);
  const tokens = isAssistant && content ? estimateTokens(meta?.chunks ?? 0, content.length) : null;
  const generationSeconds = firstToken && end ? (end - firstToken) / 1000 : 0;
  const functionWords = words.filter((word) => FUNCTION_WORDS.has(word.toLowerCase())).length;

  return {
    index,
    role: message.role,
    time: started,
    model: meta?.modelId ?? null,
    source: meta?.sourceName ?? null,
    ttft: started && firstToken ? (firstToken - started) / 1000 : null,
    latency: started && end ? (end - started) / 1000 : null,
    tokens,
    rate: tokens && generationSeconds >= 0.25 ? tokens / generationSeconds : null,
    chars: content.length,
    words: words.length,
    avgWord: words.length ? words.reduce((sum, word) => sum + word.length, 0) / words.length : null,
    functionWordPct: words.length ? (100 * functionWords) / words.length : null,
    codeBlocks: codeSegments(content).length,
    files: message.attachments?.length ?? 0,
    failed: meta?.failed ?? false,
  };
}
