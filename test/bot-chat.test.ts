import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { BOT_CHAT_LIMITS } from '../src/api/botChat';
import { BotChatStore } from '../src/main/botChat';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-bot-chat-'));
  const directory = join(root, 'project-one'); const other = join(root, 'project-two');
  mkdirSync(directory); mkdirSync(other);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const threads = [
    { id: 'a', title: 'Public a', directory: directory as string | null },
    { id: 'b', title: 'Public b', directory: other as string | null },
    { id: 'private', title: 'Private title should never appear', directory: directory as string | null },
    { id: 'inbox', title: 'General chat', directory: null as string | null },
  ];
  const active = new Map([['a', 'run-a'], ['b', 'run-b'], ['inbox', 'run-inbox']]);
  const path = join(root, 'private', 'bot-chat.json');
  const changes: unknown[] = [];
  const deps = { threads: () => threads, activeRun: (id: string) => active.get(id) ?? null,
    onChanged: (event: unknown) => changes.push(event) };
  const store = new BotChatStore(path, deps);
  const enable = () => store.configure({ enabled: true }).channels[0].id;
  return { root, directory, other, threads, active, path, deps, store, enable, changes };
}

test('disabled by default, enable is durable, and only explicit public participants are visible', (t) => {
  const f = fixture(t);
  assert.equal(f.store.enabled(), false);
  assert.deepEqual(f.store.state().targets, []);
  assert.throws(() => f.store.listTargets(), /disabled/);
  const channel = f.enable();
  assert.equal(f.store.state().channels[0].name, 'general');
  assert.deepEqual(f.store.listTargets(), []);
  f.store.assertSource('a', 'run-a', f.directory);
  assert.deepEqual(f.store.listTargets(), [], 'advertising/validating tools must not enroll');
  f.store.enroll('a', 'run-a', f.directory);
  assert.deepEqual(f.store.listTargets(), [{ id: 'a', title: 'Public a', workspace: 'project-one', running: true }]);
  f.store.enroll('inbox', 'run-inbox', null);
  assert.equal(f.store.listTargets()[1].workspace, null);
  const publicState = JSON.stringify(f.store.state());
  assert.ok(!publicState.includes(f.root));
  assert.ok(!publicState.includes('Private title'));
  assert.equal(new BotChatStore(f.path, f.deps).read(channel).messages.length, 0);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.root, 'private')).mode & 0o777, 0o700);
  assert.ok(f.changes.length >= 3);
});

test('post binds source run and canonical scope, freezes provenance, and deduplicates occurrences', (t) => {
  const f = fixture(t); const channel = f.enable();
  assert.throws(() => f.store.post('a', channel, 'bad', { runId: 'run-b', clientMessageId: 'wrong' }), /no longer active/);
  assert.throws(() => f.store.post('a', channel, 'bad', { runId: 'run-a', clientMessageId: 'scope', expectedWorkspace: f.other }), /changed project/);
  assert.throws(() => f.store.post('a', channel, 'private target', { runId: 'run-a', clientMessageId: 'private', mentionThreadIds: ['private'] }), /current public participant/);
  assert.deepEqual(f.store.listTargets(), [], 'a rejected post must not enroll');
  const options = { runId: 'run-a', clientMessageId: 'one', expectedWorkspace: f.directory };
  const first = f.store.post('a', channel, 'Shared intentionally\u202e.', options);
  assert.equal(first.body, 'Shared intentionally.');
  assert.deepEqual(first.sender, { kind: 'agent', threadId: 'a', runId: 'run-a', title: 'Public a', workspace: 'project-one' });
  assert.equal(f.store.post('a', channel, 'Shared intentionally\u202e.', options).id, first.id);
  assert.throws(() => f.store.post('a', channel, 'Different', options), /already used/);
  assert.ok(!JSON.stringify(first).includes('requestHash'));
  assert.ok(!JSON.stringify(first).includes('sourceWorkspace'));
  f.threads[0].title = 'Renamed privately';
  assert.equal(f.store.listTargets()[0].title, 'Public a');
  f.store.enroll('a', 'run-a', f.directory);
  assert.equal(f.store.listTargets()[0].title, 'Renamed privately');
  first.body = 'caller edit';
  assert.equal(f.store.read(channel).messages[0].body, 'Shared intentionally.');
  assert.equal(f.store.read(channel).messages[0].sender.kind, 'agent');
  const alias = join(f.root, 'alias'); symlinkSync(f.directory, alias);
  f.threads[0].directory = alias;
  f.store.assertSource('a', 'run-a', f.directory);
  f.threads[0].directory = f.other;
  assert.throws(() => f.store.assertSource('a', 'run-a', f.directory), /changed project/);
  f.active.delete('a');
  assert.throws(() => f.store.post('a', channel, 'late', options), /changed project|no longer active/);
});

