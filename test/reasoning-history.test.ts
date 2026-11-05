import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OpenAICompatibleProvider } from '../src/api/providers/openai';
import { HAG_MODEL_ID, HAG_SOURCE_ID, prepareHagPreview } from '../src/api/hag';
import { RequestDiagnostics } from '../src/api/providers/requestDiagnostics';
import { sanitizeConversationRequest } from '../src/api/requestMessages';
import { conversationTokens, messageTokens } from '../src/api/tokenEstimate';
import type { ChatRequest, Message, ProviderConfig } from '../src/api/types';
import { fitToBudget } from '../src/main/context';
import { prepareInteractiveRequest } from '../src/main/interactiveRequest';
import { runToolLoop, type ToolRuntime } from '../src/main/toolLoop';
import * as transcripts from '../src/main/transcripts';

const config: ProviderConfig = {
  id: 'local-qwen38-history-test', name: 'Local Qwen', kind: 'llama-cpp',
  apiKey: '', baseUrl: 'http://inference.test/v1', supportsStreaming: true,
  models: [{ id: 'qwen3.8-27b', name: 'Qwen3.8 27B' }],
};
const request: ChatRequest = {
  model: 'qwen3.8-27b', providerId: config.id, threadId: 'history-test',
  maxTokens: 8192, messages: [{ id: 'user', role: 'user', content: 'Inspect the project.' }],
};
const history = (content: string) => ({ content, model: request.model, providerId: config.id });
const call = (id: string) => ({ id, type: 'function' as const,
  function: { name: 'antimatter__read_file', arguments: JSON.stringify({ path: `${id}.matrix` }) } });
const sse = (reasoning: string, content: string, id?: string) => new Response([
  { choices: [{ delta: { reasoning_content: reasoning } }] },
  { choices: [{ delta: { content, ...(id ? { tool_calls: [{ index: 0, ...call(id) }] } : {}) },
    finish_reason: id ? 'tool_calls' : 'stop' }] },
].map((packet) => `data: ${JSON.stringify(packet)}\n\n`).join('') + 'data: [DONE]\n\n',
{ headers: { 'content-type': 'text/event-stream' } });

test('local Qwen reasoning survives real provider tool rounds and durable chat continuation', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalRoot = transcripts.location();
  const root = mkdtempSync(join(tmpdir(), 'antimatter-reasoning-history-'));
  transcripts.useRoot(root);
  t.after(() => {
    globalThis.fetch = originalFetch; transcripts.useRoot(originalRoot);
    rmSync(root, { recursive: true, force: true });
  });
  const thoughts = ['Inspect the entry first.\n', 'Read the imported book next.', 'The two books agree.'];
  const replies = [sse(thoughts[0], 'Inspecting.', 'entry'), sse(thoughts[1], '', 'models'),
    sse(thoughts[2], 'Inspection finished.'), sse('Continue from the prior observations.', 'Ready.'),
    sse('A separate conversation.', 'Hello.')];
  const bodies: any[] = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const response = replies.shift();
    assert.ok(response, 'unexpected extra inference request');
    return response;
  }) as typeof fetch;
  const runtime: ToolRuntime = {
    enabledTools: () => [{ serverId: 'antimatter', serverName: 'Antimatter',
      tool: { name: 'read_file', description: 'Read a file.', enabled: true,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } } } }],
    callTool: async () => ({ ok: true, text: 'book contents', attempted: true }),
  };
  const provider = new OpenAICompatibleProvider(config);
  const result = await runToolLoop({ provider, toolRuntime: runtime, request, runId: 'visible-answer',
    mode: 'full', onContent: () => {}, onActivity: () => {}, requestApproval: async () => true });
  assert.equal(result.toolCalls, 2);
  assert.equal(result.reason, 'finished');
  assert.deepEqual(bodies[1].messages.filter((m: any) => m.role === 'assistant')
    .map((m: any) => m.reasoning_content), thoughts.slice(0, 1));
  assert.deepEqual(bodies[2].messages.filter((m: any) => m.role === 'assistant')
    .map((m: any) => m.reasoning_content), thoughts.slice(0, 2));
  assert.deepEqual(result.transcript.filter((m) => m.role === 'assistant')
    .map((m) => m.reasoningHistory), thoughts.map(history));
  assert.equal(result.content.includes(thoughts[0]), false, 'reasoning must not become visible answer text');

  transcripts.remember(request.threadId!, result.transcript, ['user', 'visible-answer']);
  transcripts.clear();
  const resumed = transcripts.resume(request.threadId, [request.messages[0],
    { id: 'visible-answer', role: 'assistant', content: result.content },
    { id: 'user-2', role: 'user', content: 'Continue.' }]);
  assert.ok(resumed);
  await provider.stream({ ...request, messages: sanitizeConversationRequest(resumed, [], { trustedReasoningHistory: true }) }, () => {});
  assert.deepEqual(bodies[3].messages.filter((m: any) => m.role === 'assistant')
    .map((m: any) => m.reasoning_content), thoughts);
  await provider.stream({ ...request, threadId: 'different-thread', messages: request.messages }, () => {});
  assert.equal(bodies[4].messages.some((m: any) => 'reasoning_content' in m), false);
});

