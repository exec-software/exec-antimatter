import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Sidebar from '../renderer/src/components/Sidebar/Sidebar';
import type { Thread } from '../renderer/src/types';
import type { ChatImportSource } from '../src/api/chatImports';
import {
  IMPORTED_SIDEBAR_GROUPS_KEY, importedChatSource, importedSidebarGroupExpanded,
  loadImportedSidebarGroups, pinThread, saveImportedSidebarGroups, sidebarLists, unpinThread,
} from '../renderer/src/lib/pins';

const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id, title: id, projectId: 'inbox', createdAt: 1,
  messages: [{ id: `${id}-message`, role: 'assistant', content: `Reply for ${id}` }], ...patch,
});
const imported = (id: string, source: ChatImportSource, patch: Partial<Thread> = {}) => thread(id, {
  importedFrom: { source, format: source === 'claude' ? 'claude-export' : source === 'codex' ? 'codex-rollout' : 'opencode-export', externalId: `external-${id}`, importedAt: 100 },
  ...patch,
});

test('imported chats have one source group, native Recent stays native, and pinned imports move to Pinned', () => {
  const lists = sidebarLists([
    thread('native-old'), thread('native-new', { createdAt: 9 }),
    imported('claude-old', 'claude'), imported('claude-new', 'claude', { createdAt: 8 }),
    imported('codex-only', 'codex'), imported('pinned-claude', 'claude', { pinnedAt: 300 }),
    imported('opencode-old', 'opencode'), imported('opencode-new', 'opencode', { createdAt: 7 }),
    imported('pinned-opencode', 'opencode', { pinnedAt: 350 }),
  ], [], { projectId: 'inbox', query: '' });
  assert.deepEqual(lists.recent.map((item) => item.id), ['native-new', 'native-old']);
  assert.deepEqual(lists.imported.claude.map((item) => item.id), ['claude-new', 'claude-old']);
  assert.deepEqual(lists.imported.codex.map((item) => item.id), ['codex-only']);
  assert.deepEqual(lists.imported.opencode.map((item) => item.id), ['opencode-new', 'opencode-old']);
  assert.deepEqual(lists.pinned.map((item) => item.thread.id), ['pinned-opencode', 'pinned-claude']);
  const visible = [...lists.recent, ...lists.imported.claude, ...lists.imported.codex, ...lists.imported.opencode, ...lists.pinned.map((item) => item.thread)];
  assert.equal(new Set(visible.map((item) => item.id)).size, visible.length);
});

test('source groups use the same project and case-insensitive title/last-message search as Recent', () => {
  const lists = sidebarLists([
    imported('claude-match', 'claude', { title: 'Release checklist' }),
    imported('codex-match', 'codex', { messages: [{ id: 'm', role: 'assistant', content: 'CHECKLIST ready' }] }),
    imported('claude-other-project', 'claude', { title: 'Release checklist', projectId: 'other' }),
    imported('claude-no-match', 'claude'),
    imported('opencode-match', 'opencode', { title: 'Project checklist' }),
    imported('opencode-other-project', 'opencode', { title: 'Checklist', projectId: 'other' }),
    imported('opencode-no-match', 'opencode'),
    thread('native-match', { title: 'Checklist notes' }),
  ], [], { projectId: 'inbox', query: '  checklist ' });
  assert.deepEqual(lists.imported.claude.map((item) => item.id), ['claude-match']);
  assert.deepEqual(lists.imported.codex.map((item) => item.id), ['codex-match']);
  assert.deepEqual(lists.imported.opencode.map((item) => item.id), ['opencode-match']);
  assert.deepEqual(lists.recent.map((item) => item.id), ['native-match']);
});

test('OpenCode pin and unpin retain source metadata and return to the OpenCode group, not Recent', () => {
  const original = imported('opencode-session', 'opencode');
  const pinned = pinThread([original], original.id, 500);
  assert.equal(pinned[0].importedFrom, original.importedFrom);
  assert.equal(sidebarLists(pinned, [], { projectId: 'inbox', query: '' }).imported.opencode.length, 0);
  const lists = sidebarLists(unpinThread(pinned, original.id), [], { projectId: 'inbox', query: '' });
  assert.equal(lists.imported.opencode[0].importedFrom, original.importedFrom);
  assert.equal(lists.recent.length, 0);
});

test('pin and unpin preserve import provenance, and a message bookmark does not move its conversation', () => {
  const original = imported('claude', 'claude');
  const pinned = pinThread([original], original.id, 500);
  assert.equal(pinned[0].importedFrom, original.importedFrom);
  assert.equal(sidebarLists(pinned, [], { projectId: 'inbox', query: '' }).imported.claude.length, 0);
  const unpinned = unpinThread(pinned, original.id);
  const lists = sidebarLists(unpinned, [{ id: 'bookmark', threadId: original.id, messageId: 'claude-message', snippet: 'saved', sourceName: 'Claude', createdAt: 600 }], { projectId: 'inbox', query: '' });
  assert.equal(lists.imported.claude[0].importedFrom, original.importedFrom);
  assert.equal(lists.pinned[0].kind, 'message');
  assert.equal(lists.recent.length, 0);
});

