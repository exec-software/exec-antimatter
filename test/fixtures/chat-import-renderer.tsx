import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DeveloperPage } from '../../renderer/src/components/developer/DeveloperPage';
import { ImportChatsPage } from '../../renderer/src/components/imports/ImportChatsPage';
import Sidebar from '../../renderer/src/components/Sidebar/Sidebar';
import { applyDisplacerTokens } from '../../renderer/src/displacer';
import { MODEL_TEST_PROMPTS } from '../../renderer/src/components/developer/modelTestPrompts';
import type { ChatImportPreview, ChatImportSource } from '../../src/api/chatImports';
import type { Thread } from '../../renderer/src/types';

const actions: unknown[] = [];
let cancel = false;
let fail = false;
let failCopy = false;
let nextBatch = 0;
const batches = new Map<string, ChatImportSource>();
const format = { claude: 'claude-export', codex: 'codex-rollout', opencode: 'opencode-export' } as const;
let publish: (threads: Thread[]) => void = () => {};
const initial: Thread[] = [{ id: 'native', title: 'Existing draft', projectId: 'inbox', createdAt: 1, messages: [] }];
let all = initial;
const copy: string[] = [];
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { if (failCopy) throw new Error('Denied'); copy.push(value); } } });
window.electronAPI = {
  developer: { get: async () => ({ autoContinue: { enabled: false, maxContinues: 3, onRoundLimit: true } }), set: async (next: unknown) => next },
  chatImports: {
    choose: async ({ source, mode }: { source: ChatImportSource; mode: string }): Promise<ChatImportPreview | null> => {
      actions.push(['choose', source, mode]);
      if (cancel) { cancel = false; return null; }
      const batchId = `fixture-${++nextBatch}`;
      batches.set(batchId, source);
      return { batchId, fileCount: 2, expiresAt: Date.now() + 60_000, warnings: ['Attachments were kept as placeholders.'], candidates: [
        { id: 'new', source, format: format[source], title: source === 'opencode' ? 'OpenCode test project' : 'Build a small library', createdAt: Date.UTC(2026, 8, 20), messageCount: 4, toolCount: 1, alreadyImported: false },
        { id: 'old', source, format: source === 'claude' ? 'claude-code' : format[source], title: 'Already copied', createdAt: 0, messageCount: 2, toolCount: 0, alreadyImported: true },
      ] };
    },
    commit: async (input: { batchId: string; ids: string[]; projectId: string }) => {
      actions.push(['commit', input]);
      if (fail) { fail = false; throw new Error('Fixture disk full; no chats changed.'); }
      const source = batches.get(input.batchId)!;
      const imported: Thread = { id: source === 'codex' ? 'imported' : `imported-${source}`, title: source === 'opencode' ? 'OpenCode test project' : 'Build a small library', projectId: input.projectId, createdAt: 3,
        importedFrom: { source, format: format[source], externalId: 'fixture', importedAt: 5 },
        messages: [{ id: 'm1', role: 'user', content: 'A synthetic imported conversation.' }] };
      all = [...all, imported]; publish(all);
      return { importedThreadIds: [imported.id], skipped: 0 };
    },
    discard: async (id: string) => { actions.push(['discard', id]); },
  },
} as unknown as typeof window.electronAPI;

function Fixture() {
  const [source, setSource] = useState<ChatImportSource>('codex');
  const [page, setPage] = useState('developer');
  const [threads, setThreads] = useState(all);
  publish = setThreads;
  const [search, setSearch] = useState('');
  return <div className="flex h-screen bg-surface text-ink">
    <aside className="w-64 shrink-0 overflow-y-auto border-r border-line bg-surface-2">
      <button className="p-3 text-xs" onClick={() => setPage('developer')}>Developer</button>
      <input aria-label="Search fixture chats" value={search} onChange={(event) => setSearch(event.target.value)} className="mx-3 w-52 border border-line bg-surface p-2 text-xs" />
      <Sidebar threads={threads} projects={[{ id: 'inbox', name: 'Inbox', description: '' }]} pinned={[]} drafts={{ native: { text: 'Unsaved work', attachments: [] } }}
        activeProjectId="inbox" activeThreadId="native" search={search} onSelectThread={(id) => actions.push(['open', id])} onSelectProject={() => {}}
        onOpenPinned={() => {}} onUnpin={() => {}} onDeleteThread={(id) => actions.push(['delete', id])} onRenameThread={(id, title) => actions.push(['rename', id, title])}
        onPinThread={(id, pinned) => actions.push(['pin', id, pinned])} onImportChats={(next) => { setSource(next); setPage('imports'); }} />
    </aside>
    <main className="relative min-w-0 flex-1">{page === 'developer' ? <DeveloperPage onClose={() => setPage('imports')} />
      : <ImportChatsPage key={source} source={source} projectId="inbox" threadCount={threads.length} projects={[{ id: 'inbox', name: 'Inbox', description: '' }]}
        onClose={() => setPage('developer')} onOpenThread={(id) => actions.push(['open', id])} />}</main>
  </div>;
}
Object.assign(window, { importSmoke: {
  actions, copy, expectedPrompt: MODEL_TEST_PROMPTS[0].prompt,
  cancel: () => { cancel = true; }, fail: () => { fail = true; }, failCopy: () => { failCopy = true; },
  light: () => applyDisplacerTokens({ theme: 'light', secondaryAccent: '#629cf5' }),
} });
applyDisplacerTokens();
createRoot(document.getElementById('root')!).render(<Fixture />);
