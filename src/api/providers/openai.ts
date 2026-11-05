import { thinkingParameters, thinkingSupport } from '../thinking';
import { withoutReasoningHistory } from '../requestMessages';
import { InferenceMeter } from './metrics';
import { RequestDiagnostics } from './requestDiagnostics';
import { BaseProvider } from './base';
import type { ChatRequest, LivenessCallback, ProviderConfig, StreamCallback, StreamResult, ToolCall } from '../types';
import { toolCallCap, toolCallForHistory } from '../toolArguments';
import { conversationTokens, toolDefinitionTokens } from '../tokenEstimate';
import { HAG_SOURCE_ID, assertHagPreview } from '../hag';
import {
  boundedResponseJson,
  boundedResponseText,
  MAX_PROVIDER_ERROR_BYTES,
  publicProviderEndpoint,
  redactProviderSecrets,
} from './httpBody';

/** A request-time destination override supplied by an app-managed local service. */
export interface PreparedProviderConnection {
  baseUrl: string;
  apiKey: string;
}

/** One streamed tool call, assembled from however many deltas the server splits it across. */
interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Some compatible servers return parsed arguments in a final message instead of JSON text. */
function wireArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Turns an OpenAI error envelope into the useful part of the message. */
function responseError(payload: any): string | null {
  if (!payload?.error) return null;
  const error = payload.error;
  const message = typeof error === 'string' ? error : error.message || JSON.stringify(error);
  const code = typeof error === 'object' && error?.code ? ` (${error.code})` : '';
  return `${message}${code}`;
}

/**
 * Local runtimes that lazy-load a cold model on first use and can keep that first request (and
 * requests arriving mid-load) unanswered while it loads. For these, a transport stall means a
 * load-in-progress, not a dead server, so `post()` retries within a budget. Remote endpoints
 * must never be re-sent after a transport failure, so the retry is scoped to this set.
 */
const LOCAL_LOADING_KINDS = new Set(['beholdd', 'llama-cpp', 'ollama']);

/** Hard ceiling on retrying a request parked behind a cold-model load. MiMo cold load ≈ 8 min. */
const MODEL_LOAD_RETRY_WINDOW_MS = 20 * 60_000;

/** Pause between retries; beholdd's own Retry-After is 10s. */
const LOAD_RETRY_PAUSE_MS = 10_000;

/** How long the socket probe waits before treating silence as "listening but busy". */
const LISTENING_PROBE_TIMEOUT_MS = 5_000;

/**
 * Transport failures that mean nothing is on the other end, as opposed to something slow. Only
 * these end the retry: a refused or unreachable socket is a runtime that is not running.
 */
const UNREACHABLE_CODES =
  /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EAI_AGAIN|EPIPE/i;

/** beholdd's 503 loading envelope: `{"error": {"type": "model_loading", ...}}`. */
interface LoadingPayload {
  error?: { type?: string; message?: string; model?: string; loading_seconds?: number };
}

function parseErrorPayload(raw: string): LoadingPayload | null {
  try {
    const parsed = JSON.parse(raw) as LoadingPayload;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * How long `Retry-After` asks us to wait, in milliseconds. Accepts the integer-seconds form and
 * the HTTP-date form, and falls back to the caller's pause when the header is absent or junk.
 * Capped, because a server is allowed to say an hour and the caller has its own deadline.
 */
function loadRetryAfterMs(response: Response, fallbackMs: number): number {
  const header = response.headers.get('retry-after')?.trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 120) * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(Math.max(1000, date - Date.now()), 120_000);
  }
  return fallbackMs;
}

/**
 * undici reports a connection that accepted a request but never sent response headers as a
 * "Headers Timeout" transport failure — the shape this app logs as `did not answer …
 * (Headers Timeout Error)`. That is the signature of a request parked behind a cold-model
 * load, not a dead upstream.
 */
