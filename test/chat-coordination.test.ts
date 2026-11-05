import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalChatWorkspace, ChatCoordinationStore, MAX_CHAT_NOTE_BYTES } from '../src/main/chatCoordination';
import type { ConversationThread } from '../src/main/conversations';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-chat-coordination-'));
  const directory = join(root, 'project');
  const otherDirectory = join(root, 'other-project');
  mkdirSync(directory); mkdirSync(otherDirectory);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const thread = (id: string, selected: string | null = directory): ConversationThread => ({
    id, title: `Chat ${id}`, projectId: 'inbox', createdAt: 1, updatedAt: 1, revision: 1,
    directory: selected, accessMode: 'ask', messages: [],
  });
  const threads = [thread('a'), thread('b'), thread('c', otherDirectory), thread('imported', null)];
  const active = new Map([['a', 'run-a'], ['b', 'run-b']]);
  const changed: string[][] = [];
  const path = join(root, 'private', 'coordination.json');
  const dependencies = { threads: () => threads, activeRun: (id: string) => active.get(id) ?? null,
    onChanged: (ids: string[]) => changed.push(ids) };
  const store = new ChatCoordinationStore(path, dependencies);
  const send = (body = 'Please check the parser.', clientMessageId = 'call-1') =>
    store.send('a', 'b', body, { runId: 'run-a', clientMessageId });
  return { root, directory, otherDirectory, threads, active, path, dependencies, store, changed, send };
}

test('connections are explicit, bidirectional, canonical workspace scoped, and durable', (t) => {
  const f = fixture(t);
  const alias = join(f.root, 'project-alias');
  symlinkSync(f.directory, alias);
  f.threads[1].directory = alias;
  assert.deepEqual(f.store.state('a').peers.map((peer) => [peer.id, peer.connected]), [['b', false]]);
  assert.deepEqual(f.store.connectedPeers('a'), []);
  assert.throws(() => f.send(), /not connected/);
  assert.throws(() => f.store.connect('a', 'c'), /same selected project folder/);
  assert.throws(() => f.store.connect('a', 'imported'), /same selected project folder/);
  assert.throws(() => f.store.connect('a', 'a'), /another chat/);
  const link = f.store.connect('a', 'b');
  assert.equal(f.store.connect('b', 'a').id, link.id);
  assert.equal(f.store.assertConnection('b', 'a').workspace, f.directory);
  link.threadIds[0] = 'forged';
  assert.deepEqual(f.store.assertConnection('a', 'b').threadIds, ['a', 'b']);
  const restarted = new ChatCoordinationStore(f.path, f.dependencies);
  assert.equal(restarted.connectedPeers('b')[0].id, 'a');
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.root, 'private')).mode & 0o777, 0o700);
  assert.ok(f.changed.some((ids) => ids.includes('a') && ids.includes('b')));
});

test('send binds the active source run, freezes provenance, deduplicates retries, and returns copies', (t) => {
  const f = fixture(t);
  f.store.connect('a', 'b');
  assert.throws(() => f.store.send('a', 'b', 'forged', { runId: 'run-b', clientMessageId: 'bad' }), /no longer active/);
  assert.throws(() => f.store.send('imported', 'b', 'forged', { runId: 'run-a', clientMessageId: 'bad' }), /same selected/);
  f.store.assertSource('a', f.directory, 'run-a');
  assert.throws(() => f.store.assertSource('a', f.otherDirectory, 'run-a'), /changed project folders/);
  assert.throws(() => f.store.assertSource('a', f.directory, 'run-b'), /no longer active/);
  const message = f.send();
  assert.equal(f.send().id, message.id);
  assert.throws(() => f.send('Changed body'), /already used/);
  assert.equal(f.store.pendingCount('b'), 1);
  f.threads[0].title = 'Renamed later';
  assert.equal(f.store.state('b').messages[0].sourceTitle, 'Chat a');
  message.body = 'caller mutation';
  const state = f.store.state('b');
  assert.equal(state.messages[0].body, 'Please check the parser.');
  state.peers[0].title = 'caller mutation'; state.messages[0].body = 'changed';
  assert.equal(f.store.state('b').messages[0].body, 'Please check the parser.');
  assert.deepEqual(Object.keys(f.send()).sort(), ['body', 'createdAt', 'id', 'sourceRunId', 'sourceThreadId', 'sourceTitle', 'status', 'targetThreadId', 'targetTitle'].sort());
  f.active.delete('a');
  assert.throws(() => f.send(), /no longer active/);
});

