import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import * as conversations from '../src/main/conversations';

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-conversation-repository-'));
  const path = join(root, 'conversations.json');
  const previous = conversations.location();
  conversations.useStorePath(path);
  t.after(() => {
    conversations.useStorePath(previous);
    rmSync(root, { recursive: true, force: true });
  });
  return path;
}

test('v1 files migrate to durable v2 while the renderer compatibility API stays v1', (t) => {
  const path = fixture(t);
  writeFileSync(path, JSON.stringify({
    version: 1,
    threads: [{
      id: 'thread-one',
      title: 'Legacy thread',
      projectId: 'inbox',
      createdAt: 10,
      directory: '/private/project',
      messages: [{ id: 'user-one', role: 'user', content: 'hello' }],
    }],
    activeThreadId: 'thread-one',
    pinned: [],
    drafts: { 'thread-one': { text: 'unfinished', attachments: [] } },
  }));

  const legacy = conversations.load();
  assert.equal(legacy.version, 1);
  assert.equal(legacy.threads[0].title, 'Legacy thread');
  assert.equal(legacy.drafts['thread-one'].text, 'unfinished');

  const authoritative = conversations.snapshot();
  assert.equal(authoritative.version, 2);
  assert.equal(authoritative.revision, 1);
  assert.equal(authoritative.threads[0].revision, 1);
  assert.equal(authoritative.threads[0].messages[0].meta.createdAt, 10);

  const disk = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(disk.version, 2);
  assert.equal(disk.revision, 1);
  assert.equal(disk.threads[0].revision, 1);
});

test('typed operations advance store and thread revisions and reject stale writers', (t) => {
  fixture(t);
  const changes: conversations.ConversationChange[] = [];
  const unsubscribe = conversations.subscribe((change) => changes.push(change));
  t.after(unsubscribe);

  let thread = conversations.createThread({
    id: 'thread',
    projectId: 'project',
    title: 'A thread',
    createdAt: 100,
    providerId: 'provider',
    modelId: 'model',
    directory: '/host/private/project',
    accessMode: 'ask',
  }, 0);
  assert.equal(thread.revision, 1);
  assert.equal(conversations.snapshot().revision, 1);
  assert.throws(
    () => conversations.createThread({ id: 'stale', projectId: 'project', createdAt: 101 }, 0),
    (error: unknown) => error instanceof conversations.RevisionConflictError && error.scope === 'store'
  );

  thread = conversations.appendUserMessage('thread', {
    id: 'user',
    content: 'Please inspect this.',
    createdAt: 110,
    attachments: [{
      id: 'attachment',
      name: '/home/person/secrets/request.txt',
      size: 12,
      content: 'private attachment bytes',
      assetId: 'asset-input',
    }],
  }, thread.revision);
  assert.equal(thread.revision, 2);

  thread = conversations.beginAssistantMessage('thread', {
    id: 'assistant',
    createdAt: 111,
    modelId: 'model',
    sourceName: 'Local source',
  }, thread.revision);
  assert.equal(thread.revision, 3);

  thread = conversations.appendAssistantDelta('thread', 'assistant', 'Working.', 112, thread.revision);
  assert.equal(thread.messages.at(-1)?.content, 'Working.');
  assert.equal(thread.messages.at(-1)?.meta.firstTokenAt, 112);

  thread = conversations.upsertToolActivity('thread', 'assistant', {
    callId: 'provider-call',
    activityId: 'activity-one',
    approvalId: 'approval-one',
    requestId: 'assistant',
    contentOffset: 8,
    serverId: 'antimatter',
    serverName: 'Antimatter tools',
    toolName: 'write_file',
    tier: 'write',
    args: '{"path":"/host/private/project/file.txt","token":"secret"}',
    result: 'wrote /host/private/project/file.txt through https://provider.invalid/v1',
    status: 'pending',
    awaitingApproval: true,
    caution: 'provider https://provider.invalid/v1',
    preview: {
      kind: 'image',
      title: 'Result',
      target: '/host/private/project/result.png',
      workspace: '/host/private/project',
      assetId: 'asset-preview',
    },
  }, 113, thread.revision);
  const toolRevision = thread.revision;

  thread = conversations.upsertToolActivity('thread', 'assistant', {
    callId: 'provider-call',
    activityId: 'activity-one',
    requestId: 'assistant',
    serverName: 'Antimatter tools',
    toolName: 'write_file',
    tier: 'write',
    status: 'done',
    result: 'done',
  }, 114, thread.revision);
  assert.equal(thread.messages.at(-1)?.meta.tools?.length, 1);
  assert.equal(thread.messages.at(-1)?.meta.tools?.[0].status, 'done');

  assert.throws(
    () => conversations.renameThread('thread', 'stale rename', toolRevision),
    (error: unknown) => error instanceof conversations.RevisionConflictError && error.scope === 'thread'
  );

  thread = conversations.finishAssistantMessage('thread', 'assistant', 120, thread.revision);
  assert.equal(thread.messages.at(-1)?.meta.finishedAt, 120);
  assert.equal(thread.messages.at(-1)?.meta.failed, false);
  assert.deepEqual(changes.map((change) => change.kind), [
    'create',
    'append-user',
    'begin-assistant',
    'append-delta',
    'upsert-tool',
    'upsert-tool',
    'finish',
  ]);
  assert.deepEqual(changes.map((change) => change.revision), [1, 2, 3, 4, 5, 6, 7]);
});