test('human posts have human attribution and no client-provided agent identity', (t) => {
  const f = fixture(t); const channel = f.enable();
  f.store.enroll('b', 'run-b', f.other);
  const message = f.store.postHuman(channel, 'Please compare the public results.', { clientMessageId: 'human-1', mentionThreadIds: ['b'] });
  assert.deepEqual(message.sender, { kind: 'human', name: 'You' });
  assert.equal(f.store.pendingCount('b'), 1);
  assert.equal(f.store.postHuman(channel, message.body, { clientMessageId: 'human-1', mentionThreadIds: ['b'] }).id, message.id);
  assert.throws(() => f.store.postHuman(channel, 'changed', { clientMessageId: 'human-1' }), /already used/);
  assert.deepEqual(f.store.state().targets.map((target) => target.id), ['b']);
  assert.deepEqual(new BotChatStore(f.path, f.deps).read(channel).messages[0].sender, { kind: 'human', name: 'You' });
});

test('history is public-only, bounded, ordered, cursor paginated and cloned', (t) => {
  const f = fixture(t); const channel = f.enable();
  const posted = Array.from({ length: 5 }, (_, index) => f.store.postHuman(channel, `Message ${index}`, { clientMessageId: `h-${index}` }));
  const latest = f.store.read(channel, { limit: 2 });
  assert.deepEqual(latest.messages.map((message) => message.id), posted.slice(3).map((message) => message.id));
  const older = f.store.read(channel, { before: latest.nextBefore!, limit: 2 });
  assert.deepEqual(older.messages.map((message) => message.id), posted.slice(1, 3).map((message) => message.id));
  assert.equal(f.store.read(channel, { before: older.nextBefore!, limit: 2 }).nextBefore, null);
  const bounded = f.store.read(channel, { maxChars: 3 });
  assert.equal(bounded.messages[0].body, 'Mes'); assert.equal(bounded.truncated, true);
  assert.equal(bounded.messages[0].truncated, true);
  latest.channel.name = 'caller'; latest.messages[0].body = 'changed';
  assert.equal(f.store.read(channel).channel.name, 'general');
  assert.equal(f.store.read(channel).messages[3].body, 'Message 3');
  assert.throws(() => f.store.read(channel, { before: -1 }), /cursor/);
  assert.throws(() => f.store.read(channel, { maxChars: NaN }), /page size/);
});

test('mentions are leased once, only active recipients ack, and cancellation/restart requeues', (t) => {
  const f = fixture(t); const channel = f.enable(); f.store.enroll('b', 'run-b', f.other);
  const one = f.store.post('a', channel, 'First mention', { runId: 'run-a', clientMessageId: 'one', mentionThreadIds: ['b'] });
  const two = f.store.post('a', channel, 'Second mention', { runId: 'run-a', clientMessageId: 'two', mentionThreadIds: ['b'] });
  assert.equal(f.store.pendingCount('b', [one.id]), 1);
  assert.throws(() => f.store.claimMentions('b', 'wrong'), /no longer active/);
  assert.throws(() => f.store.ackMentions('b', 'run-b', [one.id]), /no longer reserved/);
  assert.equal(f.store.claimMentions('b', 'run-b', { limit: 1 })[0].id, one.id);
  assert.equal(f.store.pendingCount('b'), 1);
  f.store.release('run-b');
  assert.equal(f.store.pendingCount('b'), 2);
  assert.equal(f.store.claimMentions('b', 'run-b', { maxChars: 5 }).length, 0, 'no truncated automatic intake');
  f.store.claimMentions('b', 'run-b');
  const restarted = new BotChatStore(f.path, f.deps);
  assert.deepEqual(restarted.claimMentions('b', 'run-b').map((message) => message.id), [one.id, two.id]);
  restarted.ackMentions('b', 'run-b', [one.id]);
  f.active.set('b', 'next-b');
  assert.throws(() => restarted.ackMentions('b', 'run-b', [two.id]), /no longer active/);
  assert.equal(restarted.claimMentions('b', 'next-b')[0].id, two.id);
  restarted.ackMentions('b', 'next-b', [two.id]);
  assert.equal(restarted.pendingCount('b'), 0);
});

