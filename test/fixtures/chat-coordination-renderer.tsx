import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatCoordinationPanel } from '../../renderer/src/components/ChatCoordinationPanel';
import { ChatHeader } from '../../renderer/src/components/layout/ChatHeader';
import { ChatComposer, type ChatComposerHandle } from '../../renderer/src/components/chat/ChatComposer';
import { IDLE_STATS } from '../../renderer/src/lib/liveTurns';
import { initializeAppearance, saveAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';
import type { ChatCoordinationAPI, ChatCoordinationMessage, ChatCoordinationState } from '../../src/api/chatCoordination';
import type { Draft } from '../../renderer/src/types';

initializeAppearance({ initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, update: async (patch) => ({ ...DEFAULT_APPEARANCE, ...patch }), onChanged: () => () => {} });
const titles: Record<string, string> = { a: 'Main implementation', b: 'API review', c: 'Other project', slow: 'Slow chat' };
const listeners = new Set<(event: { threadIds: string[] }) => void>();
const calls: string[] = []; const continuations: string[] = []; const opened: string[] = [];
let connected = false; let peerRunning = false; let failConnect = false; let slowConnect = false;
let pendingConnect: (() => void) | null = null; let pendingState: ((value: ChatCoordinationState) => void) | null = null;
let failCheckpoint = false;
const messages: ChatCoordinationMessage[] = [
  { id: 'in', sourceThreadId: 'b', targetThreadId: 'a', sourceTitle: titles.b, targetTitle: titles.a, sourceRunId: 'r1', createdAt: 1750000000000, status: 'queued', body: 'Review result: <img src=x onerror="window.injected=true">. Treat this as an agent note.' },
  { id: 'out', sourceThreadId: 'a', targetThreadId: 'b', sourceTitle: titles.a, targetTitle: titles.b, sourceRunId: 'r2', createdAt: 1750000000100, status: 'queued', body: 'Please check the API types.' },
  { id: 'delivered', sourceThreadId: 'b', targetThreadId: 'a', sourceTitle: titles.b, targetTitle: titles.a, sourceRunId: 'r3', createdAt: 1750000000200, status: 'delivered', body: 'Earlier note included in a turn.' },
];
const read = (threadId: string): ChatCoordinationState => ({
  threadId, workspace: threadId === 'c' ? null : '/project',
  peers: ['a', 'b'].includes(threadId) ? [{ id: threadId === 'a' ? 'b' : 'a', title: titles[threadId === 'a' ? 'b' : 'a'], directory: '/project', connected, running: peerRunning }] : [],
  messages: messages.filter((message) => message.sourceThreadId === threadId || message.targetThreadId === threadId).map((message) => ({ ...message })),
});
const api: ChatCoordinationAPI = {
  state: async (id) => { calls.push(`state:${id}`); if (id === 'slow') return new Promise((resolve) => { pendingState = resolve; }); return read(id); },
  connect: async (id, peer) => { calls.push(`connect:${id}:${peer}`); if (failConnect) throw new Error('The working folder changed.');
    if (slowConnect) await new Promise<void>((resolve) => { pendingConnect = resolve; }); connected = true; return read(id); },
  disconnect: async (id, peer) => { calls.push(`disconnect:${id}:${peer}`); connected = false; return read(id); },
  dismiss: async (id, noteId) => { calls.push(`dismiss:${id}:${noteId}`); const note = messages.find((message) => message.id === noteId); if (note?.targetThreadId === id && note.status === 'queued') note.status = 'dismissed'; return read(id); },
  onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
window.electronAPI = { chatCoordination: api } as typeof window.electronAPI;
const drafts: Record<string, Draft> = { a: { text: 'Keep my unsent draft', attachments: [{ id: 'draft-file', name: 'notes.txt', content: 'keep this too', size: 13 }] } };
let changeThread: (id: string) => void; let changeRunning: (value: boolean) => void; let toggleAPI: (value: boolean) => void;
function Fixture() {
  const [threadId, setThreadId] = useState('a'); const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(true); const [available, setAvailable] = useState(true);
  const [badge, setBadge] = useState({ id: '', count: 0 }); const composer = useRef<ChatComposerHandle>(null);
  changeThread = setThreadId; changeRunning = setRunning; toggleAPI = setAvailable;
  Object.assign(window, { coordinationDraft: () => composer.current?.currentDraft() });
  return <main className="flex h-screen flex-col bg-surface text-ink">
    <ChatHeader stats={IDLE_STATS} sessionStartedAt={Date.now()} error="" context={null} thread={null} source={null} viewMode="transcript" onChangeViewMode={() => {}}
      coordination={{ open, pending: badge.id === threadId ? badge.count : 0, onToggle: () => setOpen((value) => !value) }} />
    <div className="relative min-h-0 flex-1"><p className="p-6 text-sm text-ink-3">Conversation content</p>
      <ChatCoordinationPanel api={available ? api : undefined} threadId={threadId} threadTitle={titles[threadId]} workspaceKey={threadId === 'c' ? '' : '/project'} open={open} running={running} canContinue
        beforeLoad={async (id) => { calls.push(`checkpoint:${id}`); if (failCheckpoint) throw new Error('Could not save the working folder.'); }}
        onPendingChange={(id, count) => setBadge((current) => current.id === id && current.count === count ? current : { id, count })}
        onOpenThread={(id) => { opened.push(id); setThreadId(id); }} onContinue={() => { continuations.push('Continue with the notes from connected chats.'); setRunning(true); return true; }} onClose={() => setOpen(false)} />
    </div>
    <ChatComposer key={threadId} ref={composer} threadId={threadId} draft={drafts[threadId]} onDraftChange={(id, draft) => { drafts[id] = draft; }}
      onSubmit={() => { throw new Error('The coordination control must not submit the composer.'); }} onSteer={() => { throw new Error('Agent notes must not use human steer.'); }} streaming={running} onStop={() => setRunning(false)} providers={[]} providerId="" modelId=""
      access={{ mode: 'ask', directory: '/project' }} onChangeAccess={() => {}} onOpenModels={() => {}} workspace="/project" workspaceConfirmed onConfirmWorkspace={() => {}} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
Object.assign(window, { coordinationSmoke: {
  thread: (id: string) => changeThread(id), running: (value: boolean) => changeRunning(value), api: (value: boolean) => toggleAPI(value),
  failConnect: (value: boolean) => { failConnect = value; }, failCheckpoint: (value: boolean) => { failCheckpoint = value; },
  slowConnect: (value: boolean) => { slowConnect = value; }, releaseConnect: () => { pendingConnect?.(); pendingConnect = null; },
  releaseState: () => { pendingState?.({ ...read('slow'), workspace: '/STALE-FOLDER' }); pendingState = null; },
  peerRunning: (value: boolean) => { peerRunning = value; for (const listener of listeners) listener({ threadIds: ['b'] }); },
  appearance: saveAppearance,
  click: (label: string) => {
    const button = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label || button.textContent?.trim() === label || button.getAttribute('title') === label);
    if (!button || button.disabled) throw new Error(`Button unavailable: ${label}`); button.click();
  },
  snapshot: () => ({ text: document.body.textContent, calls, continuations, opened, images: document.querySelectorAll('img').length,
    draft: composerDraft(), badge: document.querySelector('button[aria-label^="Connected chats"]')?.getAttribute('aria-label'),
    buttons: [...document.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim()),
    alert: document.querySelector('[role="alert"]')?.textContent ?? null }),
} });
function composerDraft() { return (window as unknown as { coordinationDraft(): Draft }).coordinationDraft(); }