function isStalledTransportError(error: unknown): boolean {
  const chain = errorChain(error);
  return /\bheaders?\s*timeout\b/i.test(chain) || /UND_ERR_HEADERS_TIMEOUT/i.test(chain);
}

/** fetch reports the interesting part on `cause`; flatten both levels into one searchable string. */
function errorChain(error: unknown): string {
  const e = error as Error & { code?: string; cause?: Error & { code?: string } };
  return [e?.name, e?.message, e?.code, e?.cause?.name, e?.cause?.message, e?.cause?.code]
    .filter(Boolean)
    .join(' ');
}

/** Nothing is on the other end, as opposed to something too busy to answer yet. */
function isUnreachable(error: unknown): boolean {
  return UNREACHABLE_CODES.test(errorChain(error));
}

/** Sleep that honors the caller's abort signal, so stopping a turn interrupts the retry loop. */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('the turn was stopped'));
      return;
    }
    const onAbort = () => {
      cleanup();
      reject(new Error('the turn was stopped'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class OpenAICompatibleProvider extends BaseProvider {
  private readonly requestDiagnostics = new RequestDiagnostics();
  /** Called as a request opens; the function it returns is called once it is over. */
  constructor(
    config: ProviderConfig,
    private readonly track?: () => () => void,
    private readonly prepare?: (modelId?: string, signal?: AbortSignal) => Promise<PreparedProviderConnection | void>
  ) {
    super(config);
  }

  private endpoint(connection?: PreparedProviderConnection | void): string {
    return `${(connection?.baseUrl ?? this.config.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  }

  private supportsReasoningHistory(request: ChatRequest): boolean {
    // Qwen3.8 explicitly preserves reasoning between tool calls. Keep this opt-in narrow:
    // other compatible servers (especially strict beholdd) may reject extra message fields.
    return this.config.kind === 'llama-cpp' && request.providerId === this.config.id &&
      /(?:^|\/)qwen3[.-]8-27b(?:[-/:]|$)/i.test(request.model);
  }

  private completedReasoning(request: ChatRequest, reasoning: string, servedModel?: string) {
    if (!reasoning || !this.supportsReasoningHistory(request) ||
        (servedModel && servedModel !== request.model)) return {};
    return { reasoningHistory: { content: reasoning, providerId: this.config.id, model: request.model } };
  }

  override prepareMessages(request: ChatRequest) {
    const supported = this.supportsReasoningHistory(request);
    return request.messages.map(message => {
      const history = message.reasoningHistory;
      return supported && message.role === 'assistant' && history?.providerId === this.config.id &&
        history.model === request.model && typeof history.content === 'string'
        ? message : withoutReasoningHistory(message);
    });
  }

  /**
   * Tool results and tool calls ride in fields the plain chat path never sets.
   *
   * The loop also injects out-of-band turns -- steering notes, background chat reports, the
   * auto-continue nudge -- and emits an assistant turn per round, so a transcript reaching here
   * can hold two user turns or two assistant turns in a row. Hosted APIs accept that; a strict
   * Jinja chat template does not. Mistral's raises outright:
   *
   *   After the optional system message, conversation roles must alternate user and assistant
   *   roles except for tool calls and results.
   *
   * Its parity counter looks only at user turns and at assistant turns *without* tool calls,
   * skipping tool results and tool-calling assistant turns entirely, and demands the counted run
   * read user, assistant, user, assistant. It also accepts `system` only at index 0, and rejects
   * an assistant turn carrying neither content nor tool calls. So canonicalize all three here,
   * the way the Anthropic path already coalesces for that API's own alternation rule.
   */
  private wireMessages(request: ChatRequest) {
    type Wire = { role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown[]; reasoning_content?: string };
    const wired: Wire[] = [];
    const system: string[] = [];
    // The newest counted turn, held by reference so a repeat can merge straight into it.
    let counted: Wire | undefined;

    for (const message of request.messages) {
      const history = message.reasoningHistory;
      const reasoning = message.role === 'assistant' && this.supportsReasoningHistory(request) &&
        history?.providerId === this.config.id && history.model === request.model &&
        typeof history.content === 'string' ? history.content : undefined;
      if (message.role === 'system') {
        // Several system turns, or one that arrived late, collapse into the single leading block.
        if (message.content) system.push(message.content);
        continue;
      }
      if (message.role === 'tool') {
        wired.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
        continue;
      }
      if (message.toolCalls?.length) {
        // Old persisted transcripts may predate the loop-side repair. Never keep forwarding a
        // truncated JSON fragment: compatible servers otherwise repair/log the same bad call on
        // every request for the rest of the conversation.
        wired.push({
          // Empty string, not null: a tool-calling turn skips the template's `is string` branch
          // and falls through to `content | length`, which throws on null. '' satisfies both, and
          // the OpenAI schema accepts either for a turn that carries tool calls.
          role: message.role,
          content: message.content || '',
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          tool_calls: message.toolCalls.map((call) => toolCallForHistory(call)),
        });
        continue;
      }
      // An assistant turn with no text and no calls says nothing and is rejected outright, so it
      // is dropped rather than merged -- it would otherwise leave a stray blank line behind.
      if (message.role === 'assistant' && !message.content) continue;
      // The format cannot express an assistant turn before the first user turn.
      if (message.role === 'assistant' && !counted) continue;
      if (counted?.role === message.role) {
        // Adjacency is judged on the counted run, so a note separated from the previous turn by
        // only tool traffic still merges. That can render an injected note a little earlier than
        // it arrived, which is immaterial for one that was out-of-band to begin with, and is
        // preferable to inventing a turn to pad the sequence with.
        counted.content = counted.content ? `${counted.content}\n\n${message.content}` : message.content;
        if (reasoning) counted.reasoning_content = counted.reasoning_content
          ? `${counted.reasoning_content}\n\n${reasoning}` : reasoning;
        continue;
      }
      const entry: Wire = { role: message.role, content: message.content,
        ...(reasoning ? { reasoning_content: reasoning } : {}) };
      wired.push(entry);
      counted = entry;
    }

    return system.length ? [{ role: 'system', content: system.join('\n\n') }, ...wired] : wired;
  }

  private body(request: ChatRequest, stream: boolean): Record<string, unknown> {
    request = { ...request, messages: this.prepareMessages(request) };
    if (this.config.id === HAG_SOURCE_ID) assertHagPreview(request);
    const capacity = this.config.models.find((model) => model.id === request.model)?.maxEvaluatedTokens;
    if (capacity !== undefined && capacity !== null) {
      // Discovery validates this, but stored source JSON may predate or bypass discovery.
      if (!Number.isSafeInteger(capacity) || capacity <= 0) {
        throw new Error(`${this.config.name} reports an invalid execution limit. Refresh the source before trying again.`);
      }
      const output = request.maxTokens;
      if (output !== undefined && (!Number.isSafeInteger(output) || output <= 0)) {
        throw new Error('The requested output limit must be a positive whole number.');
      }
      const prompt = conversationTokens(request.messages) + toolDefinitionTokens(request.tools ?? []);
      // Beholdd admits P + M - 1 <= C. These shared planning estimates are not exact
      // tokenization; an admitted request may still receive the server's precise 400 refusal.
      const estimatedPositions = Math.max(1, prompt) + (output === undefined ? 0 : output - 1);
      if (estimatedPositions > capacity) {
        throw new Error(
          `${this.config.name} model "${request.model}" has a ${capacity}-token execution limit. ` +
          `This request needs an estimated ${prompt} prompt tokens` +
          (output === undefined ? '.' : ` and asks for ${output} output tokens.`) +
          ' Shorten the conversation or tools, lower the output limit, or select a model with more capacity. ' +
          '(context_length_exceeded)'
        );
      }
    }
    return {
      model: request.model,
      ...thinkingParameters(this.config, request),
      messages: this.wireMessages(request),
      // Only sent when asked for: beholdd v2 accepts temperature omitted or exactly 0, and
      // every other server applies its own default when the field is absent.
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      // A capped server chooses an omitted ceiling after exact tokenization. Explicit
      // ceilings retain the connector's output field and are never silently reduced.
      ...(capacity != null && request.maxTokens === undefined ? {} :
        thinkingSupport(this.config, request.model).mechanism === 'effort' && !['llama-cpp', 'ollama'].includes(this.config.kind ?? '')
          ? { max_completion_tokens: request.maxTokens ?? 4096 } : { max_tokens: request.maxTokens ?? 4096 }),
      stream,
      ...(stream && ['openai', 'llama-cpp', 'ollama', 'opencode-zen'].includes(this.config.kind ?? '')
        ? { stream_options: { include_usage: true } } : {}),
      // Tools only, never tool_choice. beholdd v2 deserializes strictly and accepts exactly
      // model, messages, max_tokens, temperature, tools and stream; tool_choice made it reject
      // the whole request. Every server treats tools as auto-selectable when no choice is
      // given, so sending it bought nothing and broke the one engine we care most about.
      ...(request.tools?.length ? { tools: request.tools } : {}),
      // Ask llama.cpp to keep the slot's KV cache and reuse whatever prefix this request shares
      // with the last one. That is the local equivalent of a hosted prompt cache, and it is the
      // difference between re-reading the whole system prompt and tool schemas every turn and
      // reading none of it. Named explicitly rather than relying on the server default, which
      // has changed between builds. Gated by kind for the same reason tool_choice is: beholdd
      // rejects the entire request on an unknown field.
      ...(['llama-cpp', 'ollama'].includes(this.config.kind ?? '') ? { cache_prompt: true } : {}),
      // Verified in pinned llama.cpp b11223: real cache/prefill counters arrive before output.
      // Keep this extension away from other compatible providers, which may reject extra keys.
      ...(stream && this.config.kind === 'llama-cpp' ? { return_progress: true } : {}),
    };
  }

  /**
   * One place to turn transport and HTTP failures into messages a person can act on:
   * "fetch failed" alone never says which source was unreachable.
   */
  private async post(
    body: Record<string, unknown>,
    signal?: AbortSignal,
    connection?: PreparedProviderConnection | void,
    onAlive?: LivenessCallback
  ): Promise<Response> {
    const url = this.endpoint(connection);
    const apiKey = connection?.apiKey ?? this.config.apiKey;

    // A cold model arrives as one of two shapes, and neither is an error. beholdd answers
    // 503 model_loading + Retry-After while it is starting the worker, but that is the short
    // half: measured against MiMo, the 503 window is about two seconds and the weight read
    // that follows is nine minutes, during which every request — the one that triggered the
    // load included — parks with no response headers until undici gives up. That is the
    // "Headers Timeout Error" this block used to surface as "Is the server running?", and it
    // is the shape that carries the wait. For local runtimes, wait out both within one
    // budget: honour Retry-After on the 503, and treat a stall as a load in progress for as
    // long as the runtime is still listening.
    const localRetry = LOCAL_LOADING_KINDS.has(this.config.kind ?? '');
    const startedAt = Date.now();
    const deadline = startedAt + (localRetry ? MODEL_LOAD_RETRY_WINDOW_MS : 0);

    for (;;) {
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
          // Carried into fetch so stopping a turn closes the connection, rather than leaving the
          // server generating tokens nobody will read.
          signal,
        });
      } catch (error) {
        if ((error as Error).name === 'AbortError' || signal?.aborted) throw new Error('the turn was stopped');
        const stalled = localRetry && isStalledTransportError(error);
        if (stalled && Date.now() < deadline && (await this.stillListening(connection, apiKey, signal))) {
          onAlive?.({ label: 'Loading model', seconds: Math.round((Date.now() - startedAt) / 1000) });
          await sleepWithSignal(this.loadRetryPauseMs(), signal);
          continue;
        }
        const cause = (error as Error & { cause?: Error }).cause?.message ?? (error as Error).message;
        const hint = stalled
          ? 'The server accepted the request but never answered — a cold model may still be loading. Check the server log.'
          : 'Is the server running?';
        throw new Error(
          `${this.config.name} did not answer at ${publicProviderEndpoint(url)} ` +
            `(${redactProviderSecrets(cause, apiKey)}). ${hint}`
        );
      }

      if (response.status === 503) {
        const raw = await boundedResponseText(response, MAX_PROVIDER_ERROR_BYTES).catch(() => '');
        const payload = parseErrorPayload(raw);
        const loading = payload?.error?.type === 'model_loading';
        if (localRetry && loading) {
          if (Date.now() >= deadline) {
            throw new Error(
              `${this.config.name} is still loading its model after ${Math.round(MODEL_LOAD_RETRY_WINDOW_MS / 60_000)} minutes and did not answer at ` +
                `${publicProviderEndpoint(url)}. Check the server log — the load may have failed.`
            );
          }
          onAlive?.({
            label: 'Loading model',
            model: payload?.error?.model,
            seconds: payload?.error?.loading_seconds,
          });
          await sleepWithSignal(loadRetryAfterMs(response, this.loadRetryPauseMs()), signal);
          continue;
        }
        const detail = redactProviderSecrets(
          payload?.error?.message ? String(payload.error.message) : raw.trim(),
          apiKey
        );
        throw new Error(
          `${this.config.name} refused the request: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 400)}` : ''}`
        );
      }

      if (!response.ok) {
        const detail = redactProviderSecrets(
          (await boundedResponseText(response, MAX_PROVIDER_ERROR_BYTES).catch(() => '')).trim(),
          apiKey
        );
        throw new Error(
          `${this.config.name} refused the request: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 400)}` : ''}`
        );
      }

      return response;
    }
  }

  /**
   * How long to wait before re-sending, when the server did not say. Overridable so a test can
   * exercise the retry without sleeping the real ten seconds between attempts.
   */
  protected loadRetryPauseMs(): number {
    return LOAD_RETRY_PAUSE_MS;
  }

  /**
   * Is anything still listening? Asked before retrying a request that stalled with no headers.
   *
   * Deliberately not a health check. beholdd holds its engine-registry lock for the whole of a
   * cold load, so `/health` and `/v1/models` both stall *while a model is loading* — the exact
   * case this probe exists to survive, and a probe that demanded an answer would give up there.
   * What a socket can still establish is whether the runtime is there at all: an answer means
   * yes, a second silence means yes-and-busy, and only a refused or unreachable connection
   * means the process is gone and the caller should surface the original transport error.
   */
  private async stillListening(
    connection: PreparedProviderConnection | void,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    const base = (connection?.baseUrl ?? this.config.baseUrl).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LISTENING_PROBE_TIMEOUT_MS);
    const stop = () => controller.abort();
    try {
      signal?.addEventListener('abort', stop, { once: true });
      await fetch(`${base}/models`, {
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      // Any status at all answers the question; an auth error still proves a live listener.
      return true;
    } catch (error) {
      if (signal?.aborted) return false;
      // Our own 5s cutoff, not the socket's: busy, which is what a loading runtime looks like.
      if (controller.signal.aborted) return true;
      return !isUnreachable(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }

  override async chat(chatRequest: ChatRequest, signal?: AbortSignal): Promise<string> {
    // Refuse impossible plans before a managed-source hook can load a model or switch runtimes.
    const body = this.body(chatRequest, false);
    const end = this.track?.();
    try {
      // Reserve the source before preparation. A managed-source preflight may need to stop a
      // different local runtime, and that decision must see requests which are preparing as well
      // as requests already on the wire.
      const connection = await this.prepare?.(chatRequest.model, signal);
      const response = await this.post(body, signal, connection);
      const data = (await boundedResponseJson(response)) as any;
      const error = responseError(data);
      if (error) throw new Error(`${this.config.name} request failed: ${redactProviderSecrets(error, connection?.apiKey, this.config.apiKey)}`);
      return data.choices?.[0]?.message?.content ?? '';
    } finally {
      end?.();
    }
  }

  override async stream(
    chatRequest: ChatRequest,
    callback: StreamCallback,
    onAlive?: LivenessCallback,
    signal?: AbortSignal
  ): Promise<StreamResult> {
    const body = this.body(chatRequest, true);
    const end = this.track?.();
    try {
      const connection = await this.prepare?.(chatRequest.model, signal);
      return await this.streamOnce(chatRequest, body, callback, onAlive, signal, connection);
    } finally {
      end?.();
    }
  }

  private async streamOnce(
    chatRequest: ChatRequest,
    body: Record<string, unknown>,
    callback: StreamCallback,
    onAlive?: LivenessCallback,
    signal?: AbortSignal,
    connection?: PreparedProviderConnection | void
  ): Promise<StreamResult> {
    const meter = new InferenceMeter(chatRequest.requestId ?? chatRequest.model, callback, undefined, undefined, {
      llamaPromptProgress: this.config.kind === 'llama-cpp',
      request: this.requestDiagnostics.capture(body, chatRequest.threadId),
    });
    const response = await this.post(body, signal, connection, onAlive);

    const streamed = response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false;
    const partials: PartialToolCall[] = [];
    let content = '';
    let reasoning = '';
    let finishReason: string | undefined;
    let servedModel: string | undefined;

    // How many calls this reply may carry, and whether one arrived beyond that. A model that has
    // lost the plot emits hundreds of them, each taking as long to decode as any other token, so
    // the cost of noticing late is the whole generation — measured at sixteen minutes for a reply
    // whose first thirty-two calls were all that could ever have run.
    const cap = toolCallCap(chatRequest.maxToolCalls);
    let cutOff = false;

    /** Applies either a streamed delta or a complete message from a compatible server. */
    const applyPayload = (payload: any): void => {
      meter.observe(payload, 'openai-chat', streamed);
      const error = responseError(payload);
      if (error) {
        throw new Error(
          `${this.config.name} stream failed: ${redactProviderSecrets(error, connection?.apiKey, this.config.apiKey)}`
        );
      }

      // Read before the choice guard: the frame naming the model is not always one that
      // carries content, and on a substituted model it is the only thing that differs.
      if (typeof payload?.model === 'string' && payload.model) servedModel = payload.model;

      const choice = payload?.choices?.[0];
      const packet = choice?.delta ?? choice?.message;
      if (!packet) return;

      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;

      if (typeof packet.content === 'string' && packet.content) {
        content += packet.content;
        callback({ id: chatRequest.requestId ?? chatRequest.model, content: packet.content });
      }

      // Forwarded in its own field, never as content: thinking is not the answer, and streaming
      // it into the reply would put it in the transcript as though it were. It is also kept whole
      // so an empty answer can say why it is empty.
      const thought = packet.reasoning_content ?? packet.reasoning;
      if (typeof thought === 'string' && thought) {
        reasoning += thought;
        callback({ id: chatRequest.requestId ?? chatRequest.model, content: '', reasoning: thought });
      }

      const calls = Array.isArray(packet.tool_calls) ? packet.tool_calls : [];
      calls.forEach((part: any, position: number) => {
        // Streamed calls carry an index; complete assistant messages ordinarily do not.
        const index = Number.isInteger(part?.index) ? part.index : position;
        // Servers emit one call at a time, so the call after the last allowed one beginning is
        // the first moment the allowed ones are all complete — and the last moment before the
        // rest of the batch is decoded for nothing.
        if (index >= cap) {
          cutOff = true;
          return;
        }
        const existing = (partials[index] ??= { id: '', name: '', arguments: '' });
        if (part?.id) existing.id = String(part.id);
        if (part?.function?.name) existing.name = String(part.function.name);

        const args = wireArguments(part?.function?.arguments);
        if (args) {
          // A complete message contains the whole value. Deltas contain fragments to append.
          existing.arguments = choice?.delta ? `${existing.arguments}${args}` : args;
        }
      });
    };

    // A few OpenAI-compatible servers accept `stream: true` but still return one ordinary JSON
    // completion. Treat that as a one-frame stream instead of silently producing an empty reply.
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      const payload = await boundedResponseJson(response);
      applyPayload(payload);
      // A whole completion arrived at once, so nothing was saved by capping it — but the reply
      // still asked for more than it is allowed, and the loop has to say so.
      return { content, toolCalls: this.finishToolCalls(partials), reasoning,
        ...this.completedReasoning(chatRequest, reasoning, servedModel),
        finishReason, servedModel, toolCallsCutOff: cutOff, metrics: meter.finish() };
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${this.config.name} returned no response body`);

    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    let malformedFrames = 0;

    /** Processes one physical SSE line. True means the [DONE] sentinel was reached. */
    const processLine = (line: string): boolean => {
      const trimmed = line.trim();

      // `: keep-alive` and friends confirm a responding stream, not inference progress.
      if (trimmed.startsWith(':')) {
        onAlive?.();
        return false;
      }

      // The space after the colon is optional in SSE. Some compatible servers omit it.
      if (!trimmed.startsWith('data:')) return false;

      // Any frame at all is a sign of life, including the opening one that carries only a role.
      onAlive?.();
      const data = trimmed.slice(5).trimStart();
      if (data === '[DONE]') return true;
      if (!data) return false;

      let payload: any;
      try {
        payload = JSON.parse(data);
      } catch {
        // One malformed frame must not discard the rest of an otherwise valid stream.
        malformedFrames += 1;
        return false;
      }

      // Keep this outside the JSON parse catch: a real SSE error must reach the caller rather
      // than being mistaken for malformed JSON and then reported as a successful empty answer.
      applyPayload(payload);
      return false;
    };

    const processBuffer = (flush = false): void => {
      const lines = buffer.split('\n');
      buffer = flush ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        if (processLine(line) || cutOff) {
          done = true;
          break;
        }
      }
    };

    let reachedEof = false;
    try {
      while (!done) {
        if (signal?.aborted) throw new Error('the turn was stopped');
        const { done: finished, value } = await reader.read();
        if (finished) {
          reachedEof = true;
          // Flush a possibly unterminated final frame and any buffered multi-byte character.
          buffer += decoder.decode();
          processBuffer(true);
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        processBuffer();
      }
    } finally {
      // Leaving early is the whole point of the cap, and releasing the lock alone would leave the
      // engine decoding a batch nobody will read. Cancelling the body closes the connection.
      if (!reachedEof) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    // Opening role deltas and other protocol-only frames are valid JSON, but they do not make a
    // completion usable. If malformed frames were the only place the answer could have lived,
    // fail the turn instead of silently recording an empty assistant response.
    const hasMeaningfulPayload = Boolean(content || reasoning || partials.some((partial) => partial?.name));
    if (malformedFrames > 0 && !hasMeaningfulPayload) {
      throw new Error(`${this.config.name} returned malformed streaming data without usable output.`);
    }

    return {
      content,
      toolCalls: this.finishToolCalls(partials),
      reasoning,
      ...this.completedReasoning(chatRequest, reasoning, servedModel),
      // The server never got to send one; this is what it was about to say.
      finishReason: cutOff ? (finishReason ?? 'tool_calls') : finishReason,
      servedModel,
      toolCallsCutOff: cutOff,
      metrics: meter.finish(),
    };
  }

  private finishToolCalls(partials: PartialToolCall[]): ToolCall[] {
    return partials
      .filter((partial) => partial && partial.name)
      .map((partial, index) => ({
        id: partial.id || `call_${index}`,
        type: 'function' as const,
        function: { name: partial.name, arguments: partial.arguments || '{}' },
      }));
  }
}
