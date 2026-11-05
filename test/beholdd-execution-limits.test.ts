import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleProvider } from '../src/api/providers/openai';
import { ProviderManager } from '../src/api/providers';
import type { ChatRequest, ProviderConfig, ToolDefinition } from '../src/api/types';
import { conversationTokens, toolDefinitionTokens } from '../src/api/tokenEstimate';

const config: ProviderConfig = {
  id: 'beholdd', name: 'Beholdd', kind: 'beholdd', baseUrl: 'http://inference.test/v1',
  apiKey: '', supportsStreaming: true,
  models: [{ id: 'qwen3', name: 'Qwen3', contextWindow: 131_072, maxEvaluatedTokens: 128 }],
};
const request: ChatRequest = {
  providerId: config.id, model: 'qwen3', requestId: 'bounded-request',
  messages: [{ id: 'user', role: 'user', content: 'Hello' }],
};
const sse = () => new Response(
  'data: {"model":"qwen3","choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }
);

test('capped chat and streaming requests preserve omission and explicit output ceilings', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return body.stream ? sse() : Response.json({ choices: [{ message: { content: 'OK' } }] });
  });
  const provider = new OpenAICompatibleProvider(config);
  assert.equal(await provider.chat(request), 'OK');
  const chunks: string[] = [];
  assert.equal((await provider.stream(request, ({ content }) => { if (content) chunks.push(content); })).content, 'OK');
  assert.deepEqual(chunks, ['OK']);
  assert.equal(await provider.chat({ ...request, maxTokens: 32 }), 'OK');
  await provider.stream({ ...request, maxTokens: 32 }, () => undefined);
  assert.deepEqual(bodies.map((body) => body.max_tokens), [undefined, undefined, 32, 32]);
  assert.ok(bodies.slice(0, 2).every((body) => !Object.hasOwn(body, 'max_tokens')));
});

test('models without a fixed execution cap retain the provider fallback', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  });
  for (const maxEvaluatedTokens of [undefined, null]) {
    const provider = new OpenAICompatibleProvider({
      ...config, models: [{ id: 'qwen3', name: 'Qwen3', maxEvaluatedTokens }],
    });
    await provider.chat(request);
  }
  assert.deepEqual(bodies.map((body) => body.max_tokens), [4096, 4096]);
});

test('over-cap requests fail before fetching, preparing, tracking or delivering callbacks', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  const prepare = t.mock.fn(async () => undefined);
  const manager = ProviderManager.fromConfigs([config]);
  manager.usePrepareProvider(prepare);
  const provider = manager.getProvider(config.id)!;
  const callback = t.mock.fn();
  const inputs = [
    { ...request, maxTokens: 4096 },
    { ...request, messages: [{ id: 'grounding', role: 'system' as const, content: 'Required instructions. '.repeat(60) }, ...request.messages] },
    { ...request, messages: [{ id: 'latest', role: 'user' as const, content: 'Keep this current request. '.repeat(60) }] },
    { ...request, messages: [{ id: 'compaction', role: 'user' as const, content: 'Summarize: '.repeat(400) }], maxTokens: 32 },
  ];
  for (const input of inputs) {
    const before = JSON.stringify(input);
    await assert.rejects(provider.chat(input), /128-token execution limit.*context_length_exceeded/);
    await assert.rejects(provider.stream(input, callback), /128-token execution limit.*context_length_exceeded/);
    assert.equal(JSON.stringify(input), before, 'instructions and current input are not truncated');
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(prepare.mock.callCount(), 0);
  assert.equal(callback.mock.callCount(), 0);
  assert.equal(manager.anyBusy(), false);
});