test('FIFO leases survive cancellation and restart, and only a claimed active recipient can acknowledge', (t) => {
  const f = fixture(t);
  f.store.connect('a', 'b');
  const one = f.send('first', 'one'); const two = f.send('second', 'two');
  assert.throws(() => f.store.claim('b', 'run-a'), /no longer active/);
  assert.throws(() => f.store.ack('b', 'run-b', [one.id]), /no longer reserved/);
  assert.deepEqual(f.store.claim('b', 'run-b', { limit: 1 }).map((message) => message.id), [one.id]);
  assert.equal(f.store.state('b').messages[0].status, 'queued');
  f.store.release('run-b');
  assert.equal(f.store.claim('b', 'run-b')[0].id, one.id);
  const restarted = new ChatCoordinationStore(f.path, f.dependencies);
  assert.deepEqual(restarted.claim('b', 'run-b').map((message) => message.id), [one.id, two.id]);
  restarted.ack('b', 'run-b', [one.id]);
  assert.equal(restarted.pendingCount('b'), 1);
  assert.equal(restarted.state('b').messages[0].status, 'delivered');
  assert.ok(restarted.state('b').messages[0].deliveredAt);
  f.active.set('b', 'new-run');
  assert.throws(() => restarted.ack('b', 'run-b', [two.id]), /no longer active/);
  assert.equal(restarted.claim('b', 'new-run')[0].id, two.id);
  restarted.ack('b', 'new-run', [two.id]);
  assert.equal(restarted.pendingCount('b'), 0);
});

test('revocation dismisses queued and leased notes and a new connection cannot reuse old approval', (t) => {
  const f = fixture(t);
  const link = f.store.connect('a', 'b');
  const note = f.send();
  f.store.claim('b', 'run-b');
  f.store.disconnect('b', 'a');
  assert.equal(f.store.state('b').messages[0].status, 'dismissed');
  assert.throws(() => f.store.read('a', 'b'), /not connected/);
  assert.throws(() => f.store.ack('b', 'run-b', [note.id]), /no longer reserved/);
  const reconnected = f.store.connect('a', 'b');
  assert.notEqual(reconnected.id, link.id);
  assert.throws(() => f.store.assertConnection('a', 'b', link.id), /not connected/);
  assert.throws(() => f.store.send('a', 'b', 'stale', { runId: 'run-a', clientMessageId: 'other', expectedLinkId: link.id }), /not connected/);
  assert.deepEqual(f.store.claim('b', 'run-b'), []);
});

test('a moved or deleted chat loses its grant and pending notes without resurrecting on return', (t) => {
  const f = fixture(t);
  f.store.connect('a', 'b'); f.send();
  f.threads[1].directory = f.otherDirectory;
  f.store.reconcile();
  assert.equal(f.store.state('a').messages[0].status, 'dismissed');
  f.threads[1].directory = f.directory;
  assert.equal(f.store.state('a').peers[0].connected, false);
  f.store.connect('a', 'b'); f.send('new', 'new');
  f.threads.splice(1, 1);
  f.store.reconcile();
  assert.equal(f.store.state('a').messages[1].status, 'dismissed');
  assert.throws(() => f.store.state('b'), /no longer available/);
});

test('runtime scope remains frozen when a chosen workspace symlink is retargeted', (t) => {
  const f = fixture(t);
  const alias = join(f.root, 'selected-project');
  symlinkSync(f.directory, alias);
  f.threads[0].directory = alias;
  const captured = canonicalChatWorkspace(alias)!;
  f.store.assertSource('a', captured, 'run-a');
  rmSync(alias); symlinkSync(f.otherDirectory, alias);
  assert.throws(() => f.store.assertSource('a', captured, 'run-a'), /changed project folders/);
});

test('visible transcript pages omit private fields and system messages and bound content and cursors', (t) => {
  const f = fixture(t);
  f.store.connect('a', 'b');
  f.threads[1].messages = [
    { id: 'system', role: 'system', content: 'private system', meta: { createdAt: 1 } },
    { id: 'user', role: 'user', content: 'Visible request', attachments: [{ id: 'attachment', name: 'secret.txt', size: 99, content: 'attachment secret' }], meta: { createdAt: 2 } },
    { id: 'assistant', role: 'assistant', content: 'Visible reply\u0000\u202e', meta: { createdAt: 3, tools: [{ callId: 'call', requestId: 'run', serverName: 'server', toolName: 'read', tier: 'read', status: 'done', args: 'raw arguments', result: 'raw secret result' }] } },
    { id: 'long', role: 'assistant', content: 'x'.repeat(100_000), meta: { createdAt: 4 } },
  ];
  const page = f.store.read('a', 'b', { limit: 1, maxChars: 100 });
  assert.equal(page.messages[0].content.length, 100);
  assert.equal(page.messages[0].truncated, true);
  assert.equal(page.nextBefore, 'long');
  const older = f.store.read('a', 'b', { before: page.nextBefore! });
  assert.deepEqual(older.messages.map((message) => message.id), ['user', 'assistant']);
  assert.equal(older.messages[1].content, 'Visible reply');
  assert.equal(older.nextBefore, null);
  const serialized = JSON.stringify(older);
  for (const secret of ['private system', 'attachment secret', 'secret.txt', 'raw arguments', 'raw secret result', f.directory]) assert.ok(!serialized.includes(secret));
  older.messages[0].content = 'mutated';
  assert.equal(f.threads[1].messages[1].content, 'Visible request');
  assert.throws(() => f.store.read('a', 'b', { before: 'missing' }), /page is no longer available/);
  assert.throws(() => f.store.read('a', 'b', { limit: -1 }), /page size/);
  f.threads[1].messages = Array.from({ length: 50 }, (_, n) => ({ id: `m-${n}`, role: 'assistant' as const, content: 'a'.repeat(5000), meta: { createdAt: n } }));
  const bounded = f.store.read('a', 'b', { limit: 10000, maxChars: 1000000 });
  assert.ok(bounded.messages.length <= 32);
  assert.ok(bounded.messages.reduce((count, message) => count + message.content.length, 0) <= 32768);
});

