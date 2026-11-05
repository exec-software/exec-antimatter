import assert from 'node:assert/strict';
import test from 'node:test';

import { AnthropicMessagesProvider } from '../src/api/providers/anthropicMessages';
import { OpenAICompatibleProvider } from '../src/api/providers/openai';
import type { ChatRequest, Message, ProviderConfig, ProviderKind, ToolDefinition } from '../src/api/types';

/**
 * Prompt caching rests on one property: the prefix of the request must not change between turns.
 *
 * A hosted cache keys on the longest matching prefix, and llama.cpp's slot cache reuses exactly
 * the tokens a new prompt shares with the last one. Either way, rewriting anything before the new
 * content throws the whole saving away -- and at the prefill rates a local 119B model runs at,
 * that is the difference between seconds and an hour. So the invariant is asserted here rather
 * than left to hold by accident.
 */

const tools: ToolDefinition[] = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a command', parameters: { type: 'object', properties: {} } } },
];

const config = (kind?: ProviderKind): ProviderConfig => ({
  id: 'cache-test',
  name: 'Cache test',
  apiKey: 'test-key',
  baseUrl: 'http://inference.test/v1/',
  models: [{ id: 'test-model', name: 'Test model' }],
  supportsStreaming: true,
  ...(kind ? { kind } : {}),
});

/** Drives one real request and returns the body that went over the wire. */
async function posted(provider: OpenAICompatibleProvider | AnthropicMessagesProvider, messages: Message[], withTools = true) {
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json(
      provider instanceof AnthropicMessagesProvider
        ? { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }
        : { choices: [{ message: { content: 'ok' } }] }
    );
  }) as typeof fetch;
  const request: ChatRequest = {
    messages, model: 'test-model', providerId: 'cache-test', requestId: 'r1',
    ...(withTools ? { tools } : {}),
  };
  try { await provider.chat(request); } finally { globalThis.fetch = original; }
  return body;
}

/** A settled transcript, and the same transcript one exchange later. */
const turnOne: Message[] = [
  { id: 's', role: 'system', content: 'You are the assistant inside Antimatter.' },
  { id: 'u1', role: 'user', content: 'Check the build.' },
];
const turnTwo: Message[] = [
  ...turnOne,
  { id: 'a1', role: 'assistant', content: 'The build is green.' },
  { id: 'u2', role: 'user', content: 'Now run the tests.' },
];
const turnThree: Message[] = [
  ...turnTwo,
  { id: 'a2', role: 'assistant', content: 'Tests pass.' },
  { id: 'u3', role: 'user', content: 'Ship it.' },
];

/** cache_control is a marker, not prompt text, so it is ignored when comparing prefixes. */
const withoutMarkers = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, inner) => key === 'cache_control' ? undefined : inner));

test('only a local engine that understands cache_prompt is asked for it', async () => {
  for (const kind of ['llama-cpp', 'ollama'] as const) {
    const body = await posted(new OpenAICompatibleProvider(config(kind)), turnTwo);
    assert.equal(body.cache_prompt, true, `${kind} keeps its slot cache`);
  }
  // beholdd rejects the whole request on an unknown field, exactly as it did for tool_choice.
  for (const kind of [undefined, 'beholdd', 'openai'] as const) {
    const body = await posted(new OpenAICompatibleProvider(config(kind as ProviderKind)), turnTwo);
    assert.ok(!('cache_prompt' in body), `${kind ?? 'unset'} must not be sent an unknown field`);
  }
});

test('the compatible wire grows append-only, so a shared prefix survives the next turn', async () => {
  const provider = new OpenAICompatibleProvider(config('llama-cpp'));
  const bodies = [];
  for (const messages of [turnOne, turnTwo, turnThree]) bodies.push(await posted(provider, messages));

  for (const [index, body] of bodies.entries()) {
    if (index === 0) continue;
    const before = bodies[index - 1].messages as unknown[];
    const after = body.messages as unknown[];
    assert.ok(after.length > before.length, 'a later turn must add turns, not replace them');
    assert.deepEqual(after.slice(0, before.length), before,
      `turn ${index + 1} rewrote the prefix it should have reused`);
  }
  // The system block and tool schemas are the most valuable thing to cache and must never move.
  for (const body of bodies) {
    assert.deepEqual((body.messages as { role: string }[])[0], { role: 'system', content: turnOne[0].content });
    assert.deepEqual(body.tools, bodies[0].tools);
  }
});

