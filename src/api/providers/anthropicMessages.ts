import { thinkingParameters } from '../thinking';
import { InferenceMeter } from './metrics';
import { toolCallCap, toolCallForHistory } from '../toolArguments';
import type {
  ChatRequest,
  LivenessCallback,
  Message,
  ProviderConfig,
  StreamCallback,
  StreamResult,
  ToolCall,
} from '../types';
import { BaseProvider } from './base';
import {
  boundedResponseJson,
  boundedResponseText,
  MAX_PROVIDER_ERROR_BYTES,
  publicProviderEndpoint,
  redactProviderSecrets,
} from './httpBody';
import type { PreparedNativeProviderConnection } from './openaiResponses';
import { readServerSentEvents } from './sse';

interface PartialToolUse {
  id: string;
  name: string;
  arguments: string;
}

interface AnthropicWireMessage {
  role: 'user' | 'assistant';
  content: Array<Record<string, unknown>>;
}

const MAX_REPLAY_RUNS = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function apiError(payload: unknown): string | null {
  if (!isRecord(payload) || !payload.error) return null;
  const error = payload.error;
  if (typeof error === 'string') return error;
  if (!isRecord(error)) return String(error);
  const message = typeof error.message === 'string' ? error.message : JSON.stringify(error);
  const type = typeof error.type === 'string' && error.type ? ` (${error.type})` : '';
  return `${message}${type}`;
}

function parseArguments(call: ToolCall): Record<string, unknown> {
  const safe = toolCallForHistory(call);
  return JSON.parse(safe.function.arguments) as Record<string, unknown>;
}

function stopReason(reason: unknown): string | undefined {
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'length';
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  return typeof reason === 'string' && reason ? reason : undefined;
}

class MessageAccumulator {
  private readonly calls = new Map<number, PartialToolUse>();
  private readonly replayBlocks = new Map<number, Record<string, unknown>>();
  content = '';
  reasoning = '';
  finishReason: string | undefined;

  /** Set once a reply asked for a call beyond the cap; see ChatRequest.maxToolCalls. */
  cutOff = false;

  constructor(
    private readonly requestId: string,
    private readonly callback?: StreamCallback,
    private readonly cap: number = toolCallCap()
  ) {}

  private appendText(text: unknown): void {
    if (typeof text !== 'string' || !text) return;
    this.content += text;
    this.callback?.({ id: this.requestId, content: text });
  }

  private appendReasoning(text: unknown): void {
    if (typeof text !== 'string' || !text) return;
    this.reasoning += text;
    // Its own field, never `content`: see StreamCallback.
    this.callback?.({ id: this.requestId, content: '', reasoning: text });
  }

  private callAt(index: number): PartialToolUse | undefined {
    const existing = this.calls.get(index);
    if (existing) return existing;
    // Block indices count text and thinking blocks too, so the cap is on how many calls are
    // open rather than on the index. Refusing the one past it is what ends the stream.
    if (this.calls.size >= this.cap) {
      this.cutOff = true;
      return undefined;
    }
    const created = { id: '', name: '', arguments: '' };
    this.calls.set(index, created);
    return created;
  }

  private startBlock(block: unknown, index: number, includeText: boolean): void {
    if (!isRecord(block)) return;
    if (block.type === 'tool_use') {
      const call = this.callAt(index);
      // A call the cap refused must not be replayed either. Recorded here rather than above so
      // the native history never carries a tool_use with no tool_result answering it.
      if (!call) return;
      this.replayBlocks.set(index, { ...block });
      if (typeof block.id === 'string') call.id = block.id;
      if (typeof block.name === 'string') call.name = block.name;
      if (isRecord(block.input) && Object.keys(block.input).length > 0) {
        call.arguments = JSON.stringify(block.input);
      }
      return;
    }

    this.replayBlocks.set(index, { ...block });
    if (block.type === 'text' && includeText) {
      this.appendText(block.text);
    } else if ((block.type === 'thinking' || block.type === 'redacted_thinking') && includeText) {
      this.appendReasoning(block.thinking);
    }
  }

  absorbMessage(payload: unknown, includeText = true): void {
    if (!isRecord(payload)) return;
    const error = apiError(payload);
    if (error) throw new Error(error);
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    blocks.forEach((block, index) => this.startBlock(block, index, includeText));
    this.finishReason = stopReason(payload.stop_reason) ?? this.finishReason;
  }

