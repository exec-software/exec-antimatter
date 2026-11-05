import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AtlasView } from '../../renderer/src/components/views/AtlasView';
import { ConversationUiProvider } from '../../renderer/src/components/chat/conversationUi';
import { initializeAppearance, saveAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';
import type { Message, ToolActivity } from '../../renderer/src/types';

initializeAppearance({ initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, update: async (patch) => ({ ...DEFAULT_APPEARANCE, ...patch }), onChanged: () => () => {} });
const calls: unknown[] = [];
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { calls.push(['copy', text]); } } });
const initial: Message[] = [
  { id: 'u1', role: 'user', content: 'Map the launch plan for the Ny workspace. Keep the editor, runtime, and release checks easy to follow.', meta: { createdAt: 1760000000000 } },
  { id: 'a1', role: 'assistant', content: '## A small, verifiable launch\n\nThe editor, language tools, and runtime form three separate checks. Each should have a clear owner and an observable result.\n\n| Area | Check | Evidence |\n| --- | --- | --- |\n| Editor | Complete and navigate | A working source file |\n| Runtime | Build and run | Captured output |\n| Release | Install and reopen | A clean setup |\n\nStart with a small project so failures remain easy to isolate.', meta: { createdAt: 1760000001000, finishedAt: 1760000003000, modelId: 'qwen3-coder-next' } },
  { id: 'u2', role: 'user', content: 'Use this checklist as the project brief.', attachments: [{ id: 'brief', name: 'launch-checklist.md', size: 256, content: 'Synthetic launch brief' }] },
  { id: 'a2', role: 'assistant', content: 'The checklist is attached to this exchange.\n\n```ny\nfn main() -> i32\n    println("Ready")\n    return 0\nend fn\n```\n\nThe starter above prints a single line and exits.', meta: { createdAt: 1760000100000, finishedAt: 1760000102000 } },
  { id: 'u3', role: 'user', content: 'Which parts of the workspace should we inspect before a build?' },
  { id: 'a3', role: 'assistant', content: 'Check the project manifest, source entry point, and output folder.\n\n- The manifest names the build inputs.\n- The entry point defines the executable.\n- The output folder contains the fresh artifact.\n\nThese are places to inspect, not a claim that the checks have already run.', meta: { createdAt: 1760000200000, finishedAt: 1760000202000 } },
  { id: 'u4', role: 'user', content: 'Record the build steps, then run the verification command.' },
  { id: 'a4', role: 'assistant', content: '## Build verification\n\nI have prepared the command and am waiting for approval.\n\nThe command uses the project’s existing check script.', meta: { createdAt: Date.now() - 30_000, modelId: 'qwen3-coder-next', tools: [] } },
];
const approval: ToolActivity = { callId: 'build-check', approvalId: 'approval-build-check', requestId: 'a4', activityId: 'build-check-1', contentOffset: initial[7].content.length,
  serverId: 'workspace', serverName: 'Workspace', toolName: 'run_command', tier: 'danger', args: '{"command":"npm run check"}', status: 'pending', awaitingApproval: true };
initial[7].meta!.tools = [approval];
let mutate: (update: (messages: Message[]) => Message[]) => void;
let setStreaming: (value: boolean) => void;
window.electronAPI = { tools: { approve: async (id: string, accepted: boolean) => {
  calls.push(['approval', id, accepted]);
  mutate((messages) => messages.map((message) => message.id !== 'a4' ? message : { ...message, meta: { ...message.meta!, tools: message.meta!.tools!.map((tool) => ({ ...tool, awaitingApproval: false, status: accepted ? 'done' : 'denied', result: accepted ? 'Synthetic checks passed' : 'Declined' })) } }));
  return true;
} } } as unknown as typeof window.electronAPI;

function Fixture() {
  const [messages, setMessages] = useState(initial); mutate = setMessages;
  const [streaming, updateStreaming] = useState(true); setStreaming = updateStreaming;
  const [pins, setPins] = useState(new Set(['a1']));
  return <ConversationUiProvider value={{ assistantName: 'Nova', importedHistory: true, activeWorkspace: null, waitingOnAgents: false, reasoning: () => '',
    openSubagent: (id) => calls.push(['subagent', id]), openPreview: (preview) => calls.push(['preview', preview]) }}>
    <div className="h-screen bg-surface text-ink"><div style={{ display: 'flex', height: 48, alignItems: 'center', padding: '0 20px' }} className="border-b border-line text-sm text-ink-2">Ny workspace <span className="ml-auto text-xs text-ink-3">Atlas view</span></div>
      <main className="relative" style={{ height: 'calc(100vh - 48px)' }}><AtlasView messages={messages} isStreaming={streaming} pinnedMessageIds={pins}
        onTogglePin={(message) => { calls.push(['pin', message.id]); setPins((current) => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; }); }} /></main>
    </div>
  </ConversationUiProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent?.trim() === label);
Object.assign(window, { atlasSmoke: {
  appearance: saveAppearance,
  click: (label: string) => { const element = button(label); if (!element || element.disabled) throw new Error(`Unavailable button: ${label}`); element.click(); },
  exchange: (number: number) => { const element = document.querySelector<HTMLButtonElement>(`button[aria-label^="Open exchange ${number}:"]`); if (!element) throw new Error(`Exchange unavailable: ${number}`); element.click(); },
  keyOnExchange: (key: string) => { const element = document.querySelector<HTMLButtonElement>('button[aria-current="true"]')!; element.focus(); element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); },
  tabKey: (key: string) => { const element = document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!; element.focus(); element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); },
  search: (value: string) => { const element = document.querySelector<HTMLInputElement>('[aria-label="Search Atlas"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); },
  append: (content = '\n\nA new recorded update.') => mutate((messages) => messages.map((message) => message.id === 'a4' ? { ...message, content: message.content + content } : message)),
  empty: () => mutate(() => []), finish: () => setStreaming(false),
  scroll: (where: 'top' | 'bottom') => { const element = document.querySelector<HTMLElement>('[role="tabpanel"]')!; element.scrollTop = where === 'top' ? 0 : element.scrollHeight; element.dispatchEvent(new Event('scroll')); },
  snapshot: () => { const panel = document.querySelector<HTMLElement>('[role="tabpanel"]'); const nav = document.querySelector<HTMLElement>('[aria-label="Conversation map"]'); return {
    text: document.body.textContent, calls, panel: panel?.textContent, panels: document.querySelectorAll('[role="tabpanel"]').length,
    selected: document.querySelector('[aria-current="true"]')?.getAttribute('aria-label'), tab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    focus: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.getAttribute('role'),
    search: document.querySelector<HTMLInputElement>('[aria-label="Search Atlas"]')?.value,
    matches: document.querySelectorAll('.atlas-exchange').length, navVisible: nav ? getComputedStyle(nav).display !== 'none' : false,
    documentOverflow: document.documentElement.scrollWidth > innerWidth,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
    approvals: [...document.querySelectorAll('button')].filter((element) => element.textContent?.trim() === 'Allow').length,
    scroll: panel ? { top: panel.scrollTop, remaining: panel.scrollHeight - panel.scrollTop - panel.clientHeight } : null,
  }; },
} });
