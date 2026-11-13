/** Real view components, isolated data and mocked IPC. No running application or user state. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ResearchView } from '../../renderer/src/components/views/ResearchView';
import { CodeView } from '../../renderer/src/components/views/CodeView';
import { FlowView } from '../../renderer/src/components/views/FlowView';
import { AtlasView } from '../../renderer/src/components/views/AtlasView';
import { ConversationOverlay } from '../../renderer/src/components/chat/ConversationOverlay';
import { conversationSubagents } from '../../renderer/src/lib/conversation';
import { ViewModeSwitch } from '../../renderer/src/components/layout/ViewModeSwitch';
import { ConversationUiProvider } from '../../renderer/src/components/chat/conversationUi';
import { initializeAppearance, saveAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';
import type { AgentTask, Message, ToolActivity, ViewMode } from '../../renderer/src/types';

initializeAppearance({ initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, update: async (patch) => ({ ...DEFAULT_APPEARANCE, ...patch }), onChanged: () => () => {} });
const effects: unknown[] = [];
let clipboard = '';
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => { clipboard = value; } }, configurable: true });
const now = Date.now();
let agentTask: AgentTask = { id: 'parser-check', agentId: 'reviewer', title: 'Check parser boundaries', prompt: 'Inspect parser boundary cases.',
  source: 'chat', state: 'running', workspace: '/fixture', parent: { threadId: 'fixture', messageId: 'a3' }, createdAt: now - 5000,
  startedAt: now - 5000, finishedAt: null, carbonId: null, schedule: null, dueAt: null, error: null, summary: null };
const subscribe = () => () => {};
window.electronAPI = {
  tools: { approve: async (...args: unknown[]) => { effects.push(['approve', ...args]); return true; } },
  onAgentsChanged: subscribe, onAgentContent: subscribe, onAgentActivity: subscribe,
  agents: {
    list: async () => [{ id: 'reviewer', name: 'Boundary reviewer', tags: ['review'], description: 'Synthetic review agent' }],
    tasks: async () => [agentTask], activity: async () => ({ active: [], counts: { queued: 0, running: agentTask.state === 'running' ? 1 : 0, done: 0, failed: 0, cancelled: agentTask.state === 'cancelled' ? 1 : 0 }, busy: false }),
    session: async () => ({ taskId: agentTask.id, path: null, markdown: null, transcript: { content: 'Checking empty input and nested expressions.', tools: [], sessionId: 'fixture-run', revision: 1 } }),
    sendMessage: async (...args: unknown[]) => { effects.push(['guidance', ...args]); },
    cancelTask: async (id: string) => { effects.push(['cancel-agent', id]); agentTask = { ...agentTask, state: 'cancelled', finishedAt: Date.now() }; return agentTask; },
  },
} as unknown as typeof window.electronAPI;
const activity = (id: string, status: ToolActivity['status'], patch: Partial<ToolActivity> = {}): ToolActivity => ({
  activityId: id, callId: id, requestId: 'a3', serverId: 'antimatter', serverName: 'Workspace tools', toolName: 'read_file',
  tier: 'read', args: '{"path":"src/parser.ny"}', status, contentOffset: 0, ...patch,
});
const original: Message[] = [
  { id: 'u1', role: 'user', content: 'Create a Ny parser and show me the TypeScript bridge.', meta: { createdAt: now - 120000 } },
  { id: 'a1', role: 'assistant', content: 'The parser keeps the syntax tree small and exposes a typed bridge.\n\n```ny\nfn parse(source: String) -> Tree {\n    return tokenize(source).tree()\n}\n```\n\n```ts\nexport const parse = (source: string) => ny.parse(source);\n```', meta: { createdAt: now - 119000, firstTokenAt: now - 118000, finishedAt: now - 111000, modelId: 'Qwen3-Coder-Next', sourceName: 'Local workstation', chunks: 70, tools: [activity('write-parser', 'done', { requestId: 'a1', toolName: 'write_file', tier: 'write', args: '{"path":"src/parser.ny"}', result: 'Parser saved.' })] } },
  { id: 'u2', role: 'user', content: 'Check the imported example.' },
  { id: 'a2', role: 'assistant', content: 'Historical example without timing data.\n\n~~~python\nprint("imported example")\n~~~', meta: { sourceName: 'Imported Codex history', tools: [activity('historical-approval', 'pending', { requestId: 'a2', awaitingApproval: true, approvalId: 'expired-approval', toolName: 'run_command', tier: 'danger', args: '{"command":"python example.py"}' })] } },
  { id: 'u3', role: 'user', content: 'Add tests, check edge cases, and run the suite.', meta: { createdAt: now - 15000 } },
  { id: 'a3', role: 'assistant', content: 'The test cases cover empty input and nested expressions.\n\n```ts\nconst cases = ["", "a + (b * c)"];', meta: { createdAt: now - 14000, modelId: 'Qwen3-Coder-Next', sourceName: 'Local workstation', tools: [
    activity('approval', 'pending', { awaitingApproval: true, approvalId: 'live-approval', toolName: 'run_command', tier: 'danger', args: '{"command":"npm test"}' }),
    activity('reading', 'running'),
    activity('failed', 'failed', { toolName: 'search_text', args: '{"query":"legacyParser"}', result: 'Directory was not found.' }),
    activity('write-tests', 'done', { toolName: 'write_file', tier: 'write', args: '{"path":"test/parser.test.ts"}', result: 'Test cases saved.' }),
  ] } },
];
let updateMessages: (change: Message[] | ((messages: Message[]) => Message[])) => void;
let updateStreaming: (value: boolean) => void;
let currentMessages = original;
const pinned = new Set(['a1']);
function Fixture() {
  const [mode, setMode] = useState<ViewMode>('research');
  const [messages, setMessages] = useState(original); updateMessages = setMessages; currentMessages = messages;
  const [streaming, setStreaming] = useState(true); updateStreaming = setStreaming;
  const [taskId, setTaskId] = useState<string | null>(null);
  const openSubagent = (id: string) => { effects.push(['agent', id]); setTaskId(id); };
  return <ConversationUiProvider value={{ assistantName: 'Ada', activeWorkspace: '/fixture', waitingOnAgents: false, reasoning: () => '', importedHistory: true,
    openSubagent, openPreview: (preview) => effects.push(['preview', preview]) }}>
    <div className="flex h-screen min-w-0 flex-col bg-surface text-ink">
      <header className="flex min-w-0 shrink-0 items-center gap-3 border-b border-line px-4 py-3"><span className="truncate text-sm font-semibold">Parser workspace</span><ViewModeSwitch value={mode} onChange={setMode} /></header>
      <main className="relative min-h-0 min-w-0 flex-1">
        {mode === 'research' ? <ResearchView messages={messages} isStreaming={streaming} pinnedMessageIds={pinned} />
          : mode === 'code' ? <CodeView messages={messages} />
          : mode === 'flow' ? <FlowView messages={messages} isStreaming={streaming} pinnedMessageIds={pinned} onTogglePin={(message) => effects.push(['pin', message.id])} />
          : mode === 'atlas' ? <AtlasView messages={messages} isStreaming={streaming} pinnedMessageIds={pinned} onTogglePin={(message) => effects.push(['pin', message.id])} />
          : <p className="p-6 text-sm text-ink-3">Transcript is unchanged.</p>}
        <ConversationOverlay panelShown={mode === 'transcript'} panelWidth={280} sheetWidth={420} messages={messages} isActive={streaming}
          taskId={taskId} subagent={conversationSubagents(messages).find((entry) => entry.taskId === taskId) ?? null}
          onOpenSubagent={openSubagent} onCloseSubagent={() => setTaskId(null)} onAttach={() => effects.push(['attach'])} />
      </main>
    </div>
  </ConversationUiProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
Object.assign(window, { viewSmoke: {
  appearance: saveAppearance,
  click: (label: string) => { const item = button(label); if (!item || item.disabled) throw new Error(`Unavailable button: ${label}`); item.click(); },
  focus: (label: string) => { const item = button(label); if (!item) throw new Error(`Unavailable focus: ${label}`); item.focus(); },
  input: (label: string, value: string) => { const item = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); if (!item) throw new Error(`Missing input: ${label}`); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(item, value); item.dispatchEvent(new Event('input', { bubbles: true })); },
  select: (label: string, value: string) => { const item = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`); if (!item) throw new Error(`Missing select: ${label}`); item.value = value; item.dispatchEvent(new Event('change', { bubbles: true })); },
  snippet: (index: number, focus = false) => { const item = document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Code snippets"] button')[index]; if (!item) throw new Error(`Missing snippet ${index}`); if (focus) item.focus(); else item.click(); },
  withAgent: () => updateMessages((messages) => messages.map((message) => message.id !== 'a3' ? message : { ...message, meta: { ...message.meta, tools: [...(message.meta?.tools ?? []),
    activity('agent-start', 'running', { toolName: 'start_agent', args: '{"agent":"reviewer","task":"Inspect parser boundary cases."}', subagent: { taskId: agentTask.id, agentId: agentTask.agentId, agentName: 'Boundary reviewer', title: agentTask.title } }),
  ] } })),
  openAgent: (focus = false) => { const item = document.querySelector<HTMLButtonElement>('button[title="Inspect parser boundary cases."]'); if (!item) throw new Error('Missing subagent row'); if (focus) item.focus(); else item.click(); },
  guidance: (value: string) => { const item = document.getElementById('agent-guidance-parser-check') as HTMLInputElement; if (!item) throw new Error('Missing agent guidance'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(item, value); item.dispatchEvent(new Event('input', { bubbles: true })); },
  append: (text: string) => updateMessages((messages) => messages.map((message) => message.id === 'a3' ? { ...message, content: message.content + text } : message)),
  streaming: (value: boolean) => updateStreaming(value),
  empty: () => { updateMessages([]); updateStreaming(false); },
  restore: () => { updateMessages(original); updateStreaming(true); },
  snapshot: () => ({
    text: document.body.innerText, clipboard, effects, messages: currentMessages.length,
    mode: document.querySelector('button[aria-label^="Chat view:"]')?.getAttribute('aria-label')?.replace('Chat view: ', ''),
    focus: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim(),
    modes: [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map((item) => ({ label: item.getAttribute('aria-label'), checked: item.getAttribute('aria-checked'), tab: item.tabIndex })),
    headers: [...document.querySelectorAll('th[scope="col"]')].map((item) => item.textContent?.trim()),
    researchRows: [...document.querySelectorAll('tbody > tr')].filter((item) => item.querySelector('button[aria-expanded]')).map((item) => ({ label: item.querySelector('button[aria-expanded]')?.getAttribute('aria-label'), cells: [...item.querySelectorAll('td')].map((cell) => cell.textContent?.trim()) })),
    expanded: [...document.querySelectorAll('tbody button[aria-expanded="true"]')].map((item) => item.getAttribute('aria-label')),
    sorted: document.querySelector('th[aria-sort="ascending"], th[aria-sort="descending"]')?.textContent?.trim(),
    direction: document.querySelector('th[aria-sort="ascending"], th[aria-sort="descending"]')?.getAttribute('aria-sort'),
    snippetCode: document.querySelector('section[aria-label="Selected code snippet"] pre code')?.textContent,
    snippetHeading: document.querySelector('section[aria-label="Selected code snippet"] h3')?.textContent,
    snippets: [...document.querySelectorAll('nav[aria-label="Code snippets"] button')].map((item) => ({ text: item.textContent?.trim(), active: item.getAttribute('aria-pressed') })),
    snippetLayout: (() => { const item = document.querySelector('nav[aria-label="Code snippets"]')?.parentElement; return item ? getComputedStyle(item).flexDirection : null; })(),
    codeCopyButtons: document.querySelectorAll('button[aria-label="Copy code"]').length,
    approvalGroups: document.querySelectorAll('[role="group"][aria-label^="Approval for "]').length,
    allowButtons: [...document.querySelectorAll('button')].filter((item) => item.textContent?.trim() === 'Allow').length,
    flowReply: document.querySelector<HTMLSelectElement>('[aria-label="Flow reply"]')?.value,
    flowLanes: [...document.querySelectorAll('section[aria-label^="Flow "]')].map((item) => ({ label: item.getAttribute('aria-label'), articles: item.querySelectorAll('article').length })),
    flowContent: document.querySelector('[aria-label="Flow reply content"]')?.textContent,
    conversationCard: !!document.querySelector('aside[aria-label="This conversation"]'),
    agentSheet: (() => { const item = document.querySelector<HTMLElement>('aside[aria-label="Boundary reviewer: Check parser boundaries"]'); if (!item) return null; const rect = item.getBoundingClientRect(); return { text: item.innerText, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, clipped: item.scrollWidth > item.clientWidth }; })(),
    accents: { primary: getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim(), accent: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(), selected: (() => { const item = document.querySelector('nav[aria-label="Code snippets"] [aria-pressed="true"]'); return item ? getComputedStyle(item).borderColor : null; })() },
    bodyOverflow: document.documentElement.scrollWidth > innerWidth,
    viewport: [innerWidth, innerHeight],
  }),
} });
