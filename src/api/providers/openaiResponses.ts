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
import { readServerSentEvents } from './sse';

/** A request-time destination override supplied by an app-managed source. */
export interface PreparedNativeProviderConnection {
  baseUrl: string;
  apiKey: string;
}

interface PartialFunctionCall {
  id: string;
  name: string;
  arguments: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function wireArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload.type === 'error' && typeof payload.message === 'string') {
    const code = typeof payload.code === 'string' && payload.code ? ` (${payload.code})` : '';
    return `${payload.message}${code}`;
  }
  const candidate = payload.error ?? (isRecord(payload.response) ? payload.response.error : undefined);
  if (!candidate) return null;
  if (typeof candidate === 'string') return candidate;
  if (!isRecord(candidate)) return String(candidate);

  const message = typeof candidate.message === 'string' ? candidate.message : JSON.stringify(candidate);
  const code = typeof candidate.code === 'string' && candidate.code ? ` (${candidate.code})` : '';
  return `${message}${code}`;
}

function eventType(payload: unknown): string {
  return isRecord(payload) && typeof payload.type === 'string' ? payload.type : '';
}

function responseStatus(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return typeof payload.status === 'string' ? payload.status : undefined;
}

/**
 * Accumulates both REST Response objects and their semantic streaming events.
 * Function calls are keyed by output index because argument deltas need not repeat call metadata.
 */
class ResponseAccumulator {
  private readonly calls = new Map<number, PartialFunctionCall>();
  private readonly replayItems = new Map<number, unknown>();
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

  private callAt(index: number): PartialFunctionCall | undefined {
    const existing = this.calls.get(index);
    if (existing) return existing;
    // Output indices count message and reasoning items too, so the cap is on how many calls are
    // open rather than on the index. Refusing the one past it is what ends the stream.
    if (this.calls.size >= this.cap) {
      this.cutOff = true;
      return undefined;
    }
    const created = { id: '', name: '', arguments: '' };
    this.calls.set(index, created);
    return created;
  }

