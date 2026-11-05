import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OpenAICompatibleProvider } from '../src/api/providers/openai';
import type { InferenceMetrics, ProviderConfig } from '../src/api/types';
import type { ConversationThread } from '../src/main/conversations';
import type { TurnOwner } from '../src/main/activeTurns';
import { BotChatStore } from '../src/main/botChat';
import { ChatCoordinationStore } from '../src/main/chatCoordination';
import { withInteractiveCollaboration } from '../src/main/interactiveCollaboration';
import { CodeReviewStore } from '../src/main/codeReview/store';
import { CODE_REVIEW_INSTRUCTIONS, withCodeReview } from '../src/main/codeReview/tools';
import { prepareInteractiveRequest } from '../src/main/interactiveRequest';
import type { ModelProfile } from '../src/main/modelProfiles';
import { promptBudget } from '../src/main/context';
import { mergeInstructions, withSituation } from '../src/main/prompt';
import { buildToolset } from '../src/main/toolPolicy';
import type { ToolRuntime } from '../src/main/toolLoop';
import { LIST_CHATS, SEND_MESSAGE, SERVER_ID as CONNECTED } from '../src/main/chatCoordinationRuntime';
import { LIST_CHANNELS, POST_MESSAGE, SERVER_ID as PUBLIC } from '../src/main/botChatRuntime';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-client-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'project'); mkdirSync(workspace);
  const threads: ConversationThread[] = ['a', 'b'].map(id => ({ id, title: id, directory: workspace,
    projectId: 'inbox', createdAt: 1, updatedAt: 1, revision: 1, messages: [] }));
  const activeRun = (id: string) => `run-${id}`;
  const connected = new ChatCoordinationStore(join(root, 'connected.json'), { threads: () => threads, activeRun });
  connected.connect('a', 'b');
  const publicChat = new BotChatStore(join(root, 'public.json'), { threads: () => threads, activeRun });
  publicChat.configure({ enabled: true });
  let baseCalls = 0;
  const base: ToolRuntime = { enabledTools: () => [], callTool: async () => { baseCalls++; return { ok: true, text: 'base' }; } };
  const reviews = withCodeReview(base, { store: new CodeReviewStore(join(root, 'reviews')), workspace,
    author: { kind: 'agent', label: 'Fixture agent', threadId: 'a', runId: 'run-a' } });
  const wrap = (owner: TurnOwner) => withInteractiveCollaboration(reviews, { owner, threadId: 'a', runId: 'run-a', workspace,
    publicWorkspace: workspace, currentMode: () => 'full', signal: new AbortController().signal, connected, publicChat });
  return { workspace, connected, publicChat, wrap, baseCalls: () => baseCalls };
}

const profile: ModelProfile = { modelId: 'test', thinkingLevel: 'default', contextTokens: 32768,
  maxOutputTokens: 2048, maxToolCallsPerMessage: 8, contextSource: 'override', outputSource: 'override',
  toolCallSource: 'override', compaction: 'drop' };
const source: ProviderConfig = { id: 'test', name: 'fixture', kind: 'llama-cpp', apiKey: '',
  baseUrl: 'http://no-inference.invalid/v1', supportsStreaming: true, models: [{ id: 'test', name: 'test' }] };

test('desktop and phone produce identical grounded wire requests, including collaboration schemas', async (t) => {
  const f = fixture(t);
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }] });
  });
  const provider = new OpenAICompatibleProvider(source);
  const observed: InferenceMetrics[] = [];
  for (const owner of [{ kind: 'renderer' }, { kind: 'remote', deviceId: 'phone' }] as TurnOwner[]) {
    const wrapper = f.wrap(owner);
    const entries = wrapper.runtime!.enabledTools();
    assert.equal(entries.length, 13);
    const tools = buildToolset(entries).definitions;
    const system = withSituation(mergeInstructions('Shared assistant identity.', 'Shared project instructions.', CODE_REVIEW_INSTRUCTIONS, ...wrapper.instructions()), {
      workspace: f.workspace, workspaceConfirmed: true, mode: 'full', tools: entries.map(e => e.tool.name), maxOutputTokens: profile.maxOutputTokens,
    });
    const visible = [{ id: 'user', role: 'user' as const, content: 'Continue.' }];
    const request = prepareInteractiveRequest({ providerId: 'test', model: 'test', threadId: 'a',
      requestId: owner.kind, responseMessageId: `${owner.kind}-reply`, accessMode: 'full', messages: visible }, visible,
      system, profile, promptBudget(profile, tools)).request;
    await provider.stream({ ...request, tools }, data => { if (data.metrics) observed.push(data.metrics); });
  }
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1], 'switching controller must preserve actual HTTP body bytes');
  const diagnostics = observed.filter(e => e.phase === 'started').map(e => e.request!);
  assert.equal(diagnostics[0].payloadFingerprint, diagnostics[1].payloadFingerprint);
  assert.equal(diagnostics[1].comparison?.sameSystem, true);
  assert.equal(diagnostics[1].comparison?.sameTools, true);
  assert.equal(diagnostics[1].comparison?.sameSettings, true);
});

