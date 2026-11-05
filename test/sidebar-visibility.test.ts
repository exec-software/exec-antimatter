import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Sidebar from '../renderer/src/components/Sidebar/Sidebar';
import type { Thread } from '../renderer/src/types';
import { DEFAULT_SIDEBAR_VISIBILITY, loadSidebarVisibility, saveSidebarVisibility, SIDEBAR_VISIBILITY_KEY } from '../renderer/src/lib/sidebarVisibility';

test('sidebar visibility defaults to visible, persists only visual preferences, and tolerates older or corrupt storage', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.deepEqual(loadSidebarVisibility(storage), DEFAULT_SIDEBAR_VISIBILITY);
  const selected = { ...DEFAULT_SIDEBAR_VISIBILITY, agents: false, 'imported-opencode': false, pinned: false };
  saveSidebarVisibility(selected, storage);
  assert.deepEqual(loadSidebarVisibility(storage), selected);
  assert.deepEqual([...values.keys()], [SIDEBAR_VISIBILITY_KEY]);
  values.set(SIDEBAR_VISIBILITY_KEY, '{"agents":false,"memory":"false","unknown":false}');
  assert.deepEqual(loadSidebarVisibility(storage), { ...DEFAULT_SIDEBAR_VISIBILITY, agents: false });
  for (const malformed of ['{broken', 'null', '[]', '42']) {
    values.set(SIDEBAR_VISIBILITY_KEY, malformed);
    assert.deepEqual(loadSidebarVisibility(storage), DEFAULT_SIDEBAR_VISIBILITY);
  }
  assert.deepEqual(loadSidebarVisibility({ getItem: () => { throw new Error('denied'); } }), DEFAULT_SIDEBAR_VISIBILITY);
  assert.doesNotThrow(() => saveSidebarVisibility(selected, { setItem: () => { throw new Error('denied'); } }));
  saveSidebarVisibility({ ...DEFAULT_SIDEBAR_VISIBILITY }, storage);
  assert.deepEqual(loadSidebarVisibility(storage), DEFAULT_SIDEBAR_VISIBILITY);
});

test('hidden conversation sections remain searchable without changing visibility, pinning, imports, or drafts', () => {
  const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, title: `Find ${id}`, projectId: 'inbox', createdAt: 1, messages: [], ...patch });
  const threads = [thread('recent'), thread('pinned', { pinnedAt: 2 }),
    thread('claude', { importedFrom: { source: 'claude', format: 'claude-export', externalId: 'source', importedAt: 1 } }),
    thread('codex', { importedFrom: { source: 'codex', format: 'codex-rollout', externalId: 'source', importedAt: 1 } }),
    thread('opencode', { importedFrom: { source: 'opencode', format: 'opencode-export', externalId: 'source', importedAt: 1 } }),
    thread('other', { projectId: 'other' })];
  const visibility = { ...DEFAULT_SIDEBAR_VISIBILITY, pinned: false, recent: false, projects: false, 'imported-claude': false, 'imported-codex': false, 'imported-opencode': false };
  const props = { threads, projects: [{ id: 'inbox', name: 'Inbox', description: '' }], pinned: [], activeProjectId: 'inbox', activeThreadId: null,
    visibility, drafts: { recent: { text: 'Unsent work', attachments: [] } }, working: new Set<string>(), onSelectThread: () => {}, onSelectProject: () => {},
    onOpenPinned: () => {}, onUnpin: () => {}, onDeleteThread: () => {}, onRenameThread: () => {}, onPinThread: () => {} };
  const before = JSON.stringify(props);
  const render = (search: string) => renderToStaticMarkup(createElement(Sidebar, { ...props, search }));
  const hidden = render('');
  assert.doesNotMatch(hidden, /<section|data-thread-row/);
  const searched = render('find');
  assert.match(searched, /Matching chats in hidden sections/);
  for (const id of ['recent', 'pinned', 'claude', 'codex', 'opencode']) assert.equal(searched.split(`data-thread-row="${id}"`).length - 1, 1);
  assert.doesNotMatch(searched, /data-thread-row="other"|aria-label="Projects"/);
  assert.match(searched, /Unsent work/);
  assert.doesNotMatch(render('nonmatching query'), /<section|data-thread-row/);
  assert.equal(render(''), hidden);
  assert.equal(JSON.stringify(props), before);
});