  absorbEvent(payload: unknown): boolean {
    if (!isRecord(payload)) return false;
    const type = typeof payload.type === 'string' ? payload.type : '';
    if (type === 'error') throw new Error(apiError(payload) ?? 'message generation failed');

    if (type === 'content_block_start') {
      const index = typeof payload.index === 'number' ? payload.index : this.calls.size;
      this.startBlock(payload.content_block, index, true);
    } else if (type === 'content_block_delta' && isRecord(payload.delta)) {
      const index = typeof payload.index === 'number' ? payload.index : 0;
      const replay = this.replayBlocks.get(index);
      if (payload.delta.type === 'text_delta') {
        this.appendText(payload.delta.text);
        if (replay && typeof payload.delta.text === 'string') {
          replay.text = `${typeof replay.text === 'string' ? replay.text : ''}${payload.delta.text}`;
        }
      } else if (payload.delta.type === 'thinking_delta') {
        this.appendReasoning(payload.delta.thinking);
        if (replay && typeof payload.delta.thinking === 'string') {
          replay.thinking = `${typeof replay.thinking === 'string' ? replay.thinking : ''}${payload.delta.thinking}`;
        }
      } else if (payload.delta.type === 'signature_delta') {
        if (replay && typeof payload.delta.signature === 'string') replay.signature = payload.delta.signature;
      } else if (payload.delta.type === 'refusal_delta') {
        this.appendText(payload.delta.refusal);
      } else if (payload.delta.type === 'input_json_delta') {
        const call = this.callAt(index);
        if (call && typeof payload.delta.partial_json === 'string') call.arguments += payload.delta.partial_json;
      }
    } else if (type === 'message_delta' && isRecord(payload.delta)) {
      this.finishReason = stopReason(payload.delta.stop_reason) ?? this.finishReason;
    } else if (type === 'message_stop') {
      return true;
    }
    // A reply over the cap is finished as far as this turn is concerned: reading on would only
    // pay for calls that cannot run. Reported as terminal so the caller stops and the SSE
    // reader's own cleanup cancels the body.
    if (this.cutOff) return true;
    // Ping and future event types are intentionally ignored after proving liveness at the SSE layer.
    return false;
  }

  meaningful(): boolean {
    return Boolean(this.content || this.reasoning || [...this.calls.values()].some((call) => call.name));
  }

  result(): StreamResult {
    const toolCalls: ToolCall[] = [...this.calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call], index) => ({
        id: call.id || `toolu_${index}`,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments || '{}' },
      }))
      .filter((call) => call.function.name);
    const finishReason =
      this.finishReason === 'length'
        ? 'length'
        : toolCalls.length && (!this.finishReason || this.finishReason === 'stop')
          ? 'tool_calls'
          : (this.finishReason ?? 'stop');
    return {
      content: this.content,
      toolCalls,
      finishReason,
      reasoning: this.reasoning,
      toolCallsCutOff: this.cutOff,
    };
  }

  contentBlocks(): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];
    for (const [index, block] of [...this.replayBlocks.entries()].sort(([left], [right]) => left - right)) {
      if (block.type !== 'tool_use') {
        blocks.push(block);
        continue;
      }
      const call = this.calls.get(index);
      if (!call) return [];
      try {
        blocks.push({
          ...block,
          id: call.id || block.id,
          name: call.name || block.name,
          input: JSON.parse(call.arguments || '{}') as unknown,
        });
      } catch {
        // A cut-off input_json_delta is not a valid native content block. Fall back to the
        // generic repaired history instead of caching a payload Anthropic will reject.
        return [];
      }
    }
    return blocks;
  }
}

interface MessageReplayGroup {
  callIds: string[];
  content: Array<Record<string, unknown>>;
}

/** Native adapter for Anthropic's Messages API and its indexed content-block stream. */
export class AnthropicMessagesProvider extends BaseProvider {
  private readonly replayByRun = new Map<string, MessageReplayGroup[]>();

  constructor(
    config: ProviderConfig,
    private readonly track?: () => () => void,
    private readonly prepare?: () => Promise<PreparedNativeProviderConnection | void>
  ) {
    super(config);
  }

  private endpoint(connection?: PreparedNativeProviderConnection | void): string {
    const base = (connection?.baseUrl ?? this.config.baseUrl).replace(/\/+$/, '');
    if (base.endsWith('/messages')) return base;
    return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  }

  private replayKey(request: ChatRequest): string | undefined {
    return request.requestId ?? request.threadId;
  }

