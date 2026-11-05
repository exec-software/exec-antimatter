import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import * as conversations from '../src/main/conversations';

type Candidate = conversations.ImportThreadsInput['conversations'][number];

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'antimatter-conversation-import-'));
  const path = join(directory, 'conversations.json');
  const previous = conversations.location();
  conversations.useStorePath(path);
  t.after(() => { conversations.useStorePath(previous); rmSync(directory, { recursive: true, force: true }); });
  return path;
}

function candidate(externalId = 'external-session'): Candidate {
  return { source: 'claude', format: 'claude-export', externalId, title: 'Imported history', createdAt: 20, updatedAt: 30,
    messages: [
      { id: 'external-user', role: 'user', content: 'Original question', meta: { createdAt: 20 } },
      { id: 'external-assistant', role: 'assistant', content: 'Original answer', meta: { createdAt: 25 } },
    ] };
}

function existingThread() {
  const effect: conversations.RemoteConversationEffect = {
    id: 'a'.repeat(43), payloadHash: 'A'.repeat(43), kind: 'thread.create', appliedAt: 10,
    result: { threadId: 'existing', clientThreadId: 'phone-existing' },
  };
  let thread = conversations.createThread({ id: 'existing', projectId: 'old-project', title: 'Do not disturb', createdAt: 10,
    directory: '/my/current/workspace', accessMode: 'full', providerId: 'my-provider', modelId: 'my-model' }, 0, effect);
  thread = conversations.appendUserMessage(thread.id, { id: 'existing-message', content: 'Already here', createdAt: 11 }, thread.revision);
  conversations.setThreadPinned(thread.id, 12, thread.revision);
  conversations.save({ ...conversations.load(), activeThreadId: thread.id,
    drafts: { [thread.id]: { text: 'Unsent draft', attachments: [{ id: 'draft-asset', name: 'draft.txt', size: 4, content: 'data' }] } },
    pinned: [{ id: 'message-pin', threadId: thread.id, messageId: 'existing-message', snippet: 'Already here', sourceName: 'User', createdAt: 12 }] });
}

test('chat imports append atomically with private local identities and leave existing application state untouched', (t) => {
  const path = fixture(t);
  existingThread();
  const before = conversations.snapshot();
  const changes: conversations.ConversationChange[] = [];
  t.after(conversations.subscribe((change) => changes.push(change)));
  const input = { ...candidate(), providerId: 'external-provider', modelId: 'external-model', directory: '/untrusted/worktree', accessMode: 'full', pinnedAt: 99 };
  const result = conversations.importThreads({ projectId: 'selected-project', conversations: [input, candidate('second-session')] }, 100);
  assert.equal(result.imported.length, 2);
  assert.equal(result.skipped, 0);
  const after = conversations.snapshot();
  assert.deepEqual(after.threads[0], before.threads[0]);
  for (const key of ['activeThreadId', 'drafts', 'pinned', 'remoteEffects'] as const) assert.deepEqual(after[key], before[key]);
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(changes, [{ kind: 'import', revision: after.revision }]);
  for (const imported of result.imported) {
    assert.match(imported.id, /^[\da-f-]{36}$/);
    assert.equal(imported.projectId, 'selected-project');
    assert.equal(imported.revision, 1);
    assert.equal(imported.directory, null);
    assert.equal(imported.accessMode, 'ask');
    assert.equal(imported.providerId, undefined);
    assert.equal(imported.modelId, undefined);
    assert.equal(imported.pinnedAt, undefined);
    assert.equal(imported.importedFrom?.importedAt, 100);
    assert.notEqual(imported.messages[0].id, input.messages[0].id);
    assert.equal(imported.messages[1].meta.finishedAt, 25);
  }
  const importedId = result.imported[0].id;
  result.imported[0].messages[0].content = 'Mutated return value';
  assert.equal(conversations.snapshot().threads.find((thread) => thread.id === importedId)?.messages[0].content, 'Original question');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  conversations.useStorePath(path);
  assert.equal(conversations.snapshot().threads.find((thread) => thread.id === importedId)?.importedFrom?.externalId, 'external-session');
  assert.deepEqual(conversations.snapshot().remoteEffects, before.remoteEffects);
});