test('identical phone catalog confers no collaboration reads, writes, enrollment or inbox intake', async (t) => {
  const f = fixture(t);
  f.connected.send('b', 'a', 'Private peer note', { runId: 'run-b', clientMessageId: 'private' });
  const channel = f.publicChat.listChannels()[0].id;
  f.publicChat.enroll('a', 'run-a', f.workspace);
  f.publicChat.post('b', channel, 'Public mention', { runId: 'run-b', clientMessageId: 'public', mentionThreadIds: ['a'] });
  const before = JSON.stringify(f.publicChat.state());
  const desktop = f.wrap({ kind: 'renderer' });
  const phone = f.wrap({ kind: 'remote', deviceId: 'phone' });
  assert.deepEqual(phone.runtime!.enabledTools(), desktop.runtime!.enabledTools());
  assert.deepEqual(phone.instructions(), desktop.instructions());
  for (const [server, name, args] of [
    [CONNECTED, LIST_CHATS, {}], [CONNECTED, SEND_MESSAGE, { chat_id: 'b', message: 'Unauthorized' }],
    [PUBLIC, LIST_CHANNELS, {}], [PUBLIC, POST_MESSAGE, { channel_id: channel, message: 'Unauthorized' }],
  ] as const) {
    const prepared = await phone.runtime!.prepareTool!(server, name, args);
    const result = await phone.runtime!.callTool(server, name, prepared.args, { prepared: prepared.prepared });
    assert.equal(result.ok, false); assert.equal(result.attempted, false);
    assert.match(result.text, /phone-controlled turn/);
    // Even a host-side prepared operation from the allowed wrapper cannot cross the boundary.
    const hostPrepared = await desktop.runtime!.prepareTool!(server, name, args);
    assert.equal((await phone.runtime!.callTool(server, name, hostPrepared.args, { prepared: hostPrepared.prepared })).ok, false);
  }
  assert.equal(phone.background.ready(), 0);
  assert.deepEqual(phone.background.take(), []);
  assert.equal(f.connected.pendingCount('a'), 1);
  assert.equal(f.connected.pendingCount('b'), 0);
  assert.equal(JSON.stringify(f.publicChat.state()), before);
  assert.equal(f.baseCalls(), 0);
  const prepared = await desktop.runtime!.prepareTool!(CONNECTED, LIST_CHATS, {});
  assert.equal((await desktop.runtime!.callTool(CONNECTED, LIST_CHATS, prepared.args, { prepared: prepared.prepared })).ok, true);
});

test('feature disable removes public schemas equally and floating conversations stay isolated', (t) => {
  const f = fixture(t);
  f.publicChat.configure({ enabled: false });
  const desktop = f.wrap({ kind: 'renderer' });
  const phone = f.wrap({ kind: 'remote', deviceId: 'phone' });
  // Disabling the public chat leaves connected-chat and code-review capabilities intact.
  assert.equal(desktop.runtime!.enabledTools().length, 9);
  assert.deepEqual(phone.runtime!.enabledTools(), desktop.runtime!.enabledTools());
  assert.deepEqual(phone.instructions(), desktop.instructions());
  const floating = withInteractiveCollaboration(null, { owner: { kind: 'renderer' }, runId: 'floating',
    workspace: f.workspace, publicWorkspace: '', currentMode: () => 'full', signal: new AbortController().signal,
    connected: f.connected, publicChat: f.publicChat });
  assert.equal(floating.runtime, null); assert.deepEqual(floating.instructions(), ['', '']);
  assert.deepEqual(floating.background.take(), []);
});
