import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptThreadRevisions, mergeHostThread } from '../renderer/src/lib/conversationSync';
import type { Message, Thread } from '../renderer/src/types';

const message = (id: string, role: Message['role'], content: string): Message => ({
  id,
  role,
  content,
  meta: { createdAt: 1 },
});

const thread = (revision: number, messages: Message[]): Thread => ({
  id: 'thread-1',
  title: 'Beatinary',
  projectId: 'inbox',
  createdAt: 1,
  revision,
  messages,
});

/**
 * The regression this exists for: a window that never reads the store's revision back conflicts
 * with itself on its next checkpoint, and the conflict is applied by discarding whatever streamed
 * in between. One round trip of that is enough to show it.
 */
test('a checkpointed thread takes the revision the store assigned it', () => {
  const sent = [thread(4, [message('a', 'user', 'Build it.')])];
  const live = [thread(4, [message('a', 'user', 'Build it.'), message('b', 'assistant', 'Working…')])];
  const stored = [thread(5, [message('a', 'user', 'Build it.')])];

  const next = adoptThreadRevisions(live, sent, stored);

  assert.equal(next[0].revision, 5, 'the next checkpoint must not look like a stale second writer');
  assert.deepEqual(
    next[0].messages.map((entry) => entry.id),
    ['a', 'b'],
    'text that streamed in while the save was in flight stays exactly where it is'
  );
});

test('threads this checkpoint did not send keep their own revision', () => {
  const other = { ...thread(2, []), id: 'thread-2' };
  const next = adoptThreadRevisions([thread(4, []), other], [thread(4, [])], [thread(5, []), { ...other, revision: 9 }]);

  assert.deepEqual(next.map((entry) => entry.revision), [5, 2]);
});

test('an unchanged revision leaves the array identical, so the checkpoint cannot loop', () => {
  const live = [thread(5, [])];
  assert.equal(adoptThreadRevisions(live, [thread(5, [])], [thread(5, [])]), live);
  assert.equal(adoptThreadRevisions(live, [], [thread(9, [])]), live);
});

test('host workspace binding is adopted without losing streamed text or a newer explicit folder change', () => {
  const sent = [{ ...thread(1, []), directory: null }];
  const host = [{ ...thread(2, []), directory: null, workspaceBinding: { path: '/alpha', confirmed: false } }];
  const live = [{ ...thread(1, [message('live', 'assistant', 'Still writing')]), directory: null }];
  const next = adoptThreadRevisions(live, sent, host);
  assert.deepEqual(next[0].workspaceBinding, { path: '/alpha', confirmed: false });
  assert.equal(next[0].messages[0].content, 'Still writing');
  const moved = [{ ...live[0], directory: '/beta', workspaceBinding: null }];
  assert.equal(adoptThreadRevisions(moved, sent, host)[0].workspaceBinding, null);
});

test('a delayed checkpoint cannot undo newer workspace confirmation or roll back its revision', () => {
  const sent = [{ ...thread(1, []), directory: null }];
  const stale = [{ ...thread(2, []), directory: null, workspaceBinding: { path: '/alpha', confirmed: false } }];
  const current = [{ ...thread(3, []), directory: null, workspaceBinding: { path: '/alpha', confirmed: true } }];
  assert.equal(adoptThreadRevisions(current, sent, stale), current);
});

test('a conflict keeps the turn this window is streaming and takes the rest from the store', () => {
  const local = thread(4, [
    message('a', 'user', 'Build it.'),
    message('live', 'assistant', 'Cloned the SDK. Now let me wire it up:'),
  ]);
  const host = thread(6, [
    message('a', 'user', 'Build it.'),
    message('live', 'assistant', 'Cloned the SDK.'),
    message('phone', 'user', 'Sent from the phone.'),
  ]);

  const merged = mergeHostThread(local, host, 'live');

  assert.equal(merged.revision, 6);
  assert.deepEqual(merged.messages.map((entry) => entry.id), ['a', 'live', 'phone']);
  assert.equal(
    merged.messages.find((entry) => entry.id === 'live')?.content,
    'Cloned the SDK. Now let me wire it up:'
  );
});

test('with nothing streaming here the store copy is taken whole', () => {
  const local = thread(4, [message('a', 'user', 'Build it.')]);
  const host = thread(6, [message('a', 'user', 'Build it.'), message('b', 'assistant', 'Done.')]);

  assert.equal(mergeHostThread(local, host, null), host);
  assert.equal(mergeHostThread(local, host, 'a-turn-in-another-thread'), host);
});
