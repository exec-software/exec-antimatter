import type { ChatRequest, Message } from './types';

export const HAG_SOURCE_ID = 'bundled-hag-experimental';
export const HAG_MODEL_ID = 'qwen3-0.6b-hag-16k';
/** Preview policy is deliberately smaller than the server's 16,384-position allocation. */
export const HAG_PREVIEW_MAX_EVALUATED_TOKENS = 1024;
export const HAG_PREVIEW_MAX_OUTPUT_TOKENS = 64;
export const HAG_PREVIEW_SYSTEM = 'You are a text-only experimental assistant. Answer briefly. No tools or project access are available. /no_think';

/** Inspect durable visible history before attachment/tool metadata is flattened for transport. */
export function assertHagVisibleHistory(messages: readonly unknown[]): void {
  for (const value of messages) {
    if (!value || typeof value !== 'object') throw new Error('Experimental HAG requires plain text history.');
    const message = value as Record<string, unknown>;
    const meta = message.meta as Record<string, unknown> | undefined;
    if ((message.role === 'system' && message.content !== HAG_PREVIEW_SYSTEM) ||
        message.role === 'tool' || message.toolCallId ||
        (message.toolCalls !== undefined && (!Array.isArray(message.toolCalls) || message.toolCalls.length > 0)) ||
        (message.attachments !== undefined && (!Array.isArray(message.attachments) || message.attachments.length > 0)) ||
        (meta?.tools !== undefined && (!Array.isArray(meta.tools) || meta.tools.length > 0))) {
      throw new Error('This conversation contains files, tool history, or custom instructions. Start a new short text chat for experimental HAG; your existing conversation is unchanged.');
    }
  }
}

/** Byte-level admission is conservative for this pinned byte-BPE tokenizer, including framing. */
export function hagPreviewPromptBound(messages: readonly Message[]): number {
  return 64 + messages.reduce((sum, message) => sum + new TextEncoder().encode(message.content).length + 32, 0);
}

/** Reject broad/agent callers before transport. The ordinary composer prepares this explicit preview. */
export function assertHagPreview(request: ChatRequest): void {
  if (request.model !== HAG_MODEL_ID || request.tools?.length || request.useTools !== false ||
      request.messages[0]?.role !== 'system' || request.messages[0]?.content !== HAG_PREVIEW_SYSTEM ||
      request.messages.slice(1).some((message) => !['user', 'assistant'].includes(message.role) || message.toolCalls?.length || message.toolCallId) ||
      request.messages.some((message) => typeof message.content !== 'string') ||
      request.messages.some((message) => Object.keys(message).some((key) => !['id', 'role', 'content', 'toolCalls', 'toolCallId', 'name'].includes(key))) ||
      !Number.isSafeInteger(request.maxTokens) || request.maxTokens! < 1 || request.maxTokens! > HAG_PREVIEW_MAX_OUTPUT_TOKENS ||
      (request.temperature !== undefined && request.temperature !== 0)) {
    throw new Error('Experimental HAG supports bounded text-only chat with its Qwen3 0.6B model. Tools, project context, and agent tasks are not enabled.');
  }
  if (hagPreviewPromptBound(request.messages) + request.maxTokens! - 1 > HAG_PREVIEW_MAX_EVALUATED_TOKENS) {
    throw new Error('This conversation exceeds the experimental HAG text-preview budget. Start a new short chat or choose your previous model. No history was dropped.');
  }
}

export function prepareHagPreview(request: ChatRequest, conversation: readonly Message[]): ChatRequest {
  // A caller-provided instruction is part of its request, not disposable project grounding.
  if (request.messages.some((message) => message.role === 'system' && message.content !== HAG_PREVIEW_SYSTEM)) {
    throw new Error('Experimental HAG uses its fixed text-preview instructions. Start a normal short chat without custom system messages.');
  }
  const preview: ChatRequest = { ...request, model: HAG_MODEL_ID, useTools: false, tools: undefined,
    messages: [{ id: 'hag-preview-system', role: 'system', content: HAG_PREVIEW_SYSTEM },
      ...conversation.filter((message) => message.role !== 'system')],
    maxTokens: HAG_PREVIEW_MAX_OUTPUT_TOKENS, temperature: 0, thinkingLevel: 'off' };
  if (request.model !== HAG_MODEL_ID) throw new Error('The experimental HAG source serves only Qwen3 0.6B.');
  assertHagPreview(preview);
  return preview;
}

/** Explicit, reversible opt-in to the separately packaged native HAG experiment. */
export interface HagExperimentalState {
  showWelcome: boolean;
  enabled: boolean;
  available: boolean;
  unavailableReason: string | null;
  status: 'disabled' | 'downloading' | 'stopped' | 'starting' | 'ready' | 'error';
  error: string | null;
  model: { id: string; name: string; maxEvaluatedTokens: number };
  sourceId: string;
  modelDownloadBytes: number | null;
  downloadProgress: { receivedBytes: number; totalBytes: number } | null;
}

export interface HagExperimentalAPI {
  state(): Promise<HagExperimentalState>;
  enable(): Promise<HagExperimentalState>;
  disable(): Promise<HagExperimentalState>;
  dismissWelcome(): Promise<HagExperimentalState>;
  onChanged(callback: (state: HagExperimentalState) => void): () => void;
}