test('public-channel identity projection omits private content and cannot mutate stored chats', (t) => {
  fixture(t);
  conversations.save({
    threads: [{ id: 'public-participant', title: 'Shared work', createdAt: 1,
      directory: '/project', providerId: 'private-provider', accessMode: 'full',
      messages: [{ id: 'secret', role: 'user', content: 'private transcript',
        attachments: [{ id: 'a', name: 'secret.txt', size: 12, content: 'secret bytes' }],
        meta: { createdAt: 1 } }] }],
    drafts: { 'public-participant': { text: 'private draft', attachments: [] } },
  });
  const identity = conversations.chatMetadata();
  assert.deepEqual(identity, [{ id: 'public-participant', title: 'Shared work', directory: '/project' }]);
  identity[0].title = 'Changed outside the store';
  assert.equal(conversations.snapshot().threads[0].title, 'Shared work');
  assert.equal(conversations.snapshot().threads[0].messages[0].content, 'private transcript');
});

test('failure, pin, rename and delete are atomic revisioned mutations', (t) => {
  const path = fixture(t);
  let thread = conversations.createThread({ id: 'thread', projectId: 'inbox', createdAt: 1 }, 0);
  thread = conversations.beginAssistantMessage('thread', { id: 'answer', createdAt: 2 }, thread.revision);
  thread = conversations.appendAssistantDelta('thread', 'answer', 'Partial', 3, thread.revision);
  thread = conversations.failAssistantMessage('thread', 'answer', {
    finishedAt: 4,
    userMessage: 'The source became unavailable.',
  }, thread.revision);
  assert.equal(thread.messages[0].content, 'Partial');
  assert.equal(thread.messages[0].meta.failed, true);
  assert.deepEqual(thread.messages[0].meta.operationalError, {
    kind: 'operational-error', message: 'The source became unavailable.', at: 4,
  });
  conversations.useStorePath(path);
  assert.deepEqual(conversations.snapshot().threads[0].messages[0].meta.operationalError,
    thread.messages[0].meta.operationalError, 'diagnostic detail survives a process reload without entering prose');
  assert.equal(conversations.remoteProjection().threads[0].messages[0].content, 'Partial');
  assert.equal('operationalError' in conversations.remoteProjection().threads[0].messages[0], false,
    'private diagnostics do not leak into the mobile message DTO');

  thread = conversations.renameThread('thread', 'Renamed', thread.revision);
  thread = conversations.setThreadPinned('thread', 50, thread.revision);
  assert.equal(thread.title, 'Renamed');
  assert.equal(thread.pinnedAt, 50);

  const stale = thread.revision - 1;
  assert.throws(() => conversations.deleteThread('thread', stale), conversations.RevisionConflictError);
  const deleted = conversations.deleteThread('thread', thread.revision);
  assert.equal(deleted.threads.length, 0);
  assert.equal(deleted.revision, 7);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).threads.length, 0);
});