test('imports deduplicate source format and external identity globally and within one transaction', (t) => {
  const path = fixture(t);
  const exportChat = candidate('same-id');
  const codeChat = { ...candidate('same-id'), format: 'claude-code' as const };
  const codexChat = { ...candidate('same-id'), source: 'codex' as const, format: 'codex-rollout' as const };
  const opencodeChat = { ...candidate('same-id'), source: 'opencode' as const, format: 'opencode-export' as const };
  const first = conversations.importThreads({ projectId: 'one', conversations: [exportChat, exportChat, codeChat, codexChat, opencodeChat] }, 100);
  assert.equal(first.imported.length, 4);
  assert.equal(first.skipped, 1);
  const before = conversations.snapshot();
  const disk = readFileSync(path, 'utf8');
  const changes: conversations.ConversationChange[] = [];
  t.after(conversations.subscribe((change) => changes.push(change)));
  const second = conversations.importThreads({ projectId: 'another-project', conversations: [codexChat, codeChat, exportChat, opencodeChat] }, 200);
  assert.deepEqual(second, { imported: [], skipped: 4 });
  assert.deepEqual(conversations.snapshot(), before);
  assert.equal(readFileSync(path, 'utf8'), disk, 'duplicate-only imports must not rewrite state');
  assert.deepEqual(changes, []);
});

test('imported provenance roundtrips and cannot be erased or replaced by compatibility renderer checkpoints', (t) => {
  const path = fixture(t);
  const imported = conversations.importThreads({ projectId: 'project', conversations: [candidate()] }, 100).imported[0];
  const legacy = conversations.load();
  assert.deepEqual(legacy.threads[0].importedFrom, imported.importedFrom);
  delete legacy.threads[0].importedFrom;
  legacy.threads[0].title = 'Renamed in an older renderer';
  conversations.save(legacy);
  let current = conversations.snapshot().threads[0];
  assert.equal(current.title, 'Renamed in an older renderer');
  assert.deepEqual(current.importedFrom, imported.importedFrom);
  const forged = conversations.load();
  forged.threads[0].importedFrom = { source: 'codex', format: 'codex-rollout', externalId: 'wrong', importedAt: 999 };
  conversations.save(forged);
  current = conversations.snapshot().threads[0];
  assert.deepEqual(current.importedFrom, imported.importedFrom);
  assert.equal(current.revision, 2, 'changing only protected provenance is not a thread mutation');
  conversations.save(legacy);
  assert.deepEqual(conversations.snapshot().threads[0].importedFrom, imported.importedFrom);
  conversations.useStorePath(path);
  assert.deepEqual(conversations.load().threads[0].importedFrom, imported.importedFrom);
  assert.equal(conversations.importThreads({ projectId: 'elsewhere', conversations: [candidate()] }, 200).skipped, 1);
});

test('tools and attachments import only as inert history without live approval agent preview or asset linkage', (t) => {
  fixture(t);
  const chat = candidate();
  chat.messages[1].meta.tools = ['pending', 'running', 'done', 'failed', 'denied'].map((status, index) => ({
    callId: `call-${index}`, requestId: 'external-assistant', activityId: 'live-activity', approvalId: 'live-approval',
    serverId: 'live-server', serverName: 'Historical source', toolName: 'bash', tier: 'danger', status: status as conversations.ConversationToolStatus,
    args: '{"command":"do not execute this"}', result: 'Historical output', contentOffset: 999, awaitingApproval: true,
    subagent: { taskId: 'live-task', agentId: 'live-agent', agentName: 'Agent', title: 'Do not open' },
    preview: { kind: 'page', target: 'http://localhost:9999', title: 'Do not navigate', workspace: '/source/workspace', assetId: 'live-asset' },
    remoteApprovalDetails: 'Not an active approval',
  }));
  chat.messages[1].meta.voiceGuidance = [{ id: 'pending-voice', text: 'Do not dispatch', at: 26, contentOffset: 0, status: 'queued' }];
  chat.messages[0].attachments = [{ id: 'external-attachment', name: 'source.txt', size: 4, content: 'data', assetId: 'live-asset' }];
  const imported = conversations.importThreads({ projectId: 'project', conversations: [chat] }, 100).imported[0];
  const assistant = imported.messages[1];
  assert.deepEqual(assistant.meta.tools?.map((tool) => tool.status), ['failed', 'failed', 'done', 'failed', 'denied']);
  for (const tool of assistant.meta.tools ?? []) {
    assert.equal(tool.requestId, assistant.id);
    assert.equal(tool.awaitingApproval, false);
    assert.equal(tool.caution, 'Imported historical tool record; not executed or independently verified by Antimatter.');
    assert.equal(tool.contentOffset, assistant.content.length);
    for (const key of ['approvalId', 'activityId', 'serverId', 'subagent', 'preview', 'remoteApprovalDetails'] as const) assert.equal(tool[key], undefined);
    assert.equal(tool.args, '{"command":"do not execute this"}');
  }
  assert.equal(assistant.meta.voiceGuidance, undefined);
  assert.equal(imported.messages[0].attachments?.[0].assetId, undefined);
  assert.equal(imported.messages[0].attachments?.[0].content, 'data');
});

