import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { thinkingParameters, thinkingSupport } from '../src/api/thinking';
import type { ChatRequest, InferenceMetrics, ProviderConfig, StreamCallback } from '../src/api/types';
import { InferenceMeter } from '../src/api/providers/metrics';
import { OpenAICompatibleProvider } from '../src/api/providers/openai';
import { OpenAIResponsesProvider } from '../src/api/providers/openaiResponses';
import { AnthropicMessagesProvider } from '../src/api/providers/anthropicMessages';
import { resolve, setOverride, useConfigPath } from '../src/main/modelProfiles';
import { runToolLoop } from '../src/main/toolLoop';

const config: ProviderConfig = { id: 'source', name: 'Source', apiKey: '', baseUrl: 'https://inference.test/v1', models: [], supportsStreaming: true };
const request: ChatRequest = { providerId: 'source', model: 'qwen3-32b', messages: [{ id: 'u', role: 'user', content: 'hello' }], maxTokens: 16384, thinkingLevel: 'medium' };
const llama = { kind: 'llama-cpp' as const };

// Wire shapes follow provider documentation, including the pinned llama.cpp b11223 implementation.
test('thinking preferences use real protocol controls and respect model capabilities', () => {
  assert.deepEqual(thinkingParameters(llama, request), { reasoning_budget_tokens: 4096, chat_template_kwargs: { enable_thinking: true } });
  assert.deepEqual(thinkingParameters(llama, { ...request, thinkingLevel: 'off' }), { reasoning_budget_tokens: 0, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } });
  for (const model of ['qwen3-coder-30b', 'qwen3-235b-instruct-2507', 'llama-3.3', 'unknown']) {
    assert.deepEqual(thinkingParameters(llama, { ...request, model }), {});
    assert.deepEqual(thinkingSupport(llama, model).levels, ['default']);
  }
  assert.deepEqual(thinkingParameters({ kind: 'beholdd' }, request), {});
  assert.deepEqual(thinkingParameters({}, request), {});
  assert.deepEqual(thinkingParameters(llama, { ...request, thinkingLevel: 'default' }), {});
  assert.deepEqual(thinkingParameters({ kind: 'ollama' }, request), { reasoning_effort: 'medium' });
  assert.deepEqual(thinkingParameters({ protocol: 'openai-responses' }, { ...request, model: 'gpt-5.1', thinkingLevel: 'high' }), { reasoning: { effort: 'high' } });
  assert.deepEqual(thinkingParameters({ kind: 'openai' }, { ...request, model: 'o3', thinkingLevel: 'low' }), { reasoning_effort: 'low' });
  assert.deepEqual(thinkingParameters({ kind: 'openai' }, { ...request, model: 'o3', thinkingLevel: 'off' }), {});
  assert.deepEqual(thinkingParameters({ protocol: 'anthropic-messages' }, { ...request, model: 'claude-sonnet-4-5', thinkingLevel: 'high', maxTokens: 4096 }), { thinking: { type: 'enabled', budget_tokens: 4095 } });
  assert.throws(() => thinkingParameters({ protocol: 'anthropic-messages' }, { ...request, model: 'claude-sonnet-4-5', maxTokens: 1024 }), /maximum reply of at least 1,025/);
  assert.deepEqual(thinkingParameters({ protocol: 'anthropic-messages' }, { ...request, model: 'claude-opus-4-6', thinkingLevel: 'high' }), { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
  assert.deepEqual(thinkingParameters({ protocol: 'anthropic-messages' }, { ...request, model: 'claude-3-5-sonnet' }), {});
});

test('thinking preferences persist independently per source/model and reset to default', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'antimatter-thinking-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'profiles.json'); useConfigPath(path);
  setOverride('one', 'qwen3', { thinkingLevel: 'high' });
  setOverride('two', 'qwen3', { thinkingLevel: 'off' });
  useConfigPath(path);
  assert.equal(resolve({ providerId: 'one', modelId: 'qwen3' }).thinkingLevel, 'high');
  assert.equal(resolve({ providerId: 'two', modelId: 'qwen3' }).thinkingLevel, 'off');
  assert.equal(resolve({ providerId: 'one', modelId: 'other' }).thinkingLevel, 'default');
  assert.throws(() => setOverride('one', 'qwen3', { thinkingLevel: 'invented' as never }), /Unknown thinking/);
  setOverride('one', 'qwen3', null);
  assert.equal(resolve({ providerId: 'one', modelId: 'qwen3' }).thinkingLevel, 'default');
});

test('timing starts at request and sees reasoning before answer, never role or keepalive', () => {
  let clock = 0;
  const events: InferenceMetrics[] = [];
  const meter = new InferenceMeter('run', data => { if (data.metrics) events.push(data.metrics); }, () => clock, () => 1000);
  clock = 30; meter.observe({ choices: [{ delta: { role: 'assistant' } }] }, 'openai-chat', true);
  assert.equal(meter.snapshot('streaming').firstTokenMs, undefined);
  clock = 50; meter.observe({ choices: [{ delta: { reasoning_content: 'think' } }] }, 'openai-chat', true);
  clock = 100; meter.observe({ choices: [{ delta: { content: 'answer' } }] }, 'openai-chat', true);
  clock = 150;
  assert.deepEqual(meter.finish(), { phase: 'complete', requestStartedAt: 1000, requestDurationMs: 150, firstTokenMs: 50, firstTokenKind: 'reasoning' });
  assert.deepEqual(events.map(event => event.phase), ['started', 'streaming']);
});