test('remote effect markers commit atomically, survive renderer saves, and outlive deletion', (t) => {
  const path = fixture(t);
  const createEffect: conversations.RemoteConversationEffect = {
    id: 'a'.repeat(43),
    payloadHash: 'A'.repeat(43),
    kind: 'thread.create',
    appliedAt: 10,
    result: { threadId: 'thread', clientThreadId: 'android-thread' },
  };
  let thread = conversations.createThread({
    id: 'thread',
    projectId: 'inbox',
    title: 'Created once',
    createdAt: 1,
  }, 0, createEffect);
  assert.equal(conversations.hasRemoteEffect(createEffect), true);
  assert.deepEqual(conversations.remoteEffect(createEffect)?.result, createEffect.result);
  assert.equal((conversations.load() as Record<string, unknown>).remoteEffects, undefined);

  conversations.save(conversations.load());
  assert.equal(conversations.hasRemoteEffect(createEffect), true, 'compatibility saves must preserve hidden markers');
  conversations.useStorePath(path);
  assert.deepEqual(conversations.remoteEffect(createEffect)?.result, createEffect.result);

  const renameEffect: conversations.RemoteConversationEffect = {
    id: 'b'.repeat(43),
    payloadHash: 'B'.repeat(43),
    kind: 'thread.rename',
    appliedAt: 11,
  };
  thread = conversations.renameThread(thread.id, 'Renamed once', thread.revision, renameEffect);
  const afterRename = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(afterRename.threads[0].title, 'Renamed once');
  assert.equal(afterRename.remoteEffects[renameEffect.id].payloadHash, renameEffect.payloadHash);

  const deleteEffect: conversations.RemoteConversationEffect = {
    id: 'c'.repeat(43),
    payloadHash: 'C'.repeat(43),
    kind: 'thread.delete',
    appliedAt: 12,
  };
  conversations.deleteThread(thread.id, thread.revision, deleteEffect);
  assert.equal(conversations.snapshot().threads.length, 0);
  assert.equal(conversations.hasRemoteEffect(deleteEffect), true, 'delete reconciliation cannot depend on a live thread');
  assert.throws(
    () => conversations.hasRemoteEffect({ ...deleteEffect, payloadHash: 'D'.repeat(43) }),
    /different content/i
  );
});

test('thread model changes persist both routing identities behind the thread revision', (t) => {
  fixture(t);
  let thread = conversations.createThread({
    id: 'thread',
    projectId: 'inbox',
    createdAt: 1,
    providerId: 'old-provider',
    modelId: 'old-model',
  }, 0);

  const staleRevision = thread.revision;
  thread = conversations.setThreadModel(
    thread.id,
    'new-provider',
    'org/nemotron-super',
    thread.revision
  );

  assert.equal(thread.providerId, 'new-provider');
  assert.equal(thread.modelId, 'org/nemotron-super');
  assert.equal(conversations.remoteProjection(thread.id).threads[0].providerId, 'new-provider');
  assert.equal(conversations.remoteProjection(thread.id).threads[0].modelId, 'org/nemotron-super');
  assert.throws(
    () => conversations.setThreadModel(thread.id, 'third-provider', 'third-model', staleRevision),
    conversations.RevisionConflictError
  );
});

