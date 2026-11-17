import type { ChatRequest, Message, ToolDefinition } from '../api/types';

/**
 * Why idle compaction needs this at all.
 *
 * llama.cpp's prompt cache is a longest-common-prefix cache. An ordinary turn appends to the
 * conversation, so the next request extends the cached one and almost nothing is reprocessed:
 * measured here at 99.8% reuse. Compaction is the one edit that is not an append — it folds the
 * middle of the transcript away and keeps the head — and a fold invalidates everything after it.
 * Measured on this box: 10.9% reuse, which is the system block and nothing else.
 *
 * Idle compaction therefore hands the user a bill it does not pay itself. It runs while nobody
 * is waiting, rewrites the transcript, and the full reprocess lands on whatever the person types
 * next. On a 40k-token compacted conversation that was 138.5 seconds before the first token;
 * once the prefix was cached it was 1.6 seconds.
 *
 * So after compaction commits, send the new prefix once while still idle. The prefill happens on
 * idle time, and the person's next turn extends a prefix the server already holds.
 */

/**
 * The exact prefix a real turn assembled.
 *
 * Reproducing it from scratch is not safe. A turn's system block is built from the assistant
 * identity, the model profile, standing project instructions and notes, skill instructions,
 * collaboration state and whether voice is live — several of which can change between turns. A
 * warm built from a guess at that text would differ from what the next turn sends, score 0%, and
 * spend a full prefill on nothing. Recording what the turn actually used is the only version of
 * this that cannot silently waste the work.
 */
export interface WarmPrefix {
  systemPrompt: string;
  /** Tool definitions render ahead of the messages, so a different list is a different prefix. */
  tools?: ToolDefinition[];
  providerId: string;
  modelId: string;
}

/**
 * Bounded so a long-lived process does not accumulate one entry per conversation ever opened.
 * Only the most recently active threads can plausibly be the next one compacted.
 */
const LIMIT = 32;
const prefixes = new Map<string, WarmPrefix>();

/** Called by a real turn once its system block and toolset are settled. */
export function recordWarmPrefix(threadId: string | undefined, prefix: WarmPrefix): void {
  if (!threadId) return;
  // Re-insert so this thread becomes the newest entry rather than keeping its old position.
  prefixes.delete(threadId);
  prefixes.set(threadId, prefix);
  while (prefixes.size > LIMIT) {
    const oldest = prefixes.keys().next();
    if (oldest.done) break;
    prefixes.delete(oldest.value);
  }
}

export function warmPrefixFor(threadId: string): WarmPrefix | undefined {
  return prefixes.get(threadId);
}

export function forgetWarmPrefix(threadId: string): void {
  prefixes.delete(threadId);
}

/** Visible for tests; the process otherwise keeps one map for its lifetime. */
export function clearWarmPrefixes(): void {
  prefixes.clear();
}

export interface WarmDeps {
  prefix(threadId: string): WarmPrefix | undefined;
  /** A hosted source would be billed for a request whose only product is a cache entry. */
  isLocal(providerId: string): boolean;
  busy(): boolean;
  chat(request: ChatRequest, signal: AbortSignal): Promise<unknown>;
}

export type WarmOutcome =
  | 'warmed'
  | 'no-prefix'
  | 'prefix-stale'
  | 'not-local'
  | 'busy'
  | 'aborted'
  | 'empty';

/**
 * Send the post-compaction prefix so the next turn extends it instead of rebuilding it.
 *
 * Returns why it declined rather than a bare boolean: a warm that never fires is invisible
 * otherwise, and "the cache is cold again" is not a symptom anyone can act on.
 *
 * The request deliberately carries no `threadId`. It is not a turn in the conversation and must
 * not be recorded as one; `compactionRequest` omits it for the same reason.
 */
export async function warmCompactedPrefix(
  input: { threadId: string; messages: readonly Message[]; providerId: string; modelId: string },
  deps: WarmDeps,
  signal: AbortSignal,
): Promise<WarmOutcome> {
  const prefix = deps.prefix(input.threadId);
  if (!prefix) return 'no-prefix';
  // The recorded prefix belongs to the source and model that produced it. A thread switched
  // since then has a different system block and a different server, and warming the old one
  // would prime a cache nobody is about to read.
  if (prefix.providerId !== input.providerId || prefix.modelId !== input.modelId) return 'prefix-stale';
  if (!deps.isLocal(input.providerId)) return 'not-local';
  if (deps.busy()) return 'busy';
  if (signal.aborted) return 'aborted';

  // Built the way `prepareInteractiveRequest` builds `grounded`: one system message at the
  // front, every inherited system turn dropped. Any other shape is a different prefix.
  const messages: Message[] = [
    { id: 'system', role: 'system', content: prefix.systemPrompt },
    ...input.messages.filter((message) => message.role !== 'system'),
  ];
  if (messages.length < 2) return 'empty';

  // One token, because the reply is waste heat: the point is the prompt's KV, not the output.
  await deps.chat({
    messages,
    model: input.modelId,
    providerId: input.providerId,
    tools: prefix.tools,
    maxTokens: 1,
  }, signal);
  return signal.aborted ? 'aborted' : 'warmed';
}
