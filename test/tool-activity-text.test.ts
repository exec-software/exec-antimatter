import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import * as conversations from '../src/main/conversations';
import * as toolText from '../src/main/toolActivityText';

function sandbox(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-tool-text-'));
  const previousStore = conversations.location();
  const previousRoot = toolText.location();
  conversations.useStorePath(join(root, 'conversations.json'));
  t.after(() => {
    conversations.useStorePath(previousStore);
    toolText.useRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

const thread = (tools: Array<Record<string, unknown>>) => ({
  id: 'thread',
  messages: [
    { id: 'user', role: 'user' as const, content: 'go', meta: { createdAt: 1 } },
    { id: 'answer', role: 'assistant' as const, content: 'done', meta: { createdAt: 2, tools } },
  ],
});

/** A tool record the store will accept: `callId` and `requestId` are both required of it. */
const record = (activityId: string, args: string, result: string) => ({
  callId: activityId, requestId: `req-${activityId}`, serverId: 'antimatter',
  serverName: 'Antimatter tools', toolName: 'read_file',
  tier: 'read', status: 'done', activityId, args, result,
});

test('splitting a thread moves its tool text out and leaves the anchors behind', () => {
  const { thread: stripped, entries } = toolText.split(thread([record('a1', '{"path":"x"}', 'contents')]));
  const tools = stripped.messages[1].meta.tools as Array<Record<string, unknown>>;
  assert.equal('args' in tools[0], false, 'arguments do not stay in the conversation');
  assert.equal('result' in tools[0], false, 'nor does the result');
  // Everything a card needs without expanding is still there.
  assert.equal(tools[0].toolName, 'read_file');
  assert.equal(tools[0].status, 'done');
  assert.equal(tools[0].activityId, 'a1');
  assert.deepEqual(entries, { a1: { args: '{"path":"x"}', result: 'contents' } });
});

test('merging puts exactly what was split back, and is a no-op with nothing stored', () => {
  const original = thread([record('a1', '{"path":"x"}', 'contents'), record('a2', '{}', '')]);
  const { thread: stripped, entries } = toolText.split(original);
  assert.deepEqual(toolText.merge(stripped, entries), original);
  // An empty sidecar must not invent fields: a card with no stored text shows no text.
  const bare = toolText.merge(stripped, {});
  assert.equal('args' in (bare.messages[1].meta.tools as Array<Record<string, unknown>>)[0], false);
});

test('a record with no activity id keeps its text inline, because nothing could find it again', () => {
  const orphan = { callId: 'c', serverId: 'antimatter', serverName: 'n', toolName: 'read_file',
    tier: 'read', status: 'done', args: '{"path":"x"}', result: 'contents' };
  const { thread: stripped, entries } = toolText.split(thread([orphan]));
  assert.deepEqual(entries, {}, 'nothing is filed under an id that does not exist');
  assert.equal((stripped.messages[1].meta.tools as Array<Record<string, unknown>>)[0].args, '{"path":"x"}');
});

test('a sidecar is written, read back, and removed once a thread has no text', (t) => {
  sandbox(t);
  toolText.write('thread', { a1: { args: 'x', result: 'y' } });
  assert.deepEqual(toolText.read('thread'), { a1: { args: 'x', result: 'y' } });
  // Writing nothing is a deletion rather than an empty file nobody will ever read.
  toolText.write('thread', {});
  assert.deepEqual(toolText.read('thread'), {});
  assert.equal(existsSync(join(toolText.location(), 'thread.json')), false);
});

test('an unreadable sidecar costs the expanded text and not the conversation', (t) => {
  const root = sandbox(t);
  toolText.write('thread', { a1: { args: 'x', result: 'y' } });
  const path = join(root, 'tool-activity', 'thread.json');
  rmSync(path, { force: true });
  require('node:fs').writeFileSync(path, 'not json at all');
  assert.deepEqual(toolText.read('thread'), {}, 'a damaged sidecar reads as empty, never throws');
});

test('keepOnly drops the sidecars of threads that no longer exist', (t) => {
  sandbox(t);
  toolText.write('kept', { a: { args: 'x' } });
  toolText.write('gone', { b: { args: 'y' } });
  toolText.keepOnly(['kept']);
  assert.deepEqual(readdirSync(toolText.location()).sort(), ['kept.json']);
});

test('the store writes the conversation without tool text and reads it back whole', (t) => {
  const root = sandbox(t);
  const created = conversations.createThread({ id: 'thread', projectId: 'inbox', createdAt: 1 }, 0);
  conversations.save({
    revision: 1,
    threads: [{ ...created, messages: thread([record('a1', '{"path":"x"}', 'contents')]).messages }],
    activeThreadId: 'thread', pinned: [], drafts: {},
  });

  // The file the renderer checkpoints into no longer carries the bulk...
  const onDisk = JSON.parse(readFileSync(join(root, 'conversations.json'), 'utf8'));
  const storedTools = onDisk.threads[0].messages[1].meta.tools;
  // Guard against the vacuous pass: a record the store rejected would be an empty array here,
  // and every assertion below would hold for the wrong reason.
  assert.equal(storedTools.length, 1, 'the store must have accepted the tool record');
  assert.equal('args' in storedTools[0], false, 'tool text must not be in conversations.json');
  assert.equal(storedTools[0].activityId, 'a1', 'but its anchor must be');
  // ...it is beside it.
  assert.deepEqual(toolText.read('thread'), { a1: { args: '{"path":"x"}', result: 'contents' } });

  // And a later run, with no warm cache, hands the renderer the whole thing again.
  conversations.useStorePath(join(root, 'conversations.json'));
  const reloaded = conversations.load().threads[0].messages[1].meta?.tools;
  assert.equal(reloaded?.[0].args, '{"path":"x"}');
  assert.equal(reloaded?.[0].result, 'contents');
});

test('the sidecars follow the store, so redirecting one redirects both', (t) => {
  const root = sandbox(t);
  assert.equal(toolText.location(), join(root, 'tool-activity'),
    'a test that points the store at a temporary directory must not leave tool text in a real home');
});