test('remote projection is an allowlist without host paths, inline bytes, raw tool data or URLs', (t) => {
  fixture(t);
  let thread = conversations.createThread({
    id: 'thread',
    projectId: 'project',
    createdAt: 1,
    directory: '/host/private/project',
    accessMode: 'full',
  }, 0);
  thread = conversations.appendUserMessage('thread', {
    id: 'user',
    content: 'ordinary visible text',
    createdAt: 2,
    attachments: [{
      id: 'attachment',
      name: 'C:\\Users\\person\\secret.txt',
      size: 7,
      content: 'INLINE-SECRET',
      assetId: 'asset-input',
    }],
  }, thread.revision);
  thread = conversations.beginAssistantMessage('thread', { id: 'assistant', createdAt: 3 }, thread.revision);
  conversations.upsertToolActivity('thread', 'assistant', {
    callId: 'call',
    activityId: 'activity',
    requestId: 'assistant',
    serverName: 'Tools',
    toolName: 'preview_image',
    tier: 'read',
    args: 'INLINE-ARGS /host/private/project',
    result: 'INLINE-RESULT https://provider.invalid/v1',
    caution: 'https://provider.invalid/v1',
    status: 'done',
    preview: {
      kind: 'image',
      title: 'Preview',
      target: '/host/private/project/result.png',
      workspace: '/host/private/project',
      assetId: 'asset-preview',
    },
  }, 4, thread.revision);

  const projected = conversations.remoteProjection('thread');
  const serialized = JSON.stringify(projected);
  assert.equal(projected.threads[0].messages[0].attachments[0].name, 'secret.txt');
  assert.equal(projected.threads[0].messages[0].attachments[0].assetId, 'asset-input');
  assert.deepEqual(projected.threads[0].messages[1].tools[0].preview, {
    kind: 'image',
    title: 'Preview',
    assetId: 'asset-preview',
  });
  assert.doesNotMatch(serialized, /INLINE-SECRET|INLINE-ARGS|INLINE-RESULT/);
  assert.doesNotMatch(serialized, /host\/private|provider\.invalid|C:\\\\Users/);
  assert.equal('directory' in projected.threads[0], false);
  assert.equal('drafts' in projected, false);
  assert.equal('args' in projected.threads[0].messages[1].tools[0], false);
  assert.equal('result' in projected.threads[0].messages[1].tools[0], false);
});

test('compatibility saves keep stable revisions for unchanged threads and clone returned state', (t) => {
  fixture(t);
  const first = conversations.save({
    threads: [{ id: 'thread', title: 'Thread', projectId: 'inbox', createdAt: 1, messages: [] }],
    activeThreadId: 'thread',
    pinned: [],
    drafts: {},
  });
  assert.equal(first.version, 1);
  const initial = conversations.snapshot();
  assert.equal(initial.revision, 1);
  assert.equal(initial.threads[0].revision, 1);

  conversations.save(first);
  const unchanged = conversations.snapshot();
  assert.equal(unchanged.revision, 1);
  assert.equal(unchanged.threads[0].revision, 1);

  first.threads[0].title = 'Mutated caller copy';
  assert.equal(conversations.snapshot().threads[0].title, 'Thread');

  conversations.save({ ...first, threads: [{ ...first.threads[0], title: 'Saved change' }] });
  const changed = conversations.snapshot();
  assert.equal(changed.revision, 2);
  assert.equal(changed.threads[0].revision, 2);
  assert.equal(changed.threads[0].title, 'Saved change');

  const conflicts: conversations.ConversationChange[] = [];
  const unsubscribe = conversations.subscribe((change) => {
    if (change.kind === 'conflict') conflicts.push(change);
  });
  t.after(unsubscribe);
  conversations.save({
    ...first,
    threads: [{ ...first.threads[0], revision: 1, title: 'Stale overwrite' }],
  });
  const preserved = conversations.snapshot();
  assert.equal(preserved.revision, 2);
  assert.equal(preserved.threads[0].revision, 2);
  assert.equal(preserved.threads[0].title, 'Saved change');
  assert.deepEqual(conflicts, [{
    kind: 'conflict',
    revision: 2,
    threadId: 'thread',
    threadRevision: 2,
    expectedRevision: 1,
  }]);
});