test('unknown import provenance does not make a conversation disappear', () => {
  const malformed = thread('legacy', { importedFrom: { source: 'unknown' } as unknown as Thread['importedFrom'] });
  assert.equal(importedChatSource(malformed), null);
  assert.deepEqual(sidebarLists([malformed], [], { projectId: 'inbox', query: '' }).recent, [malformed]);
});

test('source expansion preferences persist defensively and search expansion never mutates them', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.deepEqual(loadImportedSidebarGroups(storage), { claude: false, codex: false, opencode: false });
  saveImportedSidebarGroups({ claude: true, codex: false, opencode: true }, storage);
  assert.deepEqual(loadImportedSidebarGroups(storage), { claude: true, codex: false, opencode: true });
  const saved = values.get(IMPORTED_SIDEBAR_GROUPS_KEY);
  assert.equal(importedSidebarGroupExpanded(false, 'match', 1), true);
  assert.equal(importedSidebarGroupExpanded(false, 'match', 0), false);
  assert.equal(importedSidebarGroupExpanded(false, ' ', 1), false);
  assert.equal(importedSidebarGroupExpanded(true, '', 0), true);
  assert.equal(values.get(IMPORTED_SIDEBAR_GROUPS_KEY), saved);
  values.set(IMPORTED_SIDEBAR_GROUPS_KEY, '{broken');
  assert.deepEqual(loadImportedSidebarGroups(storage), { claude: false, codex: false, opencode: false });
  values.set(IMPORTED_SIDEBAR_GROUPS_KEY, '{"claude":"true","codex":true}');
  assert.deepEqual(loadImportedSidebarGroups(storage), { claude: false, codex: true, opencode: false }, 'older preferences retain their values and the new group starts collapsed');
  assert.doesNotThrow(() => saveImportedSidebarGroups({ claude: true, codex: true, opencode: true }, { setItem: () => { throw new Error('storage denied'); } }));
});

const props = (threads: Thread[], search = '', working: ReadonlySet<string> = new Set()) => ({
  threads, projects: [], pinned: [], activeProjectId: 'inbox', activeThreadId: null, search, drafts: {}, working,
  onSelectThread: () => {}, onSelectProject: () => {}, onOpenPinned: () => {}, onUnpin: () => {},
  onDeleteThread: () => {}, onRenameThread: () => {}, onPinThread: () => {}, onImportChats: () => {},
});

test('sidebar keeps all three empty source groups and their import actions visible', () => {
  const html = renderToStaticMarkup(createElement(Sidebar, props([])));
  assert.match(html, /aria-label="Import Claude chats"/);
  assert.match(html, /aria-label="Import Codex chats"/);
  assert.match(html, /aria-label="Import OpenCode chats"/);
  assert.match(html, /aria-label="0 unpinned Claude chats"/);
  assert.match(html, /aria-label="0 unpinned Codex chats"/);
  assert.match(html, /aria-label="0 unpinned OpenCode chats"/);
  assert.match(html, /aria-expanded="false" aria-controls="sidebar-imported-claude"/);
  assert.match(html, /id="sidebar-imported-claude" hidden="" class="hidden/);
  assert.match(html, /aria-expanded="false" aria-controls="sidebar-imported-opencode"/);
  assert.match(html, /id="sidebar-imported-opencode" hidden="" class="hidden/);
});

test('search reveals matching imported rows with normal rename/delete controls and one row per conversation', () => {
  const html = renderToStaticMarkup(createElement(Sidebar, props([
    imported('Claude result', 'claude'), imported('Codex result', 'codex'), imported('OpenCode result', 'opencode'), thread('Native result'),
  ], 'result')));
  assert.match(html, /aria-expanded="true" aria-controls="sidebar-imported-claude"/);
  assert.match(html, /aria-expanded="true" aria-controls="sidebar-imported-codex"/);
  assert.match(html, /aria-expanded="true" aria-controls="sidebar-imported-opencode"/);
  for (const name of ['Claude result', 'Codex result', 'OpenCode result', 'Native result']) {
    assert.equal((html.match(new RegExp(`data-thread-row="${name}"`, 'g')) ?? []).length, 1);
    assert.ok(html.includes(`aria-label="Rename ${name}"`));
    assert.ok(html.includes(`aria-label="Delete ${name}"`));
  }
  assert.match(html, /data-imported-source="claude"/);
  assert.match(html, /data-imported-source="codex"/);
  assert.match(html, /data-imported-source="opencode"/);
  assert.match(html, /Assistant: Reply for Claude result/);
  assert.match(html, /Antimatter: Reply for Native result/);
});

test('a conversation answering in the background says so in the list', () => {
  const working = thread('Background');
  const html = renderToStaticMarkup(createElement(Sidebar, props([working, thread('Idle')], '', new Set([working.id]))));

  // Exactly one row is marked, and it is the one with a turn in flight.
  assert.equal((html.match(/title="Answering now"/g) ?? []).length, 1);
  const rows = html.split('data-thread-row=');
  const marked = rows.find((row) => row.includes('title="Answering now"')) ?? '';
  assert.match(marked, /^"Background"/);
});
