import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as conversations from '../src/main/conversations';
import { placeMenu } from '../renderer/src/lib/menu';
import { isPinnedThread, pinThread, restorable, sidebarLists, unpinThread } from '../renderer/src/lib/pins';
import type { PinnedConversation, Thread } from '../renderer/src/types';

const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id,
  title: `Conversation ${id}`,
  messages: [{ id: `${id}-m1`, role: 'user', content: `hello from ${id}` }],
  projectId: 'inbox',
  createdAt: Number(id.replace(/\D/g, '')) || 1,
  ...patch,
});

const bookmark = (threadId: string, createdAt: number, snippet = 'a pinned reply'): PinnedConversation => ({
  id: `pin-${threadId}-${createdAt}`,
  threadId,
  messageId: `${threadId}-m1`,
  snippet,
  sourceName: 'beholdd',
  createdAt,
});

test('pinning a conversation is a flag on the thread, and doing it twice changes nothing', () => {
  const threads = [thread('t1'), thread('t2')];

  const pinned = pinThread(threads, 't1', 500);
  assert.equal(pinned.find((entry) => entry.id === 't1')!.pinnedAt, 500);
  assert.equal(pinned[1], threads[1], 'other threads keep their identity');
  assert.equal(pinThread(pinned, 't1', 900), pinned, 'already pinned: the same array, so no re-render and no save');
  assert.equal(pinThread(pinned, 'missing', 900), pinned);

  const unpinned = unpinThread(pinned, 't1');
  assert.equal(isPinnedThread(unpinned[0]), false);
  assert.equal('pinnedAt' in unpinned[0], false, 'unpinning removes the field rather than storing undefined');
  assert.equal(unpinThread(unpinned, 't1'), unpinned);
});

test('the sidebar lifts pinned conversations out of Recent and orders every pin by when it was made', () => {
  const threads = [
    thread('t1', { pinnedAt: 100 }),
    thread('t2'),
    thread('t3', { pinnedAt: 300, title: 'Release checklist' }),
    thread('t4', { projectId: 'research', pinnedAt: 999 }),
    thread('t5'),
  ];
  const bookmarks = [bookmark('t2', 200), bookmark('t4', 1000), bookmark('gone', 5000)];

  const lists = sidebarLists(threads, bookmarks, { projectId: 'inbox', query: '' });
  assert.deepEqual(
    lists.pinned.map((row) => `${row.kind}:${row.thread.id}`),
    ['conversation:t3', 'message:t2', 'conversation:t1'],
    'newest pin first; other projects and missing threads stay out'
  );
  assert.deepEqual(
    lists.recent.map((entry) => entry.id),
    ['t5', 't2'],
    'a pinned message leaves its conversation in Recent; a pinned conversation does not stay there'
  );

  const searched = sidebarLists(threads, bookmarks, { projectId: 'inbox', query: '  CHECKLIST ' });
  assert.deepEqual(searched.pinned.map((row) => row.thread.id), ['t3']);
  assert.deepEqual(searched.recent, []);

  const bySnippet = sidebarLists(threads, [bookmark('t2', 200, 'the migration plan')], { projectId: 'inbox', query: 'migration' });
  assert.deepEqual(bySnippet.pinned.map((row) => `${row.kind}:${row.thread.id}`), ['message:t2']);
});

test('restoring keeps conversations with messages, drafts or a pin, and drops bookmarks into nothing', () => {
  const empty = (id: string, patch: Partial<Thread> = {}) => thread(id, { messages: [], ...patch });
  const threads = [thread('t1'), empty('t2'), empty('t3', { pinnedAt: 7 }), empty('t4')];
  const drafts = { t4: { text: 'half a thought', attachments: [] } };

  const result = restorable(threads, drafts, [bookmark('t1', 1), bookmark('t2', 2)]);
  assert.deepEqual(result.threads.map((entry) => entry.id), ['t1', 't3', 't4']);
  assert.deepEqual(result.pinned.map((entry) => entry.threadId), ['t1']);
});

test('a context menu opens at the pointer and flips to stay inside the window', () => {
  const size = { width: 190, height: 120 };
  const viewport = { width: 1200, height: 800 };
  assert.deepEqual(placeMenu({ x: 100, y: 100 }, size, viewport), { left: 100, top: 100 });
  assert.deepEqual(placeMenu({ x: 1150, y: 100 }, size, viewport), { left: 960, top: 100 }, 'flips left at the right edge');
  assert.deepEqual(placeMenu({ x: 100, y: 760 }, size, viewport), { left: 100, top: 640 }, 'flips up at the bottom');
  assert.deepEqual(placeMenu({ x: 50, y: 50 }, { width: 2000, height: 1000 }, viewport), { left: 8, top: 8 }, 'never past the margin');
});

test('the conversation store never trims a pinned conversation to make room', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-pins-store-'));
  const previous = conversations.location();
  t.after(() => {
    conversations.useStorePath(previous);
    rmSync(root, { recursive: true, force: true });
  });
  conversations.useStorePath(join(root, 'conversations.json'));

  // 205 conversations; the two oldest are pinned, so they must survive the 200-thread ceiling.
  const threads = Array.from({ length: 205 }, (_, index) => ({
    id: `t${index}`,
    title: `t${index}`,
    createdAt: index + 1,
    messages: [{ id: `m${index}`, role: 'user', content: 'hi' }],
    ...(index < 2 ? { pinnedAt: 10_000 + index } : {}),
  }));
  const saved = conversations.save({ threads, activeThreadId: 't204', pinned: [], drafts: {} });

  assert.equal(saved.threads.length, 200);
  const ids = new Set(saved.threads.map((entry) => entry.id));
  assert.ok(ids.has('t0') && ids.has('t1'), 'the pinned oldest conversations are kept');
  assert.equal(ids.has('t2'), false, 'the oldest unpinned ones make the room');
  assert.ok(ids.has('t204'));
  assert.equal(saved.threads[0].id, 't204', 'still newest first');
});