test('note sizes use UTF-8 bytes, queue bounds reject overflow, and only recipients dismiss', (t) => {
  const f = fixture(t);
  f.store.connect('a', 'b');
  assert.throws(() => f.send('é'.repeat(MAX_CHAT_NOTE_BYTES / 2 + 1)), /8 KiB/);
  assert.throws(() => f.send('   '), /8 KiB/);
  const note = f.send('é'.repeat(MAX_CHAT_NOTE_BYTES / 2));
  assert.throws(() => f.store.dismiss('a', note.id), /received note/);
  f.store.dismiss('b', note.id);
  for (let index = 0; index < 64; index += 1) f.send(`note ${index}`, `call-${index + 2}`);
  assert.equal(f.store.pendingCount('b'), 64);
  assert.throws(() => f.send('overflow', 'overflow'), /64 pending/);
  const claimed = f.store.claim('b', 'run-b', { maxChars: 20 });
  assert.ok(claimed.reduce((total, message) => total + message.body.length, 0) <= 20);
  f.store.disconnect('a', 'b');
  assert.equal(f.store.pendingCount('b'), 0);
});

test('retention evicts only settled notes, keeps the latest 1000, and never exposes private leases', (t) => {
  const f = fixture(t);
  f.store.connect('a', 'b'); f.send();
  const saved = JSON.parse(readFileSync(f.path, 'utf8'));
  saved.messages = Array.from({ length: 1000 }, (_, index) => ({ ...saved.messages[0], id: `note-${index}`, clientMessageId: `occurrence-${index}`, sourceRunId: 'finished-run', status: index === 0 ? 'queued' : 'delivered' }));
  writeFileSync(f.path, JSON.stringify(saved));
  const restarted = new ChatCoordinationStore(f.path, f.dependencies);
  restarted.send('a', 'b', 'latest', { runId: 'run-a', clientMessageId: 'new' });
  const messages = restarted.state('b').messages;
  assert.equal(messages.length, 1000);
  assert.ok(messages.some((message) => message.id === 'note-0'));
  assert.ok(!messages.some((message) => message.id === 'note-1'));
  assert.equal(messages.at(-1)?.body, 'latest');
  restarted.claim('b', 'run-b');
  assert.ok(!JSON.stringify(restarted.state('b')).includes('leaseRunId'));
});

test('retention cannot forget a still-active sender occurrence and allow a duplicate retry', (t) => {
  const f = fixture(t);
  f.store.connect('a', 'b'); f.send();
  const saved = JSON.parse(readFileSync(f.path, 'utf8'));
  saved.messages = Array.from({ length: 1000 }, (_, index) => ({ ...saved.messages[0], id: `note-${index}`, clientMessageId: `occurrence-${index}`, status: 'delivered' }));
  writeFileSync(f.path, JSON.stringify(saved));
  const restarted = new ChatCoordinationStore(f.path, f.dependencies);
  assert.throws(() => restarted.send('a', 'b', 'new', { runId: 'run-a', clientMessageId: 'new' }), /queue is full/);
  assert.equal(restarted.send('a', 'b', 'Please check the parser.', { runId: 'run-a', clientMessageId: 'occurrence-0' }).id, 'note-0');
});

test('corrupt and symlinked stores fail closed without overwriting their contents', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'private'));
  writeFileSync(f.path, '{bad JSON');
  assert.throws(() => new ChatCoordinationStore(f.path, f.dependencies), /left unchanged/);
  assert.equal(readFileSync(f.path, 'utf8'), '{bad JSON');
  rmSync(f.path);
  const external = join(f.root, 'external.json');
  writeFileSync(external, JSON.stringify({ version: 1, links: [], messages: [] }));
  symlinkSync(external, f.path);
  assert.throws(() => new ChatCoordinationStore(f.path, f.dependencies), /left unchanged/);
});

test('failed persistence cannot create an in-memory grant or note', (t) => {
  const f = fixture(t);
  f.store.connect('a', 'b');
  rmSync(f.path); mkdirSync(f.path);
  assert.throws(() => f.send());
  assert.equal(f.store.state('b').messages.length, 0);
});

test('changed subscriptions are isolated, removable, and cannot mutate internal state', (t) => {
  const f = fixture(t);
  let calls = 0;
  const unsubscribe = f.store.subscribe((ids) => { calls += 1; ids.splice(0); });
  f.store.connect('a', 'b');
  assert.equal(calls, 1);
  assert.deepEqual(f.changed.at(-1), ['a', 'b']);
  unsubscribe(); f.send();
  assert.equal(calls, 1);
});
