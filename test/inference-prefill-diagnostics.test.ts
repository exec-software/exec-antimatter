import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatRequest, InferenceMetrics, ProviderConfig } from '../src/api/types';
import { OpenAICompatibleProvider } from '../src/api/providers/openai';
import { InferenceMeter } from '../src/api/providers/metrics';
import { RequestDiagnostics } from '../src/api/providers/requestDiagnostics';
import { runToolLoop } from '../src/main/toolLoop';

const config: ProviderConfig = { id: 'source', name: 'Source', apiKey: 'private-api-key', baseUrl: 'https://private-endpoint.test/v1',
  kind: 'llama-cpp', models: [], supportsStreaming: true };
const request: ChatRequest = { providerId: config.id, model: 'model', threadId: 'thread', requestId: 'run',
  messages: [{ id: 'system', role: 'system', content: 'private-system' }, { id: 'user', role: 'user', content: 'private-question' }] };
const delta = (content: unknown) => ({ choices: [{ delta: { role: 'assistant', content }, finish_reason: null }] });
// Actual b11223 chat frames: server-task.cpp:1111–1160 and server-context.cpp:2065–2068.
const progress = (total: number, cache: number, processed: number, time_ms: number) => ({ ...delta(null),
  prompt_progress: { total, cache, processed, time_ms } });
const sse = (frames: unknown[]) => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } });

test('llama stream exposes cache and prefill before output without inventing TTFT', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let sent: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return sse([progress(133000, 51807, 51807, 0), progress(133000, 51807, 53855, 9000),
      delta('answer'), { choices: [], usage: { prompt_tokens: 133000, completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 51807 } }, timings: { cache_n: 51807, prompt_n: 81193, prompt_ms: 400000,
          predicted_n: 2, predicted_ms: 50 } }]);
  }) as typeof fetch;
  const frames: InferenceMetrics[] = [];
  const result = await new OpenAICompatibleProvider(config).stream(request, (frame) => { if (frame.metrics) frames.push(frame.metrics); });
  assert.equal(sent.return_progress, true);
  assert.equal(sent.cache_prompt, true);
  assert.deepEqual(frames.map((frame) => frame.phase), ['started', 'prefill', 'prefill', 'streaming']);
  assert.deepEqual(frames[1].promptProgress, { total: 133000, cached: 51807, processed: 51807, elapsedMs: 0 });
  assert.equal(frames[1].prefillTokens, 0);
  assert.equal(frames[2].prefillTokens, 2048);
  assert.equal(frames[2].firstTokenMs, undefined);
  assert.equal(frames[3].firstTokenKind, 'text');
  assert.equal(result.metrics?.promptTokens, 133000);
  assert.equal(result.metrics?.cachedPromptTokens, 51807);
  assert.equal(result.metrics?.prefillTokens, 81193);
  assert.equal(result.metrics?.promptMs, 400000);
  assert.equal(result.metrics?.completionTokens, 2);
  assert.equal(result.metrics?.phase, 'complete');
});

test('only complete monotonic llama stream telemetry can advance prompt progress', () => {
  const frames: InferenceMetrics[] = [];
  const meter = new InferenceMeter('run', (frame) => { if (frame.metrics) frames.push(frame.metrics); }, () => 0, () => 0,
    { llamaPromptProgress: true });
  for (const frame of [delta(null), { status: 'prefill', progress: 0.5 }, { prompt_progress: { total: 100 } },
    progress(100, 0, 101, 1), progress(100, 10, 0, 1), progress(100.5, 0, 2, 1), progress(100, 0, 2, -1),
    progress(100, 0, 2, NaN), { prompt_progress: { total: '100', cache: 0, processed: 2, time_ms: 1 } }]) {
    meter.observe(frame, 'openai-chat', true);
  }
  assert.equal(frames.length, 1);
  meter.observe(progress(100, 10, 30, 2), 'openai-chat', false);
  assert.equal(frames.length, 1, 'buffered responses cannot claim live progress');
  meter.observe(progress(100, 10, 30, 2), 'openai-chat', true);
  for (const frame of [progress(100, 10, 29, 3), progress(100, 10, 31, 1), progress(101, 10, 31, 3),
    progress(100, 11, 31, 3), progress(100, 10, 30, 2)]) meter.observe(frame, 'openai-chat', true);
  assert.equal(frames.length, 2);
  assert.equal(meter.finish().firstTokenMs, undefined);
  meter.observe(delta('output'), 'openai-chat', true);
  meter.observe(progress(100, 10, 100, 8), 'openai-chat', true);
  assert.deepEqual(frames.map((frame) => frame.phase), ['started', 'prefill', 'streaming']);
  assert.equal(meter.finish().promptProgress?.processed, 30, 'late progress cannot send generation backwards');
  const unknown = new InferenceMeter('unknown');
  unknown.observe(progress(100, 10, 30, 2), 'openai-chat', true);
  assert.equal(unknown.finish().promptProgress, undefined);
  assert.equal(unknown.finish().promptTokens, undefined);
});

test('return_progress is sent only to streamed llama.cpp requests', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json({ choices: [{ message: { content: 'ok' } }] }); }) as typeof fetch;
  for (const kind of ['openai', 'ollama', 'beholdd', 'openai-compatible'] as const) {
    await new OpenAICompatibleProvider({ ...config, kind }).stream(request, () => {});
  }
  await new OpenAICompatibleProvider(config).chat(request);
  assert.ok(sent.every((body) => !Object.hasOwn(body, 'return_progress')));
});

