/** Real message bodies with synthetic history; parsing is counted by the smoke build wrapper. */
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MessageBody } from '../../renderer/src/components/chat/MessageBody';
import { ConversationUiProvider } from '../../renderer/src/components/chat/conversationUi';
import type { Message, ToolActivity } from '../../renderer/src/types';

const effects: unknown[] = [];
window.electronAPI = { tools: { approve: async (...args: unknown[]) => { effects.push(args); return true; } } } as unknown as typeof window.electronAPI;
const history: Message[] = Array.from({ length: 40 }, (_, index) => ({ id: `history-${index}`, role: 'assistant',
  content: `# History ${index}\n\nA **settled answer** with a [link](https://example.invalid).\n\n| Column | Value |\n| --- | --- |\n| Result | Ready |\n\n\`\`\`ts\nconst item = ${index};\n\`\`\``,
  meta: { createdAt: 1, finishedAt: 2 } }));
const initial: Message[] = [...history,
  { id: 'image', role: 'assistant', content: '# Image\n\n![historical image](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)' },
  { id: 'live', role: 'assistant', content: '# Live\n\nAnswer', meta: { createdAt: Date.now() } },
];
const approval: ToolActivity = { activityId: 'approval', callId: 'call', approvalId: 'approve-once', requestId: 'live', serverId: 'workspace',
  serverName: 'Workspace', toolName: 'run_command', tier: 'danger', status: 'pending', awaitingApproval: true, args: '{"command":"npm test"}', contentOffset: 0 };

function Fixture() {
  const [messages, setMessages] = useState(initial);
  const [thought, setThought] = useState('');
  const [imported, setImported] = useState(true);
  const [active, setActive] = useState(true);
  const [tick, setTick] = useState(0);
  Object.assign(window, { messageSmoke: {
    append: (text: string) => flushSync(() => setMessages((current) => current.map((message) => message.id === 'live' ? { ...message, content: message.content + text } : message))),
    think: (text: string) => flushSync(() => setThought(text)),
    parent: () => flushSync(() => setTick((current) => current + 1)),
    cloneHistory: () => flushSync(() => setMessages((current) => current.map((message) => ({ ...message })))),
    editHistory: () => flushSync(() => setMessages((current) => current.map((message) => message.id === 'history-3' ? { ...message, content: message.content + '\n\nEdited history.' } : message))),
    imported: (value: boolean) => flushSync(() => setImported(value)),
    approval: (status: 'pending' | 'done') => flushSync(() => setMessages((current) => current.map((message) => message.id === 'live' ? {
      ...message, meta: { ...message.meta, tools: [{ ...approval, status, awaitingApproval: status === 'pending', result: status === 'done' ? 'Tests passed.' : undefined }] },
    } : message))),
    active: (value: boolean) => flushSync(() => setActive(value)),
    click: (label: string) => {
      const button = Array.from(document.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === label || entry.getAttribute('aria-label') === label);
      if (!button) throw new Error(`Missing button: ${label}`);
      flushSync(() => button.click());
    },
    showThinking: () => {
      const button = Array.from(document.querySelectorAll('[data-message="live"] button')).find((entry) => entry.textContent?.includes('Thinking'));
      if (!(button instanceof HTMLButtonElement)) throw new Error('Missing live thinking');
      flushSync(() => button.click());
    },
    snapshot: () => ({
      parses: { ...(window as unknown as { markdownParses: Record<string, number> }).markdownParses },
      live: document.querySelector('[data-message="live"]')?.textContent,
      edited: document.querySelector('[data-message="history-3"]')?.textContent,
      imageCount: document.querySelectorAll('[data-message="image"] img').length,
      importedImage: document.querySelector('[data-message="image"]')?.textContent?.includes('not loaded'),
      allow: Array.from(document.querySelectorAll('[data-message="live"] button')).filter((button) => button.textContent?.trim() === 'Allow').length,
      effects,
    }),
  } });
  return <ConversationUiProvider value={{ assistantName: `Agent ${tick}`, activeWorkspace: '/fixture', importedHistory: imported,
    waitingOnAgents: false, reasoning: (id) => id === 'live' ? thought : '', openSubagent() {}, openPreview() {} }}>
    {messages.map((message) => <section key={message.id} data-message={message.id}><MessageBody message={message} isActive={message.id === 'live' && active} /></section>)}
  </ConversationUiProvider>;
}

flushSync(() => createRoot(document.getElementById('root')!).render(<Fixture />));
