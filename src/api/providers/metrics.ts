import type { InferenceMetrics, InferenceRequestDiagnostics, StreamCallback, WireProtocol } from '../types';

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : {};
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

/** HTTP/stream observations only. Never derives token counts or prefill time from visible text. */
export class InferenceMeter {
  private readonly startedAt: number;
  private readonly started: number;
  private readonly values: Partial<InferenceMetrics> = {};

  constructor(private readonly id: string, private readonly callback?: StreamCallback,
    private readonly now: () => number = () => performance.now(), wallNow: () => number = () => Date.now(),
    private readonly options: { llamaPromptProgress?: boolean; request?: InferenceRequestDiagnostics } = {}) {
    this.startedAt = wallNow();
    this.started = this.now();
    if (options.request) this.values.request = options.request;
    this.emit('started');
  }

  private set(key: keyof InferenceMetrics, value: unknown): void {
    const n = number(value);
    if (n !== undefined) (this.values as Record<string, unknown>)[key] = n;
  }

  private token(kind: 'text' | 'reasoning' | 'tool'): void {
    if (this.values.firstTokenMs !== undefined) return;
    this.values.firstTokenMs = Math.max(0, this.now() - this.started);
    this.values.firstTokenKind = kind;
    this.emit('streaming');
  }

  private promptProgress(value: unknown): void {
    const progress = record(value);
    const { total, cache: cached, processed, time_ms: elapsedMs } = progress;
    // b11223 server-task.cpp result_prompt_progress: processed INCLUDES cache. Reject partial,
    // impossible or backwards frames instead of converting a keepalive into invented progress.
    if (![total, cached, processed].every((entry) => Number.isSafeInteger(entry) && entry >= 0) ||
        total <= 0 || cached > processed || processed > total || number(elapsedMs) === undefined) return;
    const previous = this.values.promptProgress;
    if (previous && (total !== previous.total || cached !== previous.cached ||
        processed < previous.processed || elapsedMs < previous.elapsedMs)) return;
    if (previous && processed === previous.processed && elapsedMs === previous.elapsedMs) return;
    this.values.promptProgress = { total, cached, processed, elapsedMs };
    this.values.promptTokens = total;
    this.values.cachedPromptTokens = cached;
    this.values.prefillTokens = processed - cached;
    this.values.promptMs = elapsedMs;
    this.emit('prefill');
  }

  /** Metadata-only, role, keepalive and empty deltas do not count as output. */
  observe(payload: unknown, protocol: WireProtocol, streamed: boolean): void {
    const outer = record(payload);
    const response = record(outer.response);
    const message = record(outer.message);
    const root = Object.keys(response).length ? response : Object.keys(message).length ? message : outer;
    const usage = record(root.usage);
    if (protocol === 'anthropic-messages') {
      // Anthropic input_tokens excludes cache reads/writes. The UI's prompt count includes them.
      if (number(usage.input_tokens) !== undefined) {
        this.set('promptTokens', usage.input_tokens + (number(usage.cache_read_input_tokens) ?? 0) + (number(usage.cache_creation_input_tokens) ?? 0));
      }
      this.set('completionTokens', usage.output_tokens);
      this.set('cachedPromptTokens', usage.cache_read_input_tokens);
    } else {
      this.set('promptTokens', usage.prompt_tokens ?? usage.input_tokens);
      this.set('completionTokens', usage.completion_tokens ?? usage.output_tokens);
      this.set('cachedPromptTokens', record(usage.prompt_tokens_details ?? usage.input_tokens_details).cached_tokens);
      this.set('reasoningTokens', record(usage.completion_tokens_details ?? usage.output_tokens_details).reasoning_tokens);
    }
    const timings = record(root.timings ?? outer.timings);
    this.set('prefillTokens', timings.prompt_n);
    this.set('cachedPromptTokens', timings.cache_n);
    if (this.values.promptTokens === undefined && number(timings.prompt_n) !== undefined && this.values.cachedPromptTokens !== undefined) {
      // A missing cache count is unknown, not zero. prompt_n alone is only newly evaluated work.
      this.set('promptTokens', timings.prompt_n + this.values.cachedPromptTokens);
    }
    this.set('completionTokens', timings.predicted_n);
    this.set('promptMs', timings.prompt_ms);
    this.set('decodeMs', timings.predicted_ms);
    this.set('promptTokensPerSecond', timings.prompt_per_second);
    this.set('decodeTokensPerSecond', timings.predicted_per_second);
    // Ollama native timings occasionally accompany compatible responses; nanoseconds -> ms.
    this.set('prefillTokens', outer.prompt_eval_count);
    this.set('completionTokens', outer.eval_count);
    if (number(outer.prompt_eval_duration) !== undefined) this.set('promptMs', outer.prompt_eval_duration / 1e6);
    if (number(outer.eval_duration) !== undefined) this.set('decodeMs', outer.eval_duration / 1e6);

    if (!streamed) return; // A complete buffered answer gives no evidence about its first token.
    if (this.options.llamaPromptProgress && protocol === 'openai-chat' && this.values.firstTokenMs === undefined) {
      this.promptProgress(outer.prompt_progress);
    }
    if (protocol === 'openai-chat') {
      const delta = record(outer.choices?.[0]?.delta);
      if (text(delta.reasoning_content ?? delta.reasoning)) this.token('reasoning');
      else if (text(delta.content)) this.token('text');
      else if (Array.isArray(delta.tool_calls) && delta.tool_calls.some((call: any) => text(call?.function?.name) || text(call?.function?.arguments))) this.token('tool');
    } else if (protocol === 'openai-responses') {
      const type = outer.type;
      if ((type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') && text(outer.delta)) this.token('reasoning');
      else if (type === 'response.output_text.delta' && text(outer.delta)) this.token('text');
      else if (type === 'response.function_call_arguments.delta' && text(outer.delta)) this.token('tool');
      else if (type === 'response.output_item.added' && outer.item?.type === 'function_call' && text(outer.item.name)) this.token('tool');
    } else {
      const delta = record(outer.delta);
      const block = record(outer.content_block);
      if (outer.type === 'content_block_delta') {
        if (delta.type === 'thinking_delta' && text(delta.thinking)) this.token('reasoning');
        else if ((delta.type === 'text_delta' && text(delta.text)) || (delta.type === 'refusal_delta' && text(delta.refusal))) this.token('text');
        else if (delta.type === 'input_json_delta' && text(delta.partial_json)) this.token('tool');
      } else if (outer.type === 'content_block_start') {
        if (block.type === 'tool_use' && text(block.name)) this.token('tool');
        else if (block.type === 'thinking' && text(block.thinking)) this.token('reasoning');
        else if (block.type === 'text' && text(block.text)) this.token('text');
      }
    }
  }

  snapshot(phase: InferenceMetrics['phase']): InferenceMetrics {
    return { ...this.values, phase, requestStartedAt: this.startedAt, requestDurationMs: Math.max(0, this.now() - this.started) };
  }

  private emit(phase: InferenceMetrics['phase']): void {
    this.callback?.({ id: this.id, content: '', metrics: this.snapshot(phase) });
  }

  finish(): InferenceMetrics { return this.snapshot('complete'); }
}