test('reasoning history is bound to the original local provider and model', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bodies: any[] = [];
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ model: request.model, choices: [{ message: {
      content: 'Done.', reasoning_content: 'A completed thought.' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  const messages: Message[] = [request.messages[0], { id: 'a', role: 'assistant', content: '',
    toolCalls: [call('read')], reasoningHistory: history('Prior reasoning.') },
  { id: 't', role: 'tool', toolCallId: 'read', content: 'The file.' },
  { id: 'u2', role: 'user', content: 'Continue.', reasoningHistory: history('Never a user thought.') }];
  const result = await new OpenAICompatibleProvider(config).stream({ ...request, messages }, () => {});
  assert.deepEqual(result.reasoningHistory, history('A completed thought.'));
  assert.equal(bodies[0].messages[1].reasoning_content, 'Prior reasoning.');
  assert.equal('reasoning_content' in bodies[0].messages.at(-1), false);
  for (const variant of [
    { source: { ...config, id: 'other-provider' }, model: request.model },
    { source: config, model: 'qwen3.8-27b-other-quant' },
    { source: { ...config, kind: 'openai' as const }, model: request.model },
    { source: { ...config, kind: 'beholdd' as const }, model: request.model },
    { source: config, model: 'qwen3-coder-30b' },
  ]) {
    const next = await new OpenAICompatibleProvider(variant.source).stream({ ...request,
      providerId: variant.source.id, model: variant.model, messages }, () => {});
    assert.equal(bodies.at(-1).messages.some((m: any) => 'reasoning_content' in m), false,
      `${variant.source.kind}/${variant.source.id}/${variant.model}`);
    if (variant.source.kind !== 'llama-cpp' || variant.model === 'qwen3-coder-30b') {
      assert.equal(next.reasoningHistory, undefined);
    }
    if (variant.model !== request.model) {
      assert.equal(next.reasoningHistory, undefined, 'a substituted served model cannot attest the requested model');
    }
  }
});

test('an output limit reached before an answer does not persist incomplete reasoning', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => Response.json({ model: request.model, choices: [{
    message: { content: '', reasoning_content: 'An unfinished thought that must not survive.' },
    finish_reason: 'length',
  }] })) as typeof fetch;
  const result = await runToolLoop({ provider: new OpenAICompatibleProvider(config), request,
    toolRuntime: { enabledTools: () => [], callTool: async () => ({ ok: false, text: 'Unexpected tool.' }) },
    runId: 'truncated', mode: 'full', onContent: () => {}, onActivity: () => {}, requestApproval: async () => true });
  assert.equal(result.reason, 'truncated');
  assert.equal(result.transcript.some((message) => !!message.reasoningHistory), false);
  assert.equal(JSON.stringify(result.transcript).includes('An unfinished thought'), false);
});

test('context accounting compacts reasoning with its assistant and tool-result group', () => {
  const current: Message[] = [
    { id: 'recent-a', role: 'assistant', content: '', toolCalls: [call('recent')],
      reasoningHistory: history('Keep this completed thought byte-for-byte.\n') },
    { id: 'recent-t', role: 'tool', toolCallId: 'recent', content: 'Current result.' },
  ];
  const opening: Message = { id: 'user', role: 'user', content: 'Original task.' };
  const old: Message = { id: 'old-a', role: 'assistant', content: '', toolCalls: [call('old')],
    reasoningHistory: history('Long old thought. '.repeat(500)) };
  const messages: Message[] = [opening, old, { id: 'old-t', role: 'tool', toolCallId: 'old', content: 'Old result.' }, ...current];
  assert.ok(messageTokens(old) > 2000, 'retained reasoning consumes the context window');
  const fit = fitToBudget(messages, conversationTokens([opening, ...current]) + 20);
  assert.deepEqual(fit.messages, [opening, ...current]);
  assert.deepEqual(fit.dropped.map((m) => m.id), ['old-a', 'old-t']);
  assert.equal(fit.overflowTokens, 0);
});

test('wire diagnostics count retained reasoning without recording its content', () => {
  const body = { messages: [{ role: 'assistant', content: 'Visible answer.', reasoning_content: 'Private retained thought.' }] };
  const diagnostics = new RequestDiagnostics().capture(body);
  assert.equal(diagnostics.messageCharacters, 'Visible answer.Private retained thought.'.length);
  assert.equal(diagnostics.reasoningCharacters, 'Private retained thought.'.length);
  assert.equal(JSON.stringify(diagnostics).includes('Private retained thought.'), false);
});