test('disable revokes prepared operations and intake without deleting public history', (t) => {
  const f = fixture(t); const channel = f.enable(); f.store.enroll('b', 'run-b', f.other);
  const generation = f.store.assertEnabled(); const revision = f.store.assertChannel(channel).revision;
  const message = f.store.postHuman(channel, 'Keep this history', { clientMessageId: 'human', mentionThreadIds: ['b'] });
  f.store.claimMentions('b', 'run-b');
  f.store.configure({ enabled: false });
  assert.equal(f.store.pendingCount('b'), 0);
  assert.throws(() => f.store.claimMentions('b', 'run-b'), /disabled/);
  assert.throws(() => f.store.ackMentions('b', 'run-b', [message.id]), /disabled/);
  assert.throws(() => f.store.read(channel), /disabled/);
  assert.throws(() => f.store.postHuman(channel, 'no', { clientMessageId: 'disabled' }), /disabled/);
  assert.equal(f.store.readHistory(channel).messages[0].body, 'Keep this history');
  f.enable();
  assert.throws(() => f.store.assertEnabled(generation), /settings changed/);
  assert.throws(() => f.store.post('a', channel, 'stale', { runId: 'run-a', clientMessageId: 'stale', expectedGeneration: generation, expectedChannelRevision: revision }), /settings changed/);
  assert.equal(f.store.claimMentions('b', 'run-b')[0].id, message.id);
});

test('pause and archive are independently enforced and redaction erases only explicit public body', (t) => {
  const f = fixture(t); const channel = f.enable(); f.store.enroll('b', 'run-b', f.other);
  const other = f.store.createChannel({ name: 'builds', description: 'Build status' });
  const one = f.store.postHuman(channel, 'Unique public content to erase', { clientMessageId: 'one', mentionThreadIds: ['b'] });
  assert.throws(() => f.store.postHuman(other.id, 'bad reply', { clientMessageId: 'reply', replyTo: one.id }), /this channel/);
  const revision = f.store.assertChannel(channel).revision;
  f.store.updateChannel(channel, { postingPaused: true });
  assert.throws(() => f.store.postHuman(channel, 'no', { clientMessageId: 'paused' }), /paused/);
  assert.equal(f.store.read(channel).messages.length, 1);
  assert.equal(f.store.claimMentions('b', 'run-b').length, 1, 'pause does not revoke already posted mentions');
  f.store.moderate(channel, one.id, 'Removed by user');
  assert.throws(() => f.store.ackMentions('b', 'run-b', [one.id]), /no longer reserved/);
  const tombstone = f.store.readHistory(channel).messages[0];
  assert.equal(tombstone.body, ''); assert.ok(tombstone.redactedAt); assert.deepEqual(tombstone.sender, one.sender);
  assert.ok(!readFileSync(f.path, 'utf8').includes('Unique public content to erase'));
  f.store.updateChannel(channel, { postingPaused: false });
  assert.throws(() => f.store.assertChannel(channel, { expectedRevision: revision }), /channel changed/);
  assert.throws(() => f.store.postHuman(channel, 'reply', { clientMessageId: 'reply-redacted', replyTo: one.id }), /available message/);
  const second = f.store.postHuman(channel, 'Second', { clientMessageId: 'second', mentionThreadIds: ['b'] });
  f.store.updateChannel(channel, { archived: true });
  assert.throws(() => f.store.read(channel), /archived/);
  assert.equal(f.store.listChannels().length, 1);
  assert.equal(f.store.pendingCount('b'), 0);
  assert.equal(f.store.readHistory(channel).messages[1].id, second.id);
  f.store.updateChannel(channel, { archived: false });
  assert.equal(f.store.pendingCount('b'), 0, 'unarchive must not resurrect dismissed mentions');
});

test('deleted or moved participants lose queued mentions and must explicitly re-enroll', (t) => {
  const f = fixture(t); const channel = f.enable(); f.store.enroll('b', 'run-b', f.other);
  f.store.postHuman(channel, 'Old project only', { clientMessageId: 'one', mentionThreadIds: ['b'] });
  f.threads[1].directory = f.directory;
  f.store.reconcile(); assert.deepEqual(f.store.listTargets(), []); assert.equal(f.store.pendingCount('b'), 0);
  f.threads[1].directory = f.other;
  assert.deepEqual(f.store.listTargets(), []);
  f.store.enroll('b', 'run-b', f.other);
  assert.equal(f.store.claimMentions('b', 'run-b').length, 0);
  f.store.postHuman(channel, 'New enrollment', { clientMessageId: 'two', mentionThreadIds: ['b'] });
  f.threads.splice(1, 1); f.store.reconcile();
  assert.equal(f.store.pendingCount('b'), 0);
  assert.equal(f.store.read(channel).messages.length, 2, 'public history is independent of private conversation deletion');
});

