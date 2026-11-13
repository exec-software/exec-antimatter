import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SidebarStore, normalizeSidebarState } from '../src/main/sidebar';
import { ALL_CHATS_PROJECT, UNGROUPED_PROJECT, emptySidebarState, reorderVisibleSidebarRows, sidebarProjectForThread, type SidebarAction } from '../src/api/sidebar';
import { sidebarLists } from '../renderer/src/lib/pins';
import type { Thread } from '../renderer/src/types';

function storeFor(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-sidebar-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'sidebar.json'); const store = new SidebarStore(path);
  return { root, path, store, update: (action: SidebarAction) => store.update({ revision: store.read().revision, action }) };
}
const chat = (id: string, projectId: string, extra: Partial<Thread> = {}): Thread => ({ id, projectId, title: id, createdAt: 1, messages: [], ...extra });

test('removing every default group persists and recovers legacy chats without altering conversation data', (t) => {
  const { store, update, path } = storeFor(t);
  const threads = [chat('a', 'inbox'), chat('b', 'projects'), chat('c', 'research'), chat('unknown', 'old-project')];
  const original = JSON.stringify(threads);
  for (const project of store.read().projects) update({ kind: 'delete-project', id: project.id });
  const next = new SidebarStore(path).read();
  assert.equal(next.projects.length, 0);
  assert.deepEqual(threads.map((thread) => sidebarProjectForThread(next, thread)), Array(4).fill(UNGROUPED_PROJECT));
  assert.equal(sidebarLists(threads, [], { projectId: ALL_CHATS_PROJECT, query: '', sidebar: next }).recent.length, 4);
  assert.equal(sidebarLists(threads, [], { projectId: UNGROUPED_PROJECT, query: '', sidebar: next }).recent.length, 4);
  assert.equal(JSON.stringify(threads), original);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('nested groups include descendant chats; deletion promotes children and rehomes both legacy and explicitly moved chats', (t) => {
  const { store, update } = storeFor(t);
  const parent = update({ kind: 'create-project', name: 'Parent' }).projects.at(-1)!;
  const child = update({ kind: 'create-project', name: 'Child', parentId: parent.id }).projects.at(-1)!;
  const grandchild = update({ kind: 'create-project', name: 'Grandchild', parentId: child.id }).projects.at(-1)!;
  const threads = [chat('legacy', child.id), chat('explicit', 'inbox'), chat('nested', grandchild.id), chat('unrelated', 'research')];
  update({ kind: 'move-thread', threadId: 'explicit', projectId: child.id });
  assert.equal(sidebarLists(threads, [], { projectId: parent.id, query: '', sidebar: store.read() }).recent.length, 3);
  const revision = store.read().revision;
  assert.throws(() => update({ kind: 'update-project', id: parent.id, name: 'Cycle', description: '', parentId: grandchild.id }), /itself/);
  assert.equal(store.read().revision, revision);
  let next = update({ kind: 'delete-project', id: child.id });
  assert.equal(next.projects.find((group) => group.id === grandchild.id)!.parentId, parent.id);
  assert.equal(sidebarProjectForThread(next, threads[0]), parent.id);
  assert.equal(sidebarProjectForThread(next, threads[1]), parent.id);
  next = update({ kind: 'delete-project', id: parent.id });
  assert.equal(sidebarProjectForThread(next, threads[0]), UNGROUPED_PROJECT);
  assert.equal(next.projects.find((group) => group.id === grandchild.id)!.parentId, null);
});

test('ordering filtered chats preserves unseen slots, pins/bookmarks, drafts, and source provenance', (t) => {
  const { update } = storeFor(t);
  const threads = [chat('one', 'inbox'), chat('hidden', 'research'), chat('two', 'inbox'), chat('three', 'inbox')];
  const all = ['thread:one', 'thread:hidden', 'thread:two', 'thread:three'];
  const order = reorderVisibleSidebarRows(all, ['thread:one', 'thread:two', 'thread:three'], 'thread:three', 'thread:one');
  assert.deepEqual(order, ['thread:three', 'thread:hidden', 'thread:one', 'thread:two']);
  const state = update({ kind: 'reorder', section: 'recent', ids: order });
  assert.deepEqual(sidebarLists(threads, [], { projectId: ALL_CHATS_PROJECT, query: '', sidebar: state }).recent.map((thread) => thread.id), ['three', 'hidden', 'one', 'two']);
  assert.deepEqual(sidebarLists(threads, [], { projectId: 'inbox', query: '', sidebar: state }).recent.map((thread) => thread.id), ['three', 'one', 'two']);
  assert.deepEqual(reorderVisibleSidebarRows(all, ['thread:one'], 'thread:missing', null), all);
});

test('imports leave their source section only after an explicit move and retain their original attribution', (t) => {
  const { store, update } = storeFor(t);
  const imported = chat('imported', 'inbox', { importedFrom: { source: 'codex', format: 'codex-rollout', externalId: 'original', importedAt: 1 } });
  const original = JSON.stringify(imported);
  update({ kind: 'move-thread', threadId: imported.id, projectId: 'research' });
  let lists = sidebarLists([imported], [], { projectId: 'research', query: '', sidebar: store.read() });
  assert.equal(lists.recent.length, 0); assert.equal(lists.imported.codex.length, 1);
  update({ kind: 'import-location', threadId: imported.id, recent: true });
  lists = sidebarLists([imported], [], { projectId: 'research', query: '', sidebar: store.read() });
  assert.equal(lists.recent.length, 1); assert.equal(lists.imported.codex.length, 0);
  update({ kind: 'import-location', threadId: imported.id, recent: false });
  assert.equal(sidebarLists([imported], [], { projectId: ALL_CHATS_PROJECT, query: '', sidebar: store.read() }).imported.codex.length, 1);
  assert.equal(JSON.stringify(imported), original);
});

test('stale and malformed updates cannot overwrite state or touch files beyond the sidebar store', (t) => {
  const { store, update, path } = storeFor(t);
  update({ kind: 'collapse', section: 'projects', collapsed: true });
  const before = readFileSync(path, 'utf8');
  assert.throws(() => store.update({ revision: 0, action: { kind: 'delete-project', id: 'inbox' } }), /another window/);
  assert.throws(() => update({ kind: 'move-thread', threadId: 'chat', projectId: 'missing' }), /no longer exists/);
  assert.throws(() => update({ kind: 'reorder', section: '__proto__', ids: [] }), /identifier/);
  assert.throws(() => update({ kind: 'reorder', section: 'recent', ids: ['one', 'one'] }), /duplicate/);
  assert.throws(() => update({ kind: 'create-project', name: 'x'.repeat(121) }), /text/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.throws(() => normalizeSidebarState({ ...emptySidebarState(), projects: [{ id: 'cycle', name: 'cycle', description: '', parentId: 'cycle' }] }), /cycles/);
});

test('damaged files and symlinks are rejected without resetting saved groups', (t) => {
  const { store, path, root } = storeFor(t);
  writeFileSync(path, '{broken');
  assert.throws(() => store.read());
  assert.throws(() => store.update({ revision: 0, action: { kind: 'create-project', name: 'Lost changes' } }));
  assert.equal(readFileSync(path, 'utf8'), '{broken');
  rmSync(path); const target = join(root, 'other.json'); writeFileSync(target, JSON.stringify(emptySidebarState())); symlinkSync(target, path);
  assert.throws(() => store.read(), /cannot be read/);
});
