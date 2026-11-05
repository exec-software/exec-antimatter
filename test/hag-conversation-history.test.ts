import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { conversationRequestMessages } from '../renderer/src/lib/requestMessages';
import type { Message as VisibleMessage } from '../renderer/src/types';
import { OpenAICompatibleProvider } from '../src/api/providers/openai';
import type { ChatRequest, ProviderConfig } from '../src/api/types';
import { fitToBudget, promptBudget } from '../src/main/context';
import { prepareInteractiveRequest } from '../src/main/interactiveRequest';
import { renderInstructions } from '../src/main/memory/context';
import * as profiles from '../src/main/modelProfiles';
import { withSituation } from '../src/main/prompt';
import { runToolLoop } from '../src/main/toolLoop';
import * as transcripts from '../src/main/transcripts';
import fixture from './fixtures/hag-generated-history.json';

// Captured ordinary JSON replies, never a running inference service. See the fixture's provenance.
const source: ProviderConfig = {
  id: 'hag-history-test', name: 'Beholdd history fixture', kind: 'beholdd',
  baseUrl: 'http://hag-history.invalid/v1', apiKey: '', supportsStreaming: true,
  models: [{ id: fixture.turns[0].request.model, name: 'Qualified Qwen3 fixture' }],
};

for (const cache of ['warm', 'reloaded', 'missing'] as const) {
  test(`HAG reply reaches the next editor request with ${cache} transcript cache`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'hag-conversation-history-'));
    const oldTranscriptRoot = transcripts.location();
    const oldProfilePath = profiles.storeLocation();
    t.after(() => {
      transcripts.useRoot(oldTranscriptRoot);
      profiles.useConfigPath(oldProfilePath);
      rmSync(root, { recursive: true, force: true });
    });
    transcripts.useRoot(join(root, 'transcripts'));
    profiles.useConfigPath(join(root, 'profiles.json'));
    profiles.setOverride(source.id, source.models[0].id, {
      contextTokens: 2048, maxOutputTokens: 128, compaction: 'drop',
    });
    const profile = profiles.withEngineContext(profiles.resolve({
      providerId: source.id, modelId: source.models[0].id, serverContextTokens: 2048,
    }), 2048);
    assert.equal(profile.maxOutputTokens, 128);
    const budget = promptBudget(profile, []);
    const instructions = 'Use the existing project conventions.\n'.repeat(60).slice(0, 2048);
    const system = withSituation(renderInstructions([{
      path: '/fixture/AGENTS.md', label: 'AGENTS.md', content: instructions, length: instructions.length,
    }]), { workspace: '/fixture', workspaceConfirmed: true, mode: 'read', tools: [], maxOutputTokens: profile.maxOutputTokens });
    assert.equal(system, fixture.turns[0].request.messages[0].content);

    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), `${source.baseUrl}/chat/completions`);
      assert.equal(init?.method, 'POST');
      assert.ok(calls < 2, 'the fixture permits exactly one request per turn');
      const captured = fixture.turns[calls++];
      // The desktop asks for streaming and leaves temperature to the engine. Message bytes and
      // output budget must still match the qualified, non-streaming temperature-zero request.
      const { temperature: _temperature, ...expected } = captured.request;
      assert.deepEqual(JSON.parse(String(init?.body)), { ...expected, stream: true });
      // Exercise the real streaming loop and provider's ordinary-JSON response fallback.
      return Response.json(captured.response);
    });
    const provider = new OpenAICompatibleProvider(source);
    const visible: VisibleMessage[] = [];
    for (let turn = 0; turn < 2; turn++) {
      if (turn === 1 && cache === 'reloaded') transcripts.clear();
      if (turn === 1 && cache === 'missing') transcripts.remove('editor-thread');
      const captured = fixture.turns[turn];
      const user: VisibleMessage = {
        id: `user-${turn}`, role: 'user', content: captured.request.messages.at(-1)!.content,
        meta: { createdAt: turn + 1 },
      };
      const responseId = `visible-answer-${turn}`;
      const request: ChatRequest = {
        messages: conversationRequestMessages(visible, user),
        providerId: source.id, model: source.models[0].id, threadId: 'editor-thread',
        requestId: responseId, responseMessageId: responseId, accessMode: 'read', useTools: true,
      };
      assert.equal(request.maxTokens, undefined, 'the renderer leaves output planning to the host');
      const resumed = transcripts.resume(request.threadId, request.messages);
      assert.equal(resumed !== null, turn === 1 && cache !== 'missing');
      const prepared = prepareInteractiveRequest(request, resumed ?? request.messages, system, profile, budget);
      assert.equal(prepared.fit.compacted, 0);
      assert.equal(prepared.fit.overflowTokens, 0);
      assert.equal(prepared.request.useTools, true);
      let streamed = '';
      const result = await runToolLoop({
        provider, request: prepared.request, runId: responseId, mode: 'read',
        toolRuntime: { enabledTools: () => [], callTool: async () => assert.fail('no tool dispatch expected') },
        fit: (messages, tools) => fitToBudget(messages, promptBudget(profile, tools)),
        onContent: (content) => { streamed += content; },
        onActivity: () => assert.fail('no tools are connected in this fixture'),
        requestApproval: async () => assert.fail('no approval expected'),
      });
      assert.equal(result.reason, 'finished');
      assert.equal(result.rounds, 1);
      assert.equal(result.toolCalls, 0);
      assert.equal(streamed, captured.response.choices[0].message.content);
      assert.equal(result.content, streamed);
      assert.equal(result.transcript.at(-1)?.content, streamed);
      // These are the visible aliases/content checkpoint used by streamChat, including the
      // response id that differs from the loop's internal assistant message id.
      transcripts.remember('editor-thread', result.transcript,
        [...request.messages.map((message) => message.id), responseId], [[responseId, streamed]]);
      visible.push(user, { id: responseId, role: 'assistant', content: streamed,
        meta: { createdAt: turn + 1, finishedAt: turn + 2, modelId: request.model, sourceName: source.name } });
    }
    assert.equal(calls, 2);
    assert.deepEqual(visible.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  });
}

