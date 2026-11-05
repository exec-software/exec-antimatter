import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import * as conversations from '../src/main/conversations';
import { relayDesktopStreamEvent, type DesktopStreamEventDependencies } from '../src/main/remote/desktopStreamEvents';
import { EventJournal } from '../src/main/remote/eventJournal';
import { RemoteLiveTranscript } from '../src/main/remote/liveTranscript';
import { RemoteProjectCatalog } from '../src/main/remote/projects';
import type { JsonValue } from '../src/main/remote/protocol';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-desktop-stream-'));
  const project = join(root, 'project');
  mkdirSync(project);
  const previous = conversations.location();
  conversations.useStorePath(join(root, 'conversations.json'));
  t.after(() => { conversations.useStorePath(previous); rmSync(root, { recursive: true, force: true }); });
  conversations.createThread({ id: 'chat', projectId: 'inbox', directory: project, createdAt: 1 }, 0);
  const catalog = new RemoteProjectCatalog(join(root, 'projects.json'));
  const registered = catalog.ensure(project);
  const live = new RemoteLiveTranscript();
  live.begin('run', 'chat', { id: 'reply', createdAt: 10 });
  const journal = new EventJournal({ workspaceId: 'host' });
  const seen: Array<{ kind: string; body: unknown; scope: { projectId: string; threadId: string } }> = [];
  const state = { consumers: false, active: true, routes: 0, consumerChecks: 0 };
  const deps: DesktopStreamEventDependencies = {
    live,
    hasConsumers: () => { state.consumerChecks++; return state.consumers; },
    activeTurn: () => state.active ? { threadId: 'chat', responseMessageId: 'reply' } : null,
    projectForThread: (thread) => { state.routes++; return catalog.findByRoot(thread.directory!); },
    toolActivity: (data) => ({ callId: String(data.callId), requestId: 'run', serverName: 'Workspace', toolName: 'write_file',
      tier: 'write', status: 'pending', awaitingApproval: true, remoteSummary: 'Write file', args: 'PRIVATE', result: 'PRIVATE' }),
    toolEvent: conversations.remoteTool,
    emit: (kind, body, scope) => { seen.push({ kind, body, scope }); journal.append({ kind, body, scope } as JsonValue); },
  };
  const send = (channel: string, data: Record<string, unknown>) => relayDesktopStreamEvent(channel, data, 'run', deps);
  const snapshot = () => live.project({ id: 'chat', title: 'Chat', projectId: registered.id, createdAt: 1,
    updatedAt: 10, revision: 1, accessMode: 'ask', messages: [] });
  return { root, project, registered, catalog, live, journal, seen, state, send, snapshot };
}

test('text and liveness route using metadata without cloning any conversation snapshot', (t) => {
  const f = fixture(t);
  f.state.consumers = true;
  const clone = t.mock.method(globalThis, 'structuredClone', () => { throw new Error('No whole-workspace clones on the token path'); });
  for (let index = 0; index < 100; index++) {
    f.send('chat:alive', { at: index });
    f.send('chat:stream-data', { content: 'ha' });
  }
  assert.equal(clone.mock.callCount(), 0);
  clone.mock.restore();
  assert.equal(f.seen.length, 200);
  assert.equal(f.snapshot().messages[0].content, 'ha'.repeat(100));
  assert.deepEqual(f.seen[1], { kind: 'text.delta', body: { requestId: 'run', responseMessageId: 'reply', content: 'ha' },
    scope: { projectId: f.registered.id, threadId: 'chat' } });
});

test('disabled/unpaired delivery keeps live text and safe tool state for later enable and reconnect', (t) => {
  const f = fixture(t);
  f.send('chat:stream-data', { content: 'ha' });
  f.send('chat:stream-data', { content: 'ha' });
  f.send('tools:approval-request', { callId: 'approval' });
  assert.equal(f.state.routes, 0);
  assert.equal(f.seen.length, 0);
  f.state.consumers = true;
  const cursor = f.journal.cursor();
  const initial = f.snapshot();
  assert.equal(initial.messages[0].content, 'haha');
  assert.equal(initial.messages[0].tools[0].awaitingApproval, true);
  assert.doesNotMatch(JSON.stringify(initial), /PRIVATE|"args"|"result"/);
  f.send('chat:stream-data', { content: '!' });
  const replay = f.journal.replay(cursor);
  assert.equal(replay.kind, 'events');
  if (replay.kind !== 'events') throw new Error('Expected replay');
  assert.equal(initial.messages[0].content + replay.events.map((entry) => (entry.event as { body: { content: string } }).body.content).join(''), 'haha!');
  f.state.consumers = false;
  f.send('chat:stream-data', { content: ' More while disabled.' });
  f.state.consumers = true;
  assert.equal(f.snapshot().messages[0].content, 'haha! More while disabled.');
});