test('missing cache telemetry stays unknown instead of understating total prompt tokens', () => {
  const meter = new InferenceMeter('run', undefined, () => 0, () => 0);
  meter.observe({ choices: [], timings: { prompt_n: 100, prompt_ms: 5 } }, 'openai-chat', true);
  assert.equal(meter.finish().prefillTokens, 100);
  assert.equal(meter.finish().cachedPromptTokens, undefined);
  assert.equal(meter.finish().promptTokens, undefined);
  meter.observe({ choices: [], timings: { prompt_n: 100, cache_n: 0 } }, 'openai-chat', true);
  assert.equal(meter.finish().promptTokens, 100);
  assert.equal(meter.finish().cachedPromptTokens, 0);
});

test('real tool-loop rounds reset progress, usage and first-output timing', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    if (requests === 1) return sse([progress(100, 20, 100, 10), { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call', function: { name: 'fixture__read_file', arguments: '{}' } }], content: null }, finish_reason: 'tool_calls' }] },
      { choices: [], timings: { cache_n: 20, prompt_n: 80, predicted_n: 9, prompt_ms: 10 } }]);
    return sse([progress(120, 100, 100, 0), delta('finished')]);
  }) as typeof fetch;
  const events: Array<{ round: number; metrics: InferenceMetrics }> = [];
  const result = await runToolLoop({ provider: new OpenAICompatibleProvider(config), request, mode: 'read', runId: 'run',
    onContent() {}, onActivity() {}, onMetrics(event) { events.push(event); }, toolRuntime: {
      enabledTools: () => [{ serverId: 'fixture', serverName: 'Fixture', tool: { name: 'read_file', description: 'Read a fixture',
        inputSchema: { type: 'object', properties: {} }, enabled: true } }],
      async callTool() { return { ok: true, text: 'file contents' }; },
    } });
  assert.equal(result.rounds, 2);
  assert.equal(requests, 2);
  const second = events.filter((event) => event.round === 2);
  assert.equal(second[0].metrics.phase, 'started');
  assert.equal(second[0].metrics.promptProgress, undefined);
  assert.equal(second[0].metrics.completionTokens, undefined);
  assert.equal(second[0].metrics.firstTokenMs, undefined);
  assert.equal(second[1].metrics.prefillTokens, 0);
  assert.equal(second[1].metrics.cachedPromptTokens, 100);
  assert.equal(second[1].metrics.promptTokens, 120);
  assert.equal(second[1].metrics.firstTokenMs, undefined);
  assert.equal(second.at(-1)?.metrics.firstTokenKind, 'text');
  assert.equal(second[0].metrics.request?.comparison?.sameSystem, true);
});

test('diagnostics compare actual normalized wire payloads across origins without exposing content or identifiers', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async () => sse([delta('done')])) as typeof fetch;
  const provider = new OpenAICompatibleProvider(config);
  const first = (await provider.stream(request, () => {})).metrics!.request!;
  const second = (await provider.stream({ ...request, requestId: 'phone-run', responseMessageId: 'phone-response',
    messages: request.messages.map((message) => ({ ...message, id: 'different-id' })) }, () => {})).metrics!.request!;
  assert.equal(first.payloadFingerprint, second.payloadFingerprint);
  assert.equal(second.comparison?.commonPrefixMessages, 2);
  assert.deepEqual([second.comparison?.sameSystem, second.comparison?.sameTools, second.comparison?.sameSettings], [true, true, true]);
  const serialized = JSON.stringify(second);
  for (const secret of ['private-system', 'private-question', 'private-api-key', 'private-endpoint', 'phone-run', 'phone-response', 'different-id']) {
    assert.ok(!serialized.includes(secret), secret);
  }
  assert.equal(first.messageCount, 2);
  assert.equal(first.messageCharacters, 'private-systemprivate-question'.length);
  assert.equal(first.fingerprintScope, 'app-session');
  assert.match(first.payloadFingerprint, /^[0-9a-f]{64}$/);
});

test('diagnostics distinguish system, tool and settings changes and retain bounded conversation hashes', () => {
  const diagnostics = new RequestDiagnostics();
  const body = { model: 'model', max_tokens: 100, messages: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'private_tool', parameters: {} } }] };
  const initial = diagnostics.capture(body, 'thread');
  const appended = diagnostics.capture({ ...body, messages: [...body.messages, { role: 'tool', content: 'result' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'private_tool', arguments: '{"x":1}' } }] }] }, 'thread');
  assert.equal(appended.comparison?.commonPrefixMessages, 2);
  assert.equal(appended.toolResultCount, 1);
  assert.equal(appended.toolResultCharacters, 6);
  assert.equal(appended.toolCallCount, 1);
  assert.equal(appended.toolCallArgumentCharacters, 7);
  const changed = diagnostics.capture({ ...body, max_tokens: 200, tools: [],
    messages: [{ role: 'system', content: 'different' }, body.messages[1]] }, 'thread');
  assert.deepEqual([changed.comparison?.sameSystem, changed.comparison?.sameTools, changed.comparison?.sameSettings], [false, false, false]);
  assert.equal(changed.comparison?.commonPrefixMessages, 0);
  assert.equal(diagnostics.capture(body, 'other').comparison, undefined);
  assert.equal(diagnostics.capture(body).comparison, undefined);
  assert.equal(new RequestDiagnostics().capture(body).payloadFingerprint, initial.payloadFingerprint);
  for (let index = 0; index < 64; index++) diagnostics.capture(body, `other-${index}`);
  assert.equal(diagnostics.capture(body, 'thread').comparison, undefined, 'old conversation comparison is evicted');
});