  private absorbOutputItem(item: unknown, index: number, includeText: boolean): void {
    if (!isRecord(item)) return;
    if (item.type === 'function_call') {
      const call = this.callAt(index);
      // A call the cap refused must not be replayed either, or the next request carries a
      // function_call with no function_call_output answering it.
      if (!call) return;
      this.replayItems.set(index, item);
      if (typeof item.call_id === 'string') call.id = item.call_id;
      else if (!call.id && typeof item.id === 'string') call.id = item.id;
      if (typeof item.name === 'string') call.name = item.name;
      const args = wireArguments(item.arguments);
      if (args) call.arguments = args;
      return;
    }

    // Response output items are valid input items on the following request. Preserve the native
    // form so opaque reasoning/encrypted fields survive a stateless tool loop.
    this.replayItems.set(index, item);

    if (item.type === 'message' && includeText && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'output_text' || block.type === 'text' || block.type === 'refusal') {
          this.appendText(block.text ?? block.refusal);
        }
      }
      return;
    }

    if (item.type === 'reasoning' && (includeText || !this.reasoning)) {
      const summaries = Array.isArray(item.summary) ? item.summary : [];
      for (const summary of summaries) {
        if (isRecord(summary)) this.appendReasoning(summary.text);
      }
    }
  }

  absorbResponse(payload: unknown, includeText = true): void {
    if (!isRecord(payload)) return;
    const error = errorMessage(payload);
    if (error) throw new Error(error);

    const output = Array.isArray(payload.output) ? payload.output : [];
    output.forEach((item, index) => this.absorbOutputItem(item, index, includeText));

    // Some Responses-compatible implementations expose the SDK convenience field in raw JSON.
    if (includeText && !this.content && typeof payload.output_text === 'string') {
      this.appendText(payload.output_text);
    }

    const status = responseStatus(payload);
    const details = isRecord(payload.incomplete_details) ? payload.incomplete_details : undefined;
    if (status === 'incomplete' && details?.reason === 'max_output_tokens') this.finishReason = 'length';
    else if (status === 'incomplete' && typeof details?.reason === 'string') {
      this.finishReason = details.reason;
    }
    else if (status === 'completed' && !this.finishReason) this.finishReason = 'stop';
    else if (status === 'failed') throw new Error('response generation failed');
  }

  absorbEvent(payload: unknown): boolean {
    if (!isRecord(payload)) return false;
    const type = eventType(payload);

    if (type === 'error' || type === 'response.failed') {
      throw new Error(errorMessage(payload) ?? 'response generation failed');
    }
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      this.appendText(payload.delta);
    } else if (
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning_text.delta'
    ) {
      this.appendReasoning(payload.delta);
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const index = typeof payload.output_index === 'number' ? payload.output_index : this.calls.size;
      this.absorbOutputItem(payload.item, index, false);
    } else if (type === 'response.function_call_arguments.delta') {
      const index = typeof payload.output_index === 'number' ? payload.output_index : 0;
      const call = this.callAt(index);
      if (call) {
        if (!call.id && typeof payload.item_id === 'string') call.id = payload.item_id;
        if (typeof payload.delta === 'string') call.arguments += payload.delta;
      }
    } else if (type === 'response.function_call_arguments.done') {
      const index = typeof payload.output_index === 'number' ? payload.output_index : 0;
      const call = this.callAt(index);
      if (call) {
        if (!call.id && typeof payload.item_id === 'string') call.id = payload.item_id;
        const args = wireArguments(payload.arguments);
        if (args) call.arguments = args;
      }
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      // A completed event contains the full Response. Fill metadata and calls from it, but only
      // use its text if this server omitted the normal text deltas.
      this.absorbResponse(payload.response, !this.content);
      return true;
    }
    // A reply over the cap is finished as far as this turn is concerned: reading on would only
    // pay for calls that cannot run. Reported as terminal so the caller stops and the SSE
    // reader's own cleanup cancels the body.
    if (this.cutOff) return true;
    return false;
  }

  meaningful(): boolean {
    return Boolean(this.content || this.reasoning || [...this.calls.values()].some((call) => call.name));
  }

  result(): StreamResult {
    const toolCalls: ToolCall[] = [...this.calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call], index) => ({
        id: call.id || `call_${index}`,
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
      reasoning: this.reasoning,
      finishReason,
      toolCallsCutOff: this.cutOff,
    };
  }

  outputItems(): unknown[] {
    return [...this.replayItems.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, item]) => {
        const call = this.calls.get(index);
        return call && isRecord(item) && item.type === 'function_call'
          ? {
              ...item,
              call_id: call.id || item.call_id,
              name: call.name || item.name,
              arguments: call.arguments || item.arguments || '{}',
            }
          : item;
      });
  }
}

interface ResponseReplayGroup {
  callIds: string[];
  output: unknown[];
}

const MAX_REPLAY_RUNS = 128;

/** Native adapter for POST /v1/responses, including Responses-style function call items. */
export class OpenAIResponsesProvider extends BaseProvider {
  private readonly replayByRun = new Map<string, ResponseReplayGroup[]>();

  constructor(
    config: ProviderConfig,
    private readonly track?: () => () => void,
    private readonly prepare?: () => Promise<PreparedNativeProviderConnection | void>
  ) {
    super(config);
  }

  private endpoint(connection?: PreparedNativeProviderConnection | void): string {
    const base = (connection?.baseUrl ?? this.config.baseUrl).replace(/\/+$/, '');
    return base.endsWith('/responses') ? base : `${base}/responses`;
  }

  private replayKey(request: ChatRequest): string | undefined {
    return request.requestId ?? request.threadId;
  }

