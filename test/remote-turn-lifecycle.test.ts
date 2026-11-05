import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Message } from '../src/api/types';
import type { RemoteDesktopTurnsSnapshot } from '../src/api/remoteDesktopTurns';
import { ActiveTurns } from '../src/main/activeTurns';
import * as conversations from '../src/main/conversations';
import * as transcripts from '../src/main/transcripts';
import { RemoteDesktopTurns } from '../src/main/remote/desktopTurns';
import { runRemoteTurn, type RemoteTurnDependencies, type RemoteTurnSink } from '../src/main/remote/runTurn';
import { inspectRemoteTurnControl } from '../src/main/remote/turnControl';
import { reserveRemoteTurnStart, type RemoteTurnStartCommand } from '../src/main/remote/turnStart';
import type { PublicDeviceRecord } from '../src/main/remote/pairingStore';
import { RemoteProtocolError } from '../src/main/remote/protocol';

const device: PublicDeviceRecord = {
  id: 'phone-1', name: 'Phone', clientVersion: 'test', capabilities: ['chat', 'approvals'],
  maxAccess: 'ask', createdAt: 1, lastSeenAt: null, revokedAt: null,
};
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');

function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-lifecycle-'));
  const previousStore = conversations.location();
  const previousTranscripts = transcripts.location();
  conversations.useStorePath(join(root, 'conversations.json'));
  transcripts.useRoot(join(root, 'transcripts'));
  t.after(() => {
    conversations.useStorePath(previousStore);
    transcripts.useRoot(previousTranscripts);
    rmSync(root, { recursive: true, force: true });
  });
  conversations.createThread({ id: 'thread-1', projectId: 'inbox', title: 'Phone', createdAt: 1, directory: '/project' }, 0);
  const activeTurns = new ActiveTurns();
  const snapshots: RemoteDesktopTurnsSnapshot[] = [];
  const desktopTurns = new RemoteDesktopTurns((snapshot) => snapshots.push(snapshot));
  const sinks = new Map<string, RemoteTurnSink>();
  const events: Array<{ kind: string; payload: unknown }> = [];
  const dependencies: RemoteTurnDependencies = {
    activeTurns, desktopTurns, sinks,
    stream: async () => {},
    flush: (sink) => {
      if (!sink.pendingDelta) return;
      const updated = conversations.appendAssistantDelta(sink.threadId, sink.responseMessageId, sink.pendingDelta, Date.now(), sink.revision);
      sink.revision = updated.revision;
      sink.pendingDelta = '';
    },
    emit: (_sink, kind, payload) => events.push({ kind, payload }),
    threadChanged: () => {},
  };
  const thread = () => conversations.snapshot().threads[0];
  const start = (suffix: string) => {
    const command: RemoteTurnStartCommand = {
      protocolVersion: 1, workspaceId: 'workspace-1', projectId: 'project-1', commandId: `command-${suffix}`,
      expectedThreadRevision: String(thread().revision), kind: 'turn.start',
      payload: {
        threadId: 'thread-1', requestId: `run-${suffix}`, userMessageId: `user-${suffix}`,
        responseMessageId: `response-${suffix}`, content: `Question ${suffix}`,
        model: { providerId: 'source', modelId: 'model' }, attachmentIds: [], accessMode: 'ask',
      },
    };
    const reservation = reserveRemoteTurnStart(device, command, {
      activeTurns,
      resolveProject: () => ({ id: 'project-1', name: 'Project', root: '/project' }),
      loadThread: thread,
      resolveModel: () => ({ name: 'Source' }),
    });
    let initialized = false;
    const completed = runRemoteTurn(device, command, reservation, {
      id: digest(`effect-${suffix}`), payloadHash: digest(JSON.stringify(command)), kind: 'turn.start', appliedAt: Date.now(),
    }, { resolve: () => { initialized = true; }, reject: () => {} }, dependencies);
    assert.equal(initialized, true);
    return completed;
  };
  return { ...dependencies, dependencies, snapshots, events, thread, start };
}

