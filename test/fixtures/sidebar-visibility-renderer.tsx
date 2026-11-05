import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LeftRail } from '../../renderer/src/components/layout/LeftRail';
import { DEFAULT_SIDEBAR_VISIBILITY, SIDEBAR_VISIBILITY_KEY } from '../../renderer/src/lib/sidebarVisibility';
import { IMPORTED_SIDEBAR_GROUPS_KEY } from '../../renderer/src/lib/pins';
import { initializeAppearance, saveAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';
import type { AppPage, Thread } from '../../renderer/src/types';

initializeAppearance({ initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, update: async (patch) => ({ ...DEFAULT_APPEARANCE, ...patch }), onChanged: () => () => {} });
const actions: unknown[] = [];
const subscribe = () => () => {};
window.electronAPI = { onHubDownloads: subscribe, hub: { downloads: async () => [] }, onUpdateState: subscribe,
  onEnvironmentExit: subscribe, onDebugState: subscribe, environment: { open: async () => ({ root: '', entries: [] }), breakpoints: async () => [] },
  updates: { state: async () => ({ install: { kind: 'development' } }) } } as unknown as typeof window.electronAPI;
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({ id, title: `Find ${id}`, projectId: 'inbox', createdAt: 1, messages: [], ...patch });
const threads: Thread[] = [thread('native'), thread('pinned', { pinnedAt: 1 }),
  ...(['claude', 'codex', 'opencode'] as const).map((source) => thread(source, { importedFrom: { source, format: source === 'claude' ? 'claude-export' : source === 'codex' ? 'codex-rollout' : 'opencode-export', externalId: source, importedAt: 1 } }))];
let setBotEnabled: (value: boolean) => void;
let setSearch: (value: string) => void;
function Fixture() {
  const [page, setPage] = useState<AppPage>('chat');
  const [search, updateSearch] = useState(''); setSearch = updateSearch;
  const [botChatEnabled, updateBotEnabled] = useState(false); setBotEnabled = updateBotEnabled;
  return <div className="flex h-screen bg-surface text-ink">
    <LeftRail page={page} botChatEnabled={botChatEnabled} threads={threads} projects={[{ id: 'inbox', name: 'Inbox', description: 'All conversations' }]} pinned={[]}
      activeProjectId="inbox" activeThreadId="native" search={search} onSearchChange={updateSearch}
      onSelectThread={(id) => actions.push(['open', id])} onSelectProject={(id) => actions.push(['project', id])}
      onOpenPinned={() => {}} onUnpin={(id) => actions.push(['unpin', id])} onDeleteThread={(id) => actions.push(['delete', id])}
      onRenameThread={(id, title) => actions.push(['rename', id, title])} onPinThread={(id, pinned) => actions.push(['pin', id, pinned])}
      onNewThread={() => actions.push(['new'])} onChangePage={(next) => { actions.push(['page', next]); setPage(next); }}
      onOpenToolWindow={(id) => actions.push(['tool', id])} isToolWindowOpen={() => false}
      onImportChats={(source) => actions.push(['import', source])} drafts={{ native: { text: 'Unsaved draft remains here', attachments: [] } }} working={new Set(['native'])} />
    <main className="min-w-0 flex-1 p-8">
      <h1 className="text-lg font-semibold">Sidebar preferences</h1>
      <p className="mt-2 text-sm text-ink-2">Current view: {page}</p>
      <p className="mt-2 text-sm text-ink-3">Synthetic chats and folders. Hide sections without changing their contents.</p>
      <button type="button" className="mt-4 rounded border border-line px-3 py-2 text-xs">Outside the sidebar</button>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
const button = (label: string) => [...document.querySelectorAll('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent?.trim() === label);
const checkboxes = () => [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')];
Object.assign(window, { sidebarSmoke: {
  appearance: saveAppearance, bot: (enabled: boolean) => setBotEnabled(enabled), search: (value: string) => setSearch(value),
  click: (label: string) => { const element = button(label); if (!element || element.disabled) throw new Error(`Button unavailable: ${label}`); element.click(); },
  focus: (label: string) => { const element = button(label); if (!element) throw new Error(`Button unavailable: ${label}`); element.focus(); },
  openThread: (id: string) => { const element = [...document.querySelectorAll<HTMLButtonElement>('[data-thread-row]')].find((element) => element.dataset.threadRow === id); if (!element) throw new Error(`Thread unavailable: ${id}`); element.click(); },
  toggle: (label: string) => { const input = checkboxes().find((element) => element.closest('label')?.textContent?.trim() === label); if (!input) throw new Error(`Checkbox unavailable: ${label}`); input.click(); },
  hideAll: () => { for (const input of checkboxes()) if (input.checked) input.click(); },
  outside: () => { document.querySelector('main')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); },
  externalReset: () => { localStorage.removeItem(SIDEBAR_VISIBILITY_KEY); window.dispatchEvent(new StorageEvent('storage', { key: SIDEBAR_VISIBILITY_KEY })); },
  snapshot: () => ({
    text: document.body.textContent, actions, threads, saved: JSON.parse(localStorage.getItem(SIDEBAR_VISIBILITY_KEY) ?? 'null'),
    defaultVisibility: DEFAULT_SIDEBAR_VISIBILITY, expansion: localStorage.getItem(IMPORTED_SIDEBAR_GROUPS_KEY),
    dialog: !!document.querySelector('[role="dialog"]'),
    focus: document.activeElement instanceof HTMLInputElement ? document.activeElement.closest('label')?.textContent?.trim()
      : document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim(),
    checked: Object.fromEntries(checkboxes().map((input) => [input.closest('label')?.textContent?.trim(), input.checked])),
    sections: [...document.querySelectorAll('aside section')].map((element) => element.getAttribute('aria-label')),
    buttons: [...document.querySelectorAll('aside button')].map((element) => element.getAttribute('aria-label') ?? element.textContent?.trim()),
    rows: [...document.querySelectorAll('[data-thread-row]')].filter((element) => !element.closest('[hidden]')).map((element) => element.getAttribute('data-thread-row')),
    accents: { variable: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(), checkbox: checkboxes()[0] ? getComputedStyle(checkboxes()[0]).accentColor : null },
    panel: (() => { const rect = document.querySelector('[role="dialog"]')?.getBoundingClientRect(); return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight } : null; })(),
  }),
} });