  private wireInput(request: ChatRequest): unknown[] {
    const input: unknown[] = [];
    const key = this.replayKey(request);
    const groups = key ? (this.replayByRun.get(key) ?? []) : [];
    const usedGroups = new Set<ResponseReplayGroup>();
    for (const message of request.messages) {
      if (message.role === 'system') continue;
      if (message.role === 'tool') {
        input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
        continue;
      }

      if (message.role === 'assistant') {
        const callIds = (message.toolCalls ?? []).map((call) => call.id);
        const replay = groups.find(
          (group) =>
            !usedGroups.has(group) &&
            callIds.length === group.callIds.length &&
            callIds.every((id) => group.callIds.includes(id))
        );
        if (replay) {
          input.push(...replay.output);
          usedGroups.add(replay);
          continue;
        }
      }

      if (message.content) input.push({ role: message.role, content: message.content });
      if (message.role === 'assistant') {
        for (const original of message.toolCalls ?? []) {
          const call = toolCallForHistory(original);
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
      }
    }
    return input;
  }

  private body(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const instructions = request.messages
      .filter((message) => message.role === 'system' && message.content.trim())
      .map((message) => message.content)
      .join('\n\n');
    return {
      model: request.model,
      ...thinkingParameters({ ...this.config, protocol: 'openai-responses' }, request),
      input: this.wireInput(request),
      // Antimatter owns the durable transcript. Keep provider-side storage off and ask reasoning
      // models for the opaque encrypted item needed to replay a stateless tool round faithfully.
      store: false,
      include: ['reasoning.encrypted_content'],
      ...(instructions ? { instructions } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      max_output_tokens: request.maxTokens ?? 4096,
      stream,
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function',
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.parameters,
            })),
          }
        : {}),
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
          Authorization: `Bearer ${apiKey}`,
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
    const accumulator = new ResponseAccumulator(request.requestId ?? request.model, callback, toolCallCap(request.maxToolCalls));

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
      const error = errorMessage(payload);
      if (error) throw new Error(`${this.config.name} request failed: ${redactProviderSecrets(error, apiKey)}`);
      try {
        meter.observe(payload, 'openai-responses', false);
        accumulator.absorbResponse(payload);
      } catch (caught) {
        throw new Error(
          `${this.config.name} request failed: ${redactProviderSecrets((caught as Error).message, apiKey)}`
        );
      }
      const result = { ...accumulator.result(), metrics: meter.finish() };
      this.rememberOutput(request, accumulator, result);
      return result;
    }

    let malformedFrames = 0;
    let terminalEventReceived = false;
    for await (const event of readServerSentEvents(response, onAlive, signal)) {
      const data = event.data.trim();
      if (!data) continue;
      if (data === '[DONE]') {
        terminalEventReceived = true;
        break;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        malformedFrames += 1;
        continue;
      }

      try {
        meter.observe(payload, 'openai-responses', true);
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
    this.rememberOutput(request, accumulator, result);
    return result;
  }

  private rememberOutput(
    request: ChatRequest,
    accumulator: ResponseAccumulator,
    result: StreamResult
  ): void {
    const key = this.replayKey(request);
    if (!key) return;
    if (!result.toolCalls.length) {
      this.replayByRun.delete(key);
      return;
    }

    const output = accumulator.outputItems();
    const nativeCallIds = output
      .filter(isRecord)
      .filter((item) => item.type === 'function_call' && typeof item.call_id === 'string')
      .map((item) => item.call_id as string);
    const callIds = result.toolCalls.map((call) => call.id);
    if (!callIds.every((id) => nativeCallIds.includes(id))) return;

    const groups = this.replayByRun.get(key) ?? [];
    const withoutSameCalls = groups.filter(
      (group) => !group.callIds.some((id) => callIds.includes(id))
    );
    withoutSameCalls.push({ callIds, output });
    // Failed/cancelled turns may never reach the tool-free response that normally clears this
    // state. Keep it bounded while retaining enough live runs for concurrent orchestration.
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