test('invalid batches fail without partial writes cache changes or notifications', (t) => {
  const path = fixture(t);
  existingThread();
  const before = conversations.snapshot();
  const disk = readFileSync(path, 'utf8');
  const changes: conversations.ConversationChange[] = [];
  t.after(conversations.subscribe((change) => changes.push(change)));
  const invalid: unknown[] = [
    { ...candidate(), source: 'unknown' }, { ...candidate(), source: 'codex' },
    { ...candidate(), source: 'opencode' }, { ...candidate(), format: 'opencode-export' },
    { ...candidate(), source: 'opencode', format: 'codex-rollout' },
    { ...candidate(), source: 'codex', format: 'opencode-export' },
    { ...candidate(), externalId: '' }, { ...candidate(), title: '' }, { ...candidate(), updatedAt: NaN },
    { ...candidate(), messages: [{ ...candidate().messages[0], role: ['user'] }] },
    { ...candidate(), messages: [{ ...candidate().messages[0], role: 'system' }] },
    { ...candidate(), messages: [{ ...candidate().messages[0], content: 42 }] },
    { ...candidate(), messages: [{ ...candidate().messages[0], meta: { createdAt: Infinity } }] },
    { ...candidate(), messages: [candidate().messages[0], candidate().messages[0]] },
    { ...candidate(), messages: [{ ...candidate().messages[0], meta: { createdAt: 20, tools: [{ callId: 'bad' }] } }] },
  ];
  for (const bad of invalid) {
    assert.throws(() => conversations.importThreads({ projectId: 'project', conversations: [candidate('valid'), bad as Candidate] }, 100));
    assert.deepEqual(conversations.snapshot(), before);
    assert.equal(readFileSync(path, 'utf8'), disk);
  }
  assert.throws(() => conversations.importThreads({ projectId: '', conversations: [candidate()] }, 100));
  assert.throws(() => conversations.importThreads({ projectId: 'project', conversations: [candidate()] }, NaN));
  assert.deepEqual(changes, []);
});

test('an atomic write failure preserves all existing data and remains safely retryable', (t) => {
  const path = fixture(t);
  existingThread();
  const before = conversations.snapshot();
  const disk = readFileSync(path, 'utf8');
  const changes: conversations.ConversationChange[] = [];
  t.after(conversations.subscribe((change) => changes.push(change)));
  const failure = t.mock.method(fs, 'renameSync', () => { throw new Error('Injected storage failure'); });
  assert.throws(() => conversations.importThreads({ projectId: 'project', conversations: [candidate()] }, 100), /Injected storage failure/);
  assert.deepEqual(conversations.snapshot(), before);
  assert.equal(readFileSync(path, 'utf8'), disk);
  assert.deepEqual(changes, []);
  failure.mock.restore();
  assert.equal(conversations.importThreads({ projectId: 'project', conversations: [candidate()] }, 100).imported.length, 1);
});

test('capacity overflow refuses the whole import instead of evicting existing unpinned chats', (t) => {
  const path = fixture(t);
  conversations.save({ threads: Array.from({ length: 199 }, (_, index) => ({ id: `existing-${index}`, title: 'Keep me', createdAt: index })) });
  const before = conversations.snapshot();
  const disk = readFileSync(path, 'utf8');
  assert.throws(() => conversations.importThreads({ projectId: 'project', conversations: [candidate('one'), candidate('two')] }, 100), /capacity/);
  assert.deepEqual(conversations.snapshot(), before);
  assert.equal(readFileSync(path, 'utf8'), disk);
  const success = conversations.importThreads({ projectId: 'project', conversations: [candidate('one')] }, 100);
  assert.equal(success.imported.length, 1);
  assert.equal(conversations.snapshot().threads.length, 200);
  assert.equal(conversations.importThreads({ projectId: 'project', conversations: [candidate('one')] }, 101).skipped, 1);
  assert.equal(conversations.snapshot().threads.filter((thread) => thread.id.startsWith('existing-')).length, 199);
});

test('malformed unsupported and overfull disk stores fail closed without startup recovery overwriting them', (t) => {
  const path = fixture(t);
  const cases = [
    '{"version":2,',
    JSON.stringify({ version: 99, threads: [] }),
    JSON.stringify({ version: 2, threads: [{ id: 'bad', title: '', createdAt: 1 }] }),
    JSON.stringify({ version: 2, threads: [1, 2].map(() => ({ id: 'duplicate', title: 'Do not replace', createdAt: 1 })) }),
    JSON.stringify({ version: 2, threads: Array.from({ length: 201 }, (_, index) => ({ id: `old-${index}`, title: 'Do not trim', createdAt: index })) }),
  ];
  for (const disk of cases) {
    writeFileSync(path, disk);
    conversations.useStorePath(path);
    assert.throws(() => conversations.importThreads({ projectId: 'project', conversations: [candidate()] }, 100), /Cannot import|capacity/);
    assert.equal(readFileSync(path, 'utf8'), disk);
  }
});