test('reasoning and unsupported events never query audience, conversations or project paths', (t) => {
  const f = fixture(t);
  f.state.consumers = true;
  const clone = t.mock.method(globalThis, 'structuredClone', () => { throw new Error('Unexpected clone'); });
  for (const channel of ['chat:reasoning', 'chat:metrics', 'voice:guidance', 'chat:steered']) f.send(channel, { content: 'private reasoning' });
  assert.equal(clone.mock.callCount(), 0);
  clone.mock.restore();
  assert.equal(f.state.consumerChecks, 0);
  assert.equal(f.state.routes, 0);
  assert.equal(f.seen.length, 0);
  assert.equal(f.snapshot().messages[0].content, '');
});

test('desktop-originated prefill metrics reach the phone without request fingerprints or prompt data', (t) => {
  const f = fixture(t);
  f.state.consumers = true;
  f.send('chat:metrics', { round: 1, metrics: { phase: 'prefill', requestStartedAt: 1,
    requestDurationMs: 50, promptProgress: { total: 1000, cached: 400, processed: 600, elapsedMs: 40 },
    request: { payloadFingerprint: 'PRIVATE' }, content: 'PRIVATE' } });
  assert.equal(f.seen.length, 1);
  assert.deepEqual(f.seen[0], { kind: 'context.updated', body: { requestId: 'run', inference: {
    round: 1, phase: 'prefill', requestStartedAt: 1, requestDurationMs: 50,
    promptProgress: { total: 1000, cached: 400, processed: 600, elapsedMs: 40 },
  } }, scope: { projectId: f.registered.id, threadId: 'chat' } });
  assert.doesNotMatch(JSON.stringify(f.seen), /PRIVATE|payloadFingerprint/);
});

test('live routing observes moved/deleted threads and unavailable or replaced project directories', (t) => {
  const f = fixture(t);
  f.state.consumers = true;
  f.send('chat:stream-data', { content: 'first' });
  const nextRoot = join(f.root, 'next-project');
  mkdirSync(nextRoot);
  const nextProject = f.catalog.ensure(nextRoot);
  const stored = conversations.load();
  conversations.save({ ...stored, threads: stored.threads.map((thread) => ({ ...thread, directory: nextRoot })) });
  f.send('chat:stream-data', { content: 'second' });
  assert.equal(f.seen[1].scope.projectId, nextProject.id);
  rmSync(nextRoot, { recursive: true });
  f.send('chat:stream-data', { content: 'missing' });
  assert.equal(f.seen.length, 2);
  symlinkSync(f.project, nextRoot, 'dir');
  f.send('chat:stream-data', { content: 'symlink' });
  assert.equal(f.seen.length, 2);
  const current = conversations.snapshot().threads[0];
  conversations.deleteThread(current.id, current.revision);
  f.send('chat:stream-data', { content: 'deleted' });
  assert.equal(f.seen.length, 2);
});

test('settled runs stop routing, while supported live status payloads keep their existing shape', (t) => {
  const f = fixture(t);
  f.state.consumers = true;
  f.send('chat:waiting', { waiting: true });
  f.send('chat:context', { estimatedTokens: 512, contextTokens: 8192, privateNotes: 'PRIVATE' });
  assert.deepEqual(f.seen.map((event) => [event.kind, event.body]), [
    ['turn.liveness', { requestId: 'run', waiting: true }],
    ['context.updated', { requestId: 'run', inputTokens: 512, contextLimit: 8192 }],
  ]);
  f.state.active = false;
  f.live.finish('run', false, 20);
  f.send('chat:stream-data', { content: 'late' });
  assert.equal(f.seen.length, 2);
  assert.equal(f.snapshot().messages[0].content, '');
});