test('editor request snapshot preserves attachment formatting and raw history without UI metadata', () => {
  const history: VisibleMessage[] = [{ id: 'answer', role: 'assistant', content: '<think>\n\n</think>\n\nready.',
    meta: { createdAt: 1, reasoningTokens: 6 } }];
  const user: VisibleMessage = { id: 'followup', role: 'user', content: 'Use this file.',
    attachments: [{ id: 'file', name: 'note.txt', content: 'a\nb\n', size: 4 }], meta: { createdAt: 2 } };
  const before = structuredClone({ history, user });
  const messages = conversationRequestMessages(history, user);
  assert.deepEqual(messages, [
    { id: 'answer', role: 'assistant', content: '<think>\n\n</think>\n\nready.' },
    { id: 'followup', role: 'user', content: 'Use this file.\n\n<file name="note.txt">\na\nb\n\n</file>' },
  ]);
  assert.deepEqual({ history, user }, before);
  user.content = 'Changed draft';
  assert.equal(messages[1].content, 'Use this file.\n\n<file name="note.txt">\na\nb\n\n</file>');
});

test('host replaces stale grounding and caller output limits with the current profile', () => {
  const profile: profiles.ModelProfile = {
    modelId: 'fixture', contextTokens: 2048, maxOutputTokens: 128, maxToolCallsPerMessage: 4,
    contextSource: 'server', outputSource: 'override', toolCallSource: 'override',
    thinkingLevel: 'default', compaction: 'drop',
  };
  const request: ChatRequest = { model: 'fixture', providerId: 'source', requestId: 'reply', threadId: 'thread',
    messages: [{ id: 'user', role: 'user', content: 'Again' }], maxTokens: 4096, useTools: true, accessMode: 'read' };
  const prepared = prepareInteractiveRequest(request,
    [{ id: 'old-system', role: 'system', content: 'Old grounding' }, ...request.messages],
    'Current grounding', profile, promptBudget(profile, []));
  assert.deepEqual(prepared.request, { ...request, maxTokens: 128, maxToolCalls: 4, thinkingLevel: 'default',
    messages: [{ id: 'system', role: 'system', content: 'Current grounding' }, ...request.messages] });
  assert.equal(request.maxTokens, 4096);
});