test('prefill, cache, and decode numbers come only from server telemetry', () => {
  const meter = new InferenceMeter('run', undefined, () => 0, () => 0);
  meter.observe({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 10 } }, timings: { prompt_n: 100, cache_n: 400, prompt_ms: 50, prompt_per_second: 2000, predicted_n: 40, predicted_ms: 2000, predicted_per_second: 20 } }, 'openai-chat', true);
  assert.deepEqual(meter.finish(), { phase: 'complete', requestStartedAt: 0, requestDurationMs: 0, promptTokens: 500, prefillTokens: 100, cachedPromptTokens: 400, completionTokens: 40, reasoningTokens: 10, promptMs: 50, promptTokensPerSecond: 2000, decodeMs: 2000, decodeTokensPerSecond: 20 });
  meter.observe({ timings: { prompt_ms: -5, predicted_ms: 'invented', prompt_per_second: NaN } }, 'openai-chat', true);
  assert.equal(meter.finish().promptMs, 50);
  assert.equal(meter.finish().firstTokenMs, undefined);
});

test('native protocols measure first tool output and merge cumulative usage', () => {
  let clock = 0;
  const responses = new InferenceMeter('r', undefined, () => clock, () => 0);
  clock = 20; responses.observe({ type: 'response.output_item.added', item: { type: 'reasoning' } }, 'openai-responses', true);
  assert.equal(responses.finish().firstTokenMs, undefined);
  clock = 40; responses.observe({ type: 'response.function_call_arguments.delta', delta: '{' }, 'openai-responses', true);
  responses.observe({ type: 'response.completed', response: { usage: { input_tokens: 55, output_tokens: 30, output_tokens_details: { reasoning_tokens: 15 }, input_tokens_details: { cached_tokens: 10 } } } }, 'openai-responses', true);
  assert.equal(responses.finish().firstTokenMs, 40);
  assert.equal(responses.finish().firstTokenKind, 'tool');
  assert.equal(responses.finish().reasoningTokens, 15);
  const anthropic = new InferenceMeter('a', undefined, () => clock, () => 0);
  anthropic.observe({ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 1 } } }, 'anthropic-messages', true);
  clock = 80; anthropic.observe({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'read_file' } }, 'anthropic-messages', true);
  anthropic.observe({ type: 'message_delta', usage: { output_tokens: 40 } }, 'anthropic-messages', true);
  assert.equal(anthropic.finish().promptTokens, 65);
  assert.equal(anthropic.finish().completionTokens, 40);
  assert.equal(anthropic.finish().firstTokenKind, 'tool');
});

test('all three adapters send selected settings and expose buffered completion metrics without invented TTFT', async () => {
  const original = globalThis.fetch;
  try {
    const cases = [
      { Provider: OpenAICompatibleProvider, source: { ...config, kind: 'llama-cpp' as const }, model: 'qwen3-32b', response: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 3 } }, key: 'reasoning_budget_tokens', expected: 4096 },
      { Provider: OpenAIResponsesProvider, source: { ...config, protocol: 'openai-responses' as const }, model: 'gpt-5.1', response: { status: 'completed', output_text: 'ok', usage: { input_tokens: 100, output_tokens: 3 } }, key: 'reasoning', expected: { effort: 'medium' } },
      { Provider: AnthropicMessagesProvider, source: { ...config, protocol: 'anthropic-messages' as const }, model: 'claude-sonnet-4-5', response: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 3 } }, key: 'thinking', expected: { type: 'enabled', budget_tokens: 4096 } },
    ];
    for (const entry of cases) {
      let sent: Record<string, unknown> = {};
      globalThis.fetch = (async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json(entry.response); }) as typeof fetch;
      const frames: Parameters<StreamCallback>[0][] = [];
      const result = await new entry.Provider(entry.source).stream({ ...request, model: entry.model }, data => frames.push(data));
      assert.deepEqual(sent[entry.key], entry.expected);
      assert.equal(result.metrics?.promptTokens, 100);
      assert.equal(result.metrics?.completionTokens, 3);
      assert.equal(result.metrics?.firstTokenMs, undefined);
      assert.equal(result.metrics?.phase, 'complete');
      assert.equal(frames[0].metrics?.phase, 'started');
    }
  } finally { globalThis.fetch = original; }
});

test('tool loop associates metric snapshots with the actual inference round', async () => {
  const events: Array<{ round: number; metrics: InferenceMetrics }> = [];
  const metrics: InferenceMetrics = { phase: 'complete', requestStartedAt: 1, requestDurationMs: 10 };
  await runToolLoop({ request: { ...request, useTools: false }, mode: 'read', runId: 'run', onContent() {}, onActivity() {}, onMetrics: event => events.push(event),
    provider: { async stream(actual, callback) { assert.equal(actual.thinkingLevel, 'medium'); callback({ id: 'run', content: '', metrics: { ...metrics, phase: 'started' } }); return { content: 'done', toolCalls: [], metrics }; } },
  });
  assert.deepEqual(events.map(event => [event.round, event.metrics.phase]), [[1, 'started'], [1, 'complete']]);
});