test('the request guard includes live tool definitions and tool call history', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  const provider = new OpenAICompatibleProvider(config);
  const tools: ToolDefinition[] = [{ type: 'function', function: {
    name: 'read_file', description: 'Read a file. '.repeat(100), parameters: { type: 'object' },
  } }];
  assert.ok(toolDefinitionTokens(tools) > 128);
  await assert.rejects(provider.stream({ ...request, tools }, () => undefined), /context_length_exceeded/);
  await assert.rejects(provider.chat({ ...request, messages: [
    ...request.messages,
    { id: 'calls', role: 'assistant', content: '', toolCalls: [{ id: 'call', type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ path: 'long/'.repeat(100) }) } }] },
  ] }), /context_length_exceeded/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('estimated admission respects the last-token boundary without reducing explicit output', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  });
  const provider = new OpenAICompatibleProvider(config);
  const prompt = conversationTokens(request.messages);
  const output = 128 - prompt + 1;
  await provider.chat({ ...request, maxTokens: output });
  assert.equal(bodies[0].max_tokens, output);
  await assert.rejects(provider.chat({ ...request, maxTokens: output + 1 }), /context_length_exceeded/);
  assert.equal(bodies.length, 1);
});

test('exact server refusals remain visible for both request modes without retries', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: {
    code: 'context_length_exceeded', message: 'Encoded prompt and output exceed the model capacity.',
  } }, { status: 400 }));
  const callback = t.mock.fn();
  const provider = new OpenAICompatibleProvider(config);
  await assert.rejects(provider.chat({ ...request, maxTokens: 32 }), /context_length_exceeded/);
  await assert.rejects(provider.stream({ ...request, maxTokens: 32 }, callback), /context_length_exceeded/);
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(callback.mock.callCount(), 1, 'a transmitted stream reports its request-start metric');
  const started = callback.mock.calls[0].arguments[0];
  assert.equal(started.content, '');
  assert.equal(started.metrics.phase, 'started');
});

test('invalid stored caps and output ceilings cannot bypass the guard', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  for (const capacity of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const provider = new OpenAICompatibleProvider({ ...config, models: [{ id: 'qwen3', name: 'Qwen3', maxEvaluatedTokens: capacity }] });
    await assert.rejects(provider.chat(request), /invalid execution limit/);
  }
  const provider = new OpenAICompatibleProvider(config);
  for (const maxTokens of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(provider.chat({ ...request, maxTokens }), /positive whole number/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('execution caps preserve effort-based output fields and thinking controls', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  });
  const provider = new OpenAICompatibleProvider({ ...config, kind: 'openai',
    models: [{ id: 'gpt-5', name: 'GPT', maxEvaluatedTokens: 2048 }] });
  await provider.chat({ ...request, model: 'gpt-5', maxTokens: 32, thinkingLevel: 'high' });
  assert.equal(bodies[0].max_completion_tokens, 32);
  assert.equal(bodies[0].reasoning_effort, 'high');
  assert.equal(Object.hasOwn(bodies[0], 'max_tokens'), false);
  await provider.chat({ ...request, model: 'gpt-5', thinkingLevel: 'high' });
  assert.equal(Object.hasOwn(bodies[1], 'max_tokens'), false);
  assert.equal(Object.hasOwn(bodies[1], 'max_completion_tokens'), false);
});

test('fresh provider catalogs apply changed caps only to the exact source and model', async (t) => {
  const sent: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    sent.push(String(url));
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  });
  const other = { ...config, id: 'other', baseUrl: 'http://other.test/v1',
    models: [{ id: 'qwen3', name: 'Qwen3', maxEvaluatedTokens: 2048 }] };
  const manager = ProviderManager.fromConfigs([config, other]);
  const large = { ...request, maxTokens: 512 };
  await assert.rejects(manager.getProvider(config.id)!.chat(large), /context_length_exceeded/);
  await manager.getProvider(other.id)!.chat({ ...large, providerId: other.id });
  manager.addConfig({ ...other, models: [
    { id: 'qwen3', name: 'Qwen3', maxEvaluatedTokens: 64 },
    { id: 'sibling', name: 'Sibling', maxEvaluatedTokens: null },
  ] });
  await assert.rejects(manager.getProvider(other.id)!.chat({ ...large, providerId: other.id }), /64-token execution limit/);
  await manager.getProvider(other.id)!.chat({ ...large, providerId: other.id, model: 'sibling' });
  assert.deepEqual(sent, ['http://other.test/v1/chat/completions', 'http://other.test/v1/chat/completions']);
  assert.equal(manager.anyBusy(), false);
});