test('legacy import migration is included in the single append write and preserves provenance and drafts', (t) => {
  const path = fixture(t);
  const origin = { source: 'codex', format: 'codex-rollout', externalId: 'old-import', importedAt: 50 };
  writeFileSync(path, JSON.stringify({ version: 1, threads: [{ id: 'legacy', title: 'Legacy', createdAt: 1, importedFrom: origin }],
    activeThreadId: 'legacy', pinned: [], drafts: { legacy: { text: 'Keep draft', attachments: [] } } }));
  const imported = conversations.importThreads({ projectId: 'project', conversations: [candidate()] }, 100);
  assert.equal(imported.imported.length, 1);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.activeThreadId, 'legacy');
  assert.deepEqual(saved.threads.find((thread: conversations.ConversationThread) => thread.id === 'legacy').importedFrom, origin);
  assert.equal(saved.drafts.legacy.text, 'Keep draft');
});

test('a warm cache cannot overwrite a valid conversation store edit made by another process', (t) => {
  const path = fixture(t);
  existingThread();
  const before = conversations.snapshot();
  const edited = structuredClone(before);
  edited.threads[0].title = 'New title from another writer';
  edited.revision++;
  const disk = JSON.stringify(edited);
  writeFileSync(path, disk);
  assert.throws(() => conversations.importThreads({ projectId: 'project', conversations: [candidate()] }, 100), /changed on disk/);
  assert.equal(readFileSync(path, 'utf8'), disk);
  assert.deepEqual(conversations.snapshot(), before, 'rejected transactions do not change the warm cache');
  conversations.useStorePath(path);
  assert.equal(conversations.importThreads({ projectId: 'project', conversations: [candidate()] }, 100).imported.length, 1);
  assert.equal(conversations.snapshot().threads.find((thread) => thread.id === 'existing')?.title, 'New title from another writer');
});

test('imported assistant messages never infer their duration from a long-running conversation', (t) => {
  fixture(t);
  const chat = candidate();
  chat.updatedAt = chat.createdAt + 30 * 24 * 60 * 60 * 1000;
  chat.messages.push({ id: 'known-timing', role: 'assistant', content: 'A measured reply',
    meta: { createdAt: 50, firstTokenAt: 55, finishedAt: 70 } });
  const imported = conversations.importThreads({ projectId: 'project', conversations: [chat] }, chat.updatedAt).imported[0];
  const unknownTiming = imported.messages[1].meta;
  assert.equal(unknownTiming.finishedAt, unknownTiming.createdAt, 'unknown duration is zero, not the remaining month of conversation history');
  assert.equal(unknownTiming.firstTokenAt, undefined);
  assert.equal(imported.updatedAt, chat.updatedAt, 'the actual conversation timestamp is preserved');
  assert.equal(imported.messages[2].meta.firstTokenAt, 55);
  assert.equal(imported.messages[2].meta.finishedAt, 70, 'explicit historical timing remains intact');
});

test('OpenCode provenance survives reloads and legacy checkpoints without inheriting source access or model configuration', (t) => {
  const path = fixture(t);
  const source = { ...candidate('ses_opencode'), source: 'opencode' as const, format: 'opencode-export' as const,
    providerId: 'external-provider', modelId: 'external-model', directory: '/external/workspace', accessMode: 'full' };
  const imported = conversations.importThreads({ projectId: 'chosen-project', conversations: [source] }, 100).imported[0];
  const provenance = { source: 'opencode', format: 'opencode-export', externalId: 'ses_opencode', importedAt: 100 };
  assert.deepEqual(imported.importedFrom, provenance);
  assert.equal(imported.providerId, undefined);
  assert.equal(imported.modelId, undefined);
  assert.equal(imported.directory, null);
  assert.equal(imported.accessMode, 'ask');
  conversations.useStorePath(path);
  const legacy = conversations.load();
  assert.deepEqual(legacy.threads[0].importedFrom, provenance);
  delete legacy.threads[0].importedFrom;
  legacy.threads[0].title = 'Edited OpenCode import';
  conversations.save(legacy);
  assert.deepEqual(conversations.snapshot().threads[0].importedFrom, provenance);
  assert.equal(conversations.importThreads({ projectId: 'another-project', conversations: [source] }, 200).skipped, 1);
});