test('completed phone follow-up publishes its run before streaming and resumes hidden history once', async (t) => {
  const h = harness(t);
  let expanded: Message[] = [];
  let requests = 0;
  h.dependencies.stream = async (request) => {
    requests += 1;
    const run = h.desktopTurns.snapshot().turns[0];
    assert.equal(run.runId, request.requestId, 'desktop registration precedes the first provider callback');
    assert.equal(run.responseMessageId, request.responseMessageId);
    assert.notEqual(run.runId, run.responseMessageId, 'phone request IDs are not assistant aliases');
    assert.equal(h.activeTurns.runFor('thread-1'), request.requestId);
    assert.ok(!request.messages.some((message) => message.id === request.responseMessageId));
    if (requests === 1) {
      assert.deepEqual(request.messages.map((message) => message.id), ['user-one']);
      expanded = [request.messages[0],
        { id: 'internal-call', role: 'assistant', content: '', toolCalls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { id: 'internal-result', role: 'tool', toolCallId: 'call', content: 'Hidden file contents' },
        { id: 'internal-answer', role: 'assistant', content: 'First answer' }];
      transcripts.remember('thread-1', expanded, ['user-one', 'response-one'], [['response-one', 'First answer']]);
    } else {
      assert.deepEqual(request.messages.map((message) => message.id), ['user-one', 'response-one', 'user-two']);
      assert.deepEqual(transcripts.resume('thread-1', request.messages), [...expanded, request.messages[2]]);
    }
    h.sinks.get(request.requestId!)!.pendingDelta = requests === 1 ? 'First answer' : 'Second answer';
  };
  await h.start('one');
  assert.deepEqual(h.desktopTurns.snapshot().turns, []);
  assert.equal(h.activeTurns.runFor('thread-1'), null);
  await h.start('two');
  assert.equal(requests, 2);
  assert.deepEqual(h.thread().messages.map((message) => message.id), ['user-one', 'response-one', 'user-two', 'response-two']);
  assert.deepEqual(h.thread().messages.filter((message) => message.role === 'assistant').map((message) => message.content), ['First answer', 'Second answer']);
  assert.ok(h.thread().messages.filter((message) => message.role === 'assistant').every((message) => message.meta.finishedAt !== undefined));
  assert.deepEqual(h.snapshots.map((snapshot) => [snapshot.revision, snapshot.turns.length]), [[1, 1], [2, 0], [3, 1], [4, 0]]);
  assert.equal(h.snapshots[3].finished?.runId, 'run-two');
  assert.equal(h.sinks.size, 0);
});

test('historic attachments survive phone continuation and transcript resume without duplicating them', async (t) => {
  const h = harness(t);
  let stored = conversations.appendUserMessage('thread-1', {
    id: 'attached-user', content: 'Read this', createdAt: 2,
    attachments: [{ id: 'file', name: 'note.txt', size: 11, content: 'HELLO WORLD' }],
  }, h.thread().revision);
  stored = conversations.beginAssistantMessage('thread-1', { id: 'attached-answer', createdAt: 3 }, stored.revision);
  stored = conversations.appendAssistantDelta('thread-1', 'attached-answer', 'Read it', 4, stored.revision);
  conversations.finishAssistantMessage('thread-1', 'attached-answer', 5, stored.revision);
  const visible: Message[] = [
    { id: 'attached-user', role: 'user', content: 'Read this\n\n<file name="note.txt">\nHELLO WORLD\n</file>' },
    { id: 'attached-answer', role: 'assistant', content: 'Read it' },
  ];
  transcripts.remember('thread-1', visible, visible.map((message) => message.id));
  h.dependencies.stream = async (request) => {
    assert.deepEqual(request.messages.slice(0, 2), visible, 'cold fallback retains attachment contents too');
    const resumed = transcripts.resume('thread-1', request.messages)!;
    assert.deepEqual(resumed, [...visible, request.messages[2]]);
    assert.equal(resumed.map((message) => message.content).join('\n').split('HELLO WORLD').length - 1, 1);
  };
  await h.start('phone');
});

test('cancelled phone work retains partial text and clears both ownership views before another turn', async (t) => {
  const h = harness(t);
  let release!: () => void;
  h.dependencies.stream = async (request) => {
    h.sinks.get(request.requestId!)!.pendingDelta = 'Partial response';
    await new Promise<void>((resolve) => { release = resolve; });
  };
  const completion = h.start('cancel');
  const observed = h.desktopTurns.snapshot();
  observed.turns[0].runId = 'corrupted-client-copy';
  assert.equal(h.desktopTurns.snapshot().turns[0].runId, 'run-cancel');
  h.sinks.get('run-cancel')!.cancellationRequested = true;
  release();
  await completion;
  assert.equal(h.thread().messages[1].content, 'Partial response');
  assert.equal((h.events.at(-1)!.payload as { finishReason: string }).finishReason, 'cancelled');
  assert.equal(h.activeTurns.list().length, 0);
  assert.equal(h.desktopTurns.snapshot().turns.length, 0);
  h.dependencies.stream = async () => {};
  await h.start('after-cancel');
  const revision = h.desktopTurns.snapshot().revision;
  h.desktopTurns.finish('run-cancel', false, Date.now());
  assert.equal(h.desktopTurns.snapshot().revision, revision, 'late cleanup does not emit a false finish');
});

test('provider failure persists a failed assistant and releases remote lifetime', async (t) => {
  const h = harness(t);
  h.dependencies.stream = async () => { throw new Error('synthetic provider failure'); };
  await h.start('failure');
  assert.equal(h.thread().messages[1].meta.failed, true);
  assert.ok(h.thread().messages[1].meta.finishedAt);
  assert.equal(h.events.at(-1)?.kind, 'turn.failed');
  assert.equal(h.snapshots.at(-1)?.finished?.failed, true);
  assert.equal(h.activeTurns.list().length, 0);
  assert.equal(h.sinks.size, 0);
});

test('phone controls resolve desktop turn scope without a remote lease and retain ownership guards', () => {
  const active = new ActiveTurns();
  const desktop = active.begin('thread', 'desktop-run');
  const dependencies = { activeTurn: (id: string) => active.recordForRun(id), projectForThread: () => 'project' as string | null };
  for (const kind of ['turn.cancel', 'turn.steer', 'approval.resolve'] as const) {
    const command = {
      protocolVersion: 1 as const, workspaceId: 'workspace', projectId: 'project', commandId: kind, kind,
      payload: { requestId: 'desktop-run', note: 'Continue with tests', now: true, approvalId: 'approval', approved: false },
    };
    assert.equal(inspectRemoteTurnControl(device, command, dependencies), desktop);
    assert.equal(inspectRemoteTurnControl(device, { ...command, projectId: 'another-project' }, dependencies), null);
    dependencies.projectForThread = () => null;
    assert.equal(inspectRemoteTurnControl(device, command, dependencies), null, 'deleted/unshared threads are inaccessible');
    dependencies.projectForThread = () => 'project';
  }
  active.finish('thread', 'desktop-run');
  const phone = active.begin('thread', 'phone-run', { owner: { kind: 'remote', deviceId: device.id }, projectId: 'project' });
  const command = {
    protocolVersion: 1 as const, workspaceId: 'workspace', projectId: 'project', commandId: 'cancel-phone',
    kind: 'turn.cancel' as const, payload: { requestId: 'phone-run' },
  };
  assert.equal(inspectRemoteTurnControl(device, command, dependencies), phone);
  assert.throws(() => inspectRemoteTurnControl({ id: 'other-phone' }, command, dependencies),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'TURN_OWNERSHIP');
  dependencies.projectForThread = () => 'moved';
  assert.equal(inspectRemoteTurnControl(device, { ...command, projectId: 'moved' }, dependencies), null, 'moving a thread cannot move its accepted turn lease');
  active.finish('thread', 'phone-run');
  assert.equal(inspectRemoteTurnControl(device, command, dependencies), null);
});