test('a stale renderer checkpoint cannot erase a thread created by another client', (t) => {
  fixture(t);
  const rendererBase = conversations.save({
    threads: [{ id: 'desktop', title: 'Desktop', projectId: 'project', createdAt: 1, messages: [] }],
    activeThreadId: 'desktop',
    pinned: [],
    drafts: {},
  });
  const hostRevision = conversations.snapshot().revision;
  conversations.createThread({
    id: 'phone',
    projectId: 'project',
    title: 'Created from phone',
    createdAt: 2,
  }, hostRevision);

  const conflicts: conversations.ConversationChange[] = [];
  const unsubscribe = conversations.subscribe((change) => {
    if (change.kind === 'conflict') conflicts.push(change);
  });
  t.after(unsubscribe);

  const saved = conversations.save({
    ...rendererBase,
    threads: rendererBase.threads.map((thread) => ({ ...thread, title: 'Edited on desktop' })),
  });
  const result = conversations.snapshot();

  assert.deepEqual(result.threads.map((thread) => thread.id).sort(), ['desktop', 'phone']);
  assert.equal(result.threads.find((thread) => thread.id === 'desktop')?.title, 'Edited on desktop');
  assert.equal(result.threads.find((thread) => thread.id === 'phone')?.title, 'Created from phone');
  assert.equal(saved.revision, result.revision);
  assert.ok(conflicts.some((change) =>
    change.threadId === undefined && change.expectedRevision === rendererBase.revision
  ));
});

test('voice input provenance and normalized bounded guidance survive durable renderer checkpoints', (t) => {
  const path = fixture(t);
  const guidance = (id: string, extra: Record<string, unknown> = {}) => ({ id, text: `Spoken ${id}.`, at: 5, contentOffset: 3, status: 'delivered', ...extra });
  conversations.save({
    threads: [{ id: 'voice-thread', title: 'Voice', projectId: 'inbox', createdAt: 1, messages: [
      { id: 'spoken-request', role: 'user', content: 'Please code.', meta: { createdAt: 2, inputSource: 'voice' } },
      { id: 'voice-answer', role: 'assistant', content: 'Working.Done.', meta: { createdAt: 3, inputSource: 'unknown', voiceGuidance: [
        guidance('delivered', { contentOffset: 3.8 }), guidance('queued', { status: 'queued' }), guidance('undelivered', { status: 'undelivered' }),
        guidance('normalized', { at: NaN, contentOffset: -10 }),
        guidance('bad id'), guidance('bad-status', { status: 'approved' }), guidance('empty', { text: '' }), guidance('too-long', { text: 'x'.repeat(4001) }),
      ] } },
      { id: 'bounded-answer', role: 'assistant', content: 'Done.', meta: { createdAt: 4,
        voiceGuidance: Array.from({ length: 300 }, (_, index) => guidance(`bounded-${index}`)) } },
    ] }],
    activeThreadId: 'voice-thread', pinned: [], drafts: {},
  });
  const persisted = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(persisted.threads[0].messages[0].meta.inputSource, 'voice');
  conversations.useStorePath(path); // Drop the in-process cache and exercise actual disk restoration.
  const thread = conversations.snapshot().threads.find((entry) => entry.id === 'voice-thread')!;
  assert.equal(thread.messages[0].meta.inputSource, 'voice');
  assert.equal(thread.messages[1].meta.inputSource, undefined);
  assert.deepEqual(thread.messages[1].meta.voiceGuidance?.map(({ id, status }) => [id, status]), [
    ['delivered', 'delivered'], ['queued', 'queued'], ['undelivered', 'undelivered'], ['normalized', 'delivered'],
  ]);
  assert.equal(thread.messages[1].meta.voiceGuidance?.[0].contentOffset, 3);
  assert.equal(thread.messages[1].meta.voiceGuidance?.[3].contentOffset, 0);
  assert.equal(thread.messages[1].meta.voiceGuidance?.[3].at, 0);
  assert.equal(thread.messages[2].meta.voiceGuidance?.length, 256);
  assert.equal(thread.messages[2].meta.voiceGuidance?.[255].id, 'bounded-255');
  const metadata = new Map(thread.messages.map((message) => [message.id, message.meta.voiceGuidance ?? []]));
  assert.equal(metadata.get('voice-answer')?.filter((entry) => entry.status === 'delivered').length, 2,
    'main history fallback can read acknowledged notes without treating queued speech as delivered');
});
