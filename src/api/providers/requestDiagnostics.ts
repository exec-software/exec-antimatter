import { createHmac, randomBytes } from 'node:crypto';
import type { InferenceRequestDiagnostics } from '../types';

// A plain hash could expose short, guessable prompts. The key never leaves the main process.
const sessionKey = randomBytes(32);
const MAX_THREADS = 64;
const MAX_MESSAGE_FINGERPRINTS = 4096;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const length = (value: unknown): number => typeof value === 'string' ? value.length : 0;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

const fingerprint = (value: unknown): string => createHmac('sha256', sessionKey)
  .update(JSON.stringify(canonical(value))).digest('hex');

interface PreviousRequest {
  diagnostics: InferenceRequestDiagnostics;
  messageFingerprints: string[];
}

/** Stores bounded hashes/counts only, scoped to this provider instance and conversation. */
export class RequestDiagnostics {
  private readonly previous = new Map<string, PreviousRequest>();

  capture(body: Record<string, unknown>, threadId?: string): InferenceRequestDiagnostics {
    const messages = Array.isArray(body.messages) ? body.messages.map(object) : [];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const { messages: _messages, tools: _tools, ...settings } = body;
    const messageFingerprints = messages.slice(0, MAX_MESSAGE_FINGERPRINTS).map(fingerprint);
    const toolResults = messages.filter((message) => message.role === 'tool');
    const calls = messages.flatMap((message) => Array.isArray(message.tool_calls) ? message.tool_calls.map(object) : []);
    const reasoningCharacters = messages.reduce((sum, message) => sum + length(message.reasoning_content), 0);
    const diagnostics: InferenceRequestDiagnostics = {
      fingerprintScope: 'app-session',
      payloadFingerprint: fingerprint(body),
      systemFingerprint: fingerprint(messages.filter((message) => message.role === 'system')),
      toolsFingerprint: fingerprint(tools),
      settingsFingerprint: fingerprint(settings),
      messageCount: messages.length,
      messageCharacters: messages.reduce((sum, message) => sum + length(message.content), 0) + reasoningCharacters,
      ...(reasoningCharacters ? { reasoningCharacters } : {}),
      toolResultCount: toolResults.length,
      toolResultCharacters: toolResults.reduce((sum, message) => sum + length(message.content), 0),
      toolCallCount: calls.length,
      toolCallArgumentCharacters: calls.reduce((sum, call) => sum + length(object(call.function).arguments), 0),
      toolDefinitionCount: tools.length,
    };
    const previous = threadId ? this.previous.get(threadId) : undefined;
    if (previous) {
      const count = Math.min(messageFingerprints.length, previous.messageFingerprints.length);
      let commonPrefixMessages = 0;
      while (commonPrefixMessages < count && messageFingerprints[commonPrefixMessages] === previous.messageFingerprints[commonPrefixMessages]) commonPrefixMessages++;
      diagnostics.comparison = {
        previousPayloadFingerprint: previous.diagnostics.payloadFingerprint,
        sameSystem: diagnostics.systemFingerprint === previous.diagnostics.systemFingerprint,
        sameTools: diagnostics.toolsFingerprint === previous.diagnostics.toolsFingerprint,
        sameSettings: diagnostics.settingsFingerprint === previous.diagnostics.settingsFingerprint,
        commonPrefixMessages,
        prefixComparisonTruncated: commonPrefixMessages === MAX_MESSAGE_FINGERPRINTS &&
          Math.min(messages.length, previous.diagnostics.messageCount) > MAX_MESSAGE_FINGERPRINTS,
      };
    }
    if (threadId) {
      this.previous.delete(threadId);
      this.previous.set(threadId, { diagnostics: { ...diagnostics, comparison: undefined }, messageFingerprints });
      if (this.previous.size > MAX_THREADS) this.previous.delete(this.previous.keys().next().value!);
    }
    return diagnostics;
  }
}