  private wireMessages(request: ChatRequest): AnthropicWireMessage[] {
    const wired: AnthropicWireMessage[] = [];
    const key = this.replayKey(request);
    const groups = key ? (this.replayByRun.get(key) ?? []) : [];
    const usedGroups = new Set<MessageReplayGroup>();
    const append = (role: 'user' | 'assistant', blocks: Array<Record<string, unknown>>): void => {
      if (!blocks.length) return;
      const previous = wired.at(-1);
      if (previous?.role === role) previous.content.push(...blocks);
      else wired.push({ role, content: blocks });
    };
    const appendToolResult = (block: Record<string, unknown>): void => {
      const previous = wired.at(-1);
      if (previous?.role !== 'user') {
        wired.push({ role: 'user', content: [block] });
        return;
      }
      const firstNonResult = previous.content.findIndex((content) => content.type !== 'tool_result');
      if (firstNonResult < 0) previous.content.push(block);
      else previous.content.splice(firstNonResult, 0, block);
    };

    for (const message of request.messages) {
      if (message.role === 'system') continue;
      if (message.role === 'tool') {
        appendToolResult({
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
        });
        continue;
      }

      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const blocks: Array<Record<string, unknown>> = [];
      if (role === 'assistant' && message.toolCalls?.length) {
        const callIds = message.toolCalls.map((call) => call.id);
        const replay = groups.find(
          (group) =>
            !usedGroups.has(group) &&
            callIds.length === group.callIds.length &&
            callIds.every((id) => group.callIds.includes(id))
        );
        if (replay) {
          append('assistant', replay.content);
          usedGroups.add(replay);
          continue;
        }
      }
      if (message.content) blocks.push({ type: 'text', text: message.content });
      if (role === 'assistant') {
        for (const call of message.toolCalls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: parseArguments(call),
          });
        }
      }
      append(role, blocks);
    }
    return wired;
  }

  private body(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const system = request.messages
      .filter((message) => message.role === 'system' && message.content.trim())
      .map((message) => message.content)
      .join('\n\n');
    const messages = this.wireMessages(request);
    const tools = request.tools?.length
      ? request.tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters,
        }))
      : undefined;

    /**
     * Prompt caching.
     *
     * The prefix is read in a fixed order -- tools, then system, then the turns -- so a
     * breakpoint caches everything before it. Three are placed and one of the four allowed is
     * left spare:
     *
     *  - the last tool, so the schemas are cached on their own. They are the most stable thing
     *    in the request and the slowest to re-read.
     *  - the system text, which caches tools *and* system together.
     *  - the newest completed assistant turn, a rolling breakpoint: this turn writes the cache
     *    and the next turn reads it, so a growing conversation is re-read once per exchange
     *    instead of in full every time.
     *
     * A prefix under the model's minimum is simply not cached, so no size check is needed here.
     * What this cannot survive is the prefix changing: rewriting the system text or an earlier
     * turn moves the breakpoint and the read is lost. That invariant is asserted in the tests.
     */
    const breakpoint = { type: 'ephemeral' } as const;
    if (tools?.length) Object.assign(tools[tools.length - 1], { cache_control: breakpoint });
    const newestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    const lastBlock = newestAssistant?.content.at(-1);
    if (lastBlock) Object.assign(lastBlock, { cache_control: breakpoint });

    return {
      model: request.model,
      ...thinkingParameters({ ...this.config, protocol: 'anthropic-messages' }, request),
      messages,
      ...(system ? { system: [{ type: 'text', text: system, cache_control: breakpoint }] } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      max_tokens: request.maxTokens ?? 4096,
      stream,
      ...(tools ? { tools } : {}),
    };
  }

  private async post(
    body: Record<string, unknown>,
    signal?: AbortSignal,
    connection?: PreparedNativeProviderConnection | void
  ): Promise<Response> {
    const url = this.endpoint(connection);
    const apiKey = connection?.apiKey ?? this.config.apiKey;
    if (signal?.aborted) throw new Error('the turn was stopped');
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted || (error as { name?: unknown })?.name === 'AbortError') {
        throw new Error('the turn was stopped');
      }
      const cause = (error as Error & { cause?: Error }).cause?.message ?? (error as Error).message;
      throw new Error(
        `${this.config.name} did not answer at ${publicProviderEndpoint(url)} ` +
          `(${redactProviderSecrets(cause, apiKey)}). Is the service reachable?`
      );
    }

    if (!response.ok) {
      const detail = redactProviderSecrets(
        (await boundedResponseText(response, MAX_PROVIDER_ERROR_BYTES).catch(() => '')).trim(),
        apiKey
      );
      const statusText = redactProviderSecrets(response.statusText, apiKey);
      throw new Error(
        `${this.config.name} refused the request: ${response.status} ${statusText}${detail ? ` — ${detail.slice(0, 400)}` : ''}`
      );
    }
    return response;
  }

  private async complete(
    request: ChatRequest,
    stream: boolean,
    callback?: StreamCallback,
    onAlive?: LivenessCallback,
    signal?: AbortSignal,
    connection?: PreparedNativeProviderConnection | void
  ): Promise<StreamResult> {
    const meter = new InferenceMeter(request.requestId ?? request.model, callback);
    const response = await this.post(this.body(request, stream), signal, connection);
    const apiKey = connection?.apiKey ?? this.config.apiKey;
    const accumulator = new MessageAccumulator(request.requestId ?? request.model, callback, toolCallCap(request.maxToolCalls));

    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      let payload: unknown;
      try {
        payload = await boundedResponseJson(response);
      } catch (error) {
        if (signal?.aborted || (error as { name?: unknown })?.name === 'AbortError') {
          throw new Error('the turn was stopped');
        }
        throw new Error(`${this.config.name} returned malformed JSON.`);
      }
      const error = apiError(payload);
      if (error) throw new Error(`${this.config.name} request failed: ${redactProviderSecrets(error, apiKey)}`);
      try {
        meter.observe(payload, 'anthropic-messages', false);
        accumulator.absorbMessage(payload);
      } catch (caught) {
        throw new Error(
          `${this.config.name} request failed: ${redactProviderSecrets((caught as Error).message, apiKey)}`
        );
      }
      const result = { ...accumulator.result(), metrics: meter.finish() };
      this.rememberContent(request, accumulator, result);
      return result;
    }

    let malformedFrames = 0;
    let terminalEventReceived = false;
    for await (const event of readServerSentEvents(response, onAlive, signal)) {
      const data = event.data.trim();
      if (!data) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        malformedFrames += 1;
        continue;
      }

      try {
        meter.observe(payload, 'anthropic-messages', true);
        if (accumulator.absorbEvent(payload)) {
          terminalEventReceived = true;
          break;
        }
      } catch (caught) {
        throw new Error(
          `${this.config.name} stream failed: ${redactProviderSecrets((caught as Error).message, apiKey)}`
        );
      }
    }

    if (malformedFrames > 0 && !accumulator.meaningful()) {
      throw new Error(`${this.config.name} returned malformed streaming data without usable output.`);
    }
    if (!terminalEventReceived) {
      throw new Error(`${this.config.name} stream ended before its completion event.`);
    }
    const result = { ...accumulator.result(), metrics: meter.finish() };
    this.rememberContent(request, accumulator, result);
    return result;
  }

  private rememberContent(
    request: ChatRequest,
    accumulator: MessageAccumulator,
    result: StreamResult
  ): void {
    const key = this.replayKey(request);
    if (!key) return;
    if (!result.toolCalls.length) {
      this.replayByRun.delete(key);
      return;
    }

    const content = accumulator.contentBlocks();
    const nativeCallIds = content
      .filter((block) => block.type === 'tool_use' && typeof block.id === 'string')
      .map((block) => block.id as string);
    const callIds = result.toolCalls.map((call) => call.id);
    if (!content.length || !callIds.every((id) => nativeCallIds.includes(id))) return;

    const groups = this.replayByRun.get(key) ?? [];
    const withoutSameCalls = groups.filter(
      (group) => !group.callIds.some((id) => callIds.includes(id))
    );
    withoutSameCalls.push({ callIds, content });
    this.replayByRun.delete(key);
    this.replayByRun.set(key, withoutSameCalls);
    while (this.replayByRun.size > MAX_REPLAY_RUNS) {
      const oldest = this.replayByRun.keys().next().value as string | undefined;
      if (!oldest) break;
      this.replayByRun.delete(oldest);
    }
  }

  override async chat(request: ChatRequest, signal?: AbortSignal): Promise<string> {
    const end = this.track?.();
    try {
      const connection = await this.prepare?.();
      return (await this.complete(request, false, undefined, undefined, signal, connection)).content;
    } finally {
      end?.();
    }
  }

  override async stream(
    request: ChatRequest,
    callback: StreamCallback,
    onAlive?: LivenessCallback,
    signal?: AbortSignal
  ): Promise<StreamResult> {
    const end = this.track?.();
    try {
      const connection = await this.prepare?.();
      return await this.complete(request, true, callback, onAlive, signal, connection);
    } finally {
      end?.();
    }
  }
}