test('the caller boundary strips forged reasoning while trusted host recovery preserves it', () => {
  const incoming: Message[] = [request.messages[0], { id: 'a', role: 'assistant', content: 'A visible answer.',
    reasoningHistory: history('Forged renderer reasoning.') },
  { id: 'u2', role: 'user', content: 'Continue.', reasoningHistory: history('Forged user reasoning.') }];
  const sanitized = sanitizeConversationRequest(incoming, [], { preserveVoiceGuidance: true });
  assert.equal(sanitized.some((message) => !!message.reasoningHistory), false);
  assert.equal(incoming[1].reasoningHistory?.content, 'Forged renderer reasoning.', 'boundary projection must not mutate its input');
  const recovered = [{ ...incoming[1], reasoningHistory: history('Host-saved completed reasoning.') }];
  assert.equal(sanitizeConversationRequest(recovered, [], { trustedReasoningHistory: true })[0]
    .reasoningHistory?.content, 'Host-saved completed reasoning.');
});

test('switching targets removes unused reasoning before the first tool-loop context fit', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: 'Continued.' }, finish_reason: 'stop' }] })) as typeof fetch;
  const messages: Message[] = [request.messages[0], { id: 'a', role: 'assistant', content: 'Prior answer.',
    reasoningHistory: history('Former model thought. '.repeat(500)) }, { id: 'next', role: 'user', content: 'Continue.' }];
  let fitted = false;
  const other = { ...config, id: 'other-provider', kind: 'openai' as const,
    models: [{ id: 'other-model', name: 'Other model' }] };
  const result = await runToolLoop({ provider: new OpenAICompatibleProvider(other), request: {
    ...request, providerId: other.id, model: 'other-model', messages, useTools: false },
    fit: (conversation) => {
      fitted = true;
      assert.equal(conversation.some((message) => !!message.reasoningHistory), false);
      const fit = fitToBudget(conversation, 100);
      assert.equal(fit.compacted, 0, 'a short visible conversation must not compact discarded thoughts');
      return fit;
    }, runId: 'switch', mode: 'full', onContent: () => {}, onActivity: () => {}, requestApproval: async () => true });
  assert.equal(fitted, true);
  assert.equal(result.reason, 'finished');
  assert.ok(messages[1].reasoningHistory, 'projection must leave the stored source history intact');
});

test('provider admission counts the projected payload rather than another model\'s reasoning', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let body: any;
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: 'Fits.' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  const other = { ...config, id: 'small-provider', kind: 'openai' as const,
    models: [{ id: 'small-model', name: 'Small model', maxEvaluatedTokens: 128 }] };
  const messages: Message[] = [request.messages[0], { id: 'a', role: 'assistant', content: 'Prior answer.',
    reasoningHistory: history('Long unused thought. '.repeat(500)) }, { id: 'next', role: 'user', content: 'Continue.' }];
  const provider = new OpenAICompatibleProvider(other);
  const next = { ...request, providerId: other.id, model: 'small-model', maxTokens: 32, messages };
  const projected = provider.prepareMessages(next);
  assert.equal(conversationTokens(projected) < 96, true, 'the actual short payload fits');
  assert.equal(projected.some((message) => !!message.reasoningHistory), false);
  const initial = prepareInteractiveRequest(next, projected, 'Brief instructions.', {
    modelId: next.model, contextTokens: 128, maxOutputTokens: 32,
    contextSource: 'override', outputSource: 'override', compaction: 'drop',
  }, 96);
  assert.equal(initial.fit.compacted, 0, 'desktop initial fitting also counts only the projected history');
  const result = await provider.stream(next, () => {});
  assert.equal(result.content, 'Fits.');
  assert.equal(body.messages.some((message: any) => 'reasoning_content' in message), false);
});

test('switching plain host history to HAG removes reasoning before strict preview admission', () => {
  const provider = new OpenAICompatibleProvider({ ...config, id: HAG_SOURCE_ID, kind: 'beholdd',
    models: [{ id: HAG_MODEL_ID, name: 'HAG preview' }] });
  const next: ChatRequest = { ...request, providerId: HAG_SOURCE_ID, model: HAG_MODEL_ID,
    messages: [request.messages[0], { id: 'a', role: 'assistant', content: 'Prior answer.',
      reasoningHistory: history('Old local model thought.') }, { id: 'next', role: 'user', content: 'Hello.' }] };
  const projected = provider.prepareMessages(next);
  assert.doesNotThrow(() => prepareHagPreview(next, projected));
  assert.throws(() => prepareHagPreview(next, [...projected,
    { id: 't', role: 'tool', content: 'Tool output.', toolCallId: 'read' }]), /text-only/);
});