test('Anthropic is given cache breakpoints at each stage of the prefix', async () => {
  const body = await posted(new AnthropicMessagesProvider(config()), turnTwo);

  // Tools are read first, so the last one caches the schemas on their own.
  const wiredTools = body.tools as Record<string, unknown>[];
  assert.equal(wiredTools.length, 2);
  assert.ok(!('cache_control' in wiredTools[0]), 'only the final tool carries the breakpoint');
  assert.deepEqual(wiredTools[1].cache_control, { type: 'ephemeral' });

  // System is read next, and is sent as blocks so it can carry one at all.
  assert.deepEqual(body.system, [{ type: 'text', text: turnOne[0].content, cache_control: { type: 'ephemeral' } }]);

  // Then a rolling breakpoint on the newest finished assistant turn: this turn writes it, the
  // next turn reads it, so history is re-read once per exchange rather than in full every time.
  const messages = body.messages as { role: string; content: Record<string, unknown>[] }[];
  const assistants = messages.filter((message) => message.role === 'assistant');
  assert.equal(assistants.length, 1);
  assert.deepEqual(assistants[0].content.at(-1)?.cache_control, { type: 'ephemeral' });
  assert.ok(messages.filter((m) => m.role === 'user').every((m) => m.content.every((block) => !('cache_control' in block))),
    'a user turn is the new content and is not worth a breakpoint');

  // Four is the ceiling; three leaves one spare for a future stage.
  const used = JSON.stringify(body).split('"cache_control"').length - 1;
  assert.equal(used, 3);
  assert.ok(used <= 4, 'Anthropic accepts at most four breakpoints');
});

test('the Anthropic prefix is append-only once the markers are set aside', async () => {
  const provider = new AnthropicMessagesProvider(config());
  const bodies = [];
  for (const messages of [turnTwo, turnThree]) bodies.push(await posted(provider, messages));

  const before = withoutMarkers(bodies[0].messages) as unknown[];
  const after = withoutMarkers(bodies[1].messages) as unknown[];
  assert.deepEqual(after.slice(0, before.length), before, 'the earlier turns must be reused verbatim');
  assert.deepEqual(withoutMarkers(bodies[1].system), withoutMarkers(bodies[0].system));
  assert.deepEqual(withoutMarkers(bodies[1].tools), withoutMarkers(bodies[0].tools));
  // The rolling breakpoint is the one thing that does move, and must: it has to follow the head
  // of the conversation or it would stop covering the turns added since.
  const marked = (body: Record<string, unknown>) =>
    (body.messages as { role: string; content: Record<string, unknown>[] }[])
      .flatMap((message, index) => message.content.map((block, inner) => ('cache_control' in block ? `${index}.${inner}` : null)))
      .filter(Boolean);
  assert.notDeepEqual(marked(bodies[1]), marked(bodies[0]));
});

test('rewriting the system text is the one thing that throws the whole cache away', async () => {
  const provider = new OpenAICompatibleProvider(config('llama-cpp'));
  const original = await posted(provider, turnTwo);
  // refreshGrounding() rewrites the system message when the access mode changes mid-run. That is
  // correct behaviour and it is also a total cache miss, which is worth knowing rather than
  // discovering as a mystery slowdown.
  const regrounded = await posted(provider, [
    { ...turnTwo[0], content: 'You are the assistant inside Antimatter. Permissions changed.' },
    ...turnTwo.slice(1),
  ]);
  assert.notDeepEqual((regrounded.messages as unknown[])[0], (original.messages as unknown[])[0]);
  assert.deepEqual((regrounded.messages as unknown[]).slice(1), (original.messages as unknown[]).slice(1),
    'only the system turn differs, but it is first, so nothing after it can be reused');
});