test('limits reject oversized bytes, invalid values, and full mention queues atomically', (t) => {
  const f = fixture(t); const channel = f.enable(); f.store.enroll('b', 'run-b', f.other);
  assert.throws(() => f.store.postHuman(channel, '😀'.repeat(2049), { clientMessageId: 'large' }), /8 KiB/);
  assert.throws(() => f.store.postHuman(channel, '\u0000 ', { clientMessageId: 'empty' }), /Write a message/);
  assert.throws(() => f.store.createChannel({ name: '../escape' }), /Channel names/);
  assert.throws(() => f.store.createChannel({ name: 'general' }), /already has/);
  assert.throws(() => f.store.createChannel({ name: 'okay', description: 'x'.repeat(501) }), /500/);
  assert.throws(() => f.store.configure(null as never), /Choose whether/);
  assert.throws(() => f.store.updateChannel(channel, null as never), /settings/);
  assert.throws(() => f.store.postHuman(channel, 'x', { clientMessageId: 'many', mentionThreadIds: Array(65).fill('b') }), /64/);
  for (let index = 0; index < BOT_CHAT_LIMITS.pendingPerTarget; index += 1) f.store.postHuman(channel, 'pending', { clientMessageId: `q-${index}`, mentionThreadIds: ['b'] });
  assert.throws(() => f.store.postHuman(channel, 'overflow', { clientMessageId: 'overflow', mentionThreadIds: ['b'] }), /64 pending/);
  assert.equal(f.store.read(channel, { limit: 100 }).messages.length, 64);
});

test('retention evicts settled history but preserves active run retries and pending mentions', (t) => {
  const f = fixture(t); const channel = f.enable(); f.store.enroll('b', 'run-b', f.other);
  const pending = f.store.postHuman(channel, 'preserve pending', { clientMessageId: 'pending', mentionThreadIds: ['b'] });
  const active = f.store.post('a', channel, 'preserve active', { runId: 'run-a', clientMessageId: 'active' });
  const seed = f.store.postHuman(channel, 'old', { clientMessageId: 'old' });
  const raw = JSON.parse(readFileSync(f.path, 'utf8'));
  const old = raw.messages[2];
  for (let index = 3; index < BOT_CHAT_LIMITS.messages; index += 1) raw.messages.push({ ...old, id: `retained-${index}`, clientMessageId: `retained-${index}`, sequence: index + 1 });
  raw.nextSequence = BOT_CHAT_LIMITS.messages + 1;
  writeFileSync(f.path, JSON.stringify(raw));
  const store = new BotChatStore(f.path, f.deps);
  store.postHuman(channel, 'new', { clientMessageId: 'new' });
  const saved = JSON.parse(readFileSync(f.path, 'utf8'));
  assert.equal(saved.messages.length, BOT_CHAT_LIMITS.messages);
  assert.ok(saved.messages.some((message: { id: string }) => message.id === pending.id));
  assert.ok(saved.messages.some((message: { id: string }) => message.id === active.id));
  assert.ok(!saved.messages.some((message: { id: string }) => message.id === seed.id));
  assert.equal(store.post('a', channel, 'preserve active', { runId: 'run-a', clientMessageId: 'active' }).id, active.id);
});

test('malformed or symlinked private sidecars fail closed without replacing saved data', (t) => {
  const f = fixture(t); f.enable();
  writeFileSync(f.path, '{ broken');
  assert.throws(() => new BotChatStore(f.path, f.deps), /saved file was left unchanged/);
  assert.equal(readFileSync(f.path, 'utf8'), '{ broken');
  rmSync(f.path);
  const foreign = join(f.root, 'foreign.json'); writeFileSync(foreign, '{}'); symlinkSync(foreign, f.path);
  assert.throws(() => new BotChatStore(f.path, f.deps), /saved file was left unchanged/);
  assert.equal(readFileSync(foreign, 'utf8'), '{}');
});
