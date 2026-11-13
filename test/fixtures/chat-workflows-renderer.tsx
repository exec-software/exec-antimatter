import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatNotesEditor } from '../../renderer/src/components/chat/ChatNotesEditor';
import { ChatNotesPanel } from '../../renderer/src/components/chat/ChatNotesPanel';
import { CarbonBadge } from '../../renderer/src/components/chat/CarbonBadge';
import { ViewModeSwitch } from '../../renderer/src/components/layout/ViewModeSwitch';
import { notesMarkdownHtml, notesDocumentMarkdown } from '../../renderer/src/components/chat/notesMarkdown';
import type { ViewMode } from '../../renderer/src/types';
import type { ChatNote, ChatNoteChange } from '../../src/api/chatNotes';

let markdown = '';
let update!: (text: string) => void;
let clipboard = '';
let exports: string[] = [];
let failClipboard = false;
const listeners = new Set<(change: ChatNoteChange) => void>();
const saved = new Map<string, ChatNote>();
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => {
  if (failClipboard) { throw new Error('Clipboard unavailable'); }
  clipboard = value;
} } });
window.electronAPI = {
  carbon: { export: async (id: string) => { exports.push(id); return { saved: true, path: '/fixture/carbon.md' }; } },
  chatNotes: {
    get: async (id: string) => saved.get(id) ?? { threadId: id, markdown: '', revision: 0, updatedAt: null },
    save: async (input) => {
      const current = saved.get(input.threadId) ?? { threadId: input.threadId, markdown: '', revision: 0, updatedAt: null };
      if (current.revision !== input.expectedRevision) { return { saved: false, reason: 'conflict', note: current }; }
      const note = { ...current, markdown: input.markdown, revision: current.revision + 1, updatedAt: Date.now() };
      saved.set(input.threadId, note);
      listeners.forEach((cb) => cb({ threadId: input.threadId, kind: 'saved', revision: note.revision }));
      return { saved: true, note };
    },
    onChanged: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  },
} as typeof window.electronAPI;
function Fixture() {
  const [value, setValue] = useState(''); markdown = value; update = setValue;
  const [mode, setMode] = useState<ViewMode>('transcript');
  const [notes, setNotes] = useState(false);
  return <main style={{ padding: 24 }}>
    <CarbonBadge threadId="7906ebbe-1111-2222-3333-444455556666" title="Full run" />
    <ViewModeSwitch value={mode} onChange={setMode} />
    <button onClick={() => setNotes(true)}>Open notes</button>
    <ChatNotesEditor value={value} onChange={setValue} />
    {notes && <ChatNotesPanel threadId="chat-a" title="Original chat" onClose={() => setNotes(false)} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
const rich = () => document.querySelector<HTMLElement>('[role="dialog"] [contenteditable]') ?? document.querySelector<HTMLElement>('main [contenteditable]')!;
Object.assign(window, { workflowSmoke: {
  update: (text: string) => update(text),
  richHtml: (html: string) => { const editor = rich(); editor.innerHTML = html; editor.dispatchEvent(new Event('input', { bubbles: true })); },
  richInput: () => rich().dispatchEvent(new Event('input', { bubbles: true })),
  roundtrip: (text: string) => { const element = document.createElement('div'); element.innerHTML = notesMarkdownHtml(text); const result = notesDocumentMarkdown(element); return { markdown: result, html: notesMarkdownHtml(result), original: notesMarkdownHtml(text) }; },
  select: (text: string) => {
    const editor = rich(); editor.focus();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent?.indexOf(text) ?? -1;
      if (start >= 0) {
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + text.length);
        const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); return;
      }
    }
    throw new Error(`Missing text ${text}`);
  },
  click: (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.getAttribute('aria-label') === label || item.textContent === label);
    if (!button || button.disabled) { throw new Error(`Missing button ${label}`); }
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); button.click();
  },
  carbon: (detail = 1) => document.querySelector('[aria-keyshortcuts="Shift+Enter"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail })),
  doubleCarbon: () => document.querySelector('[aria-keyshortcuts="Shift+Enter"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })),
  clipboardFailure: () => { failClipboard = true; },
  composition: (event: string) => rich().dispatchEvent(new CompositionEvent(event, { bubbles: true, data: '日本語' })),
  plainPaste: () => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', '<img src=x onerror=alert(1)>'); clipboardData.setData('text/html', '<img src=x onerror=alert(1)>');
    rich().dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  },
  snapshot: () => ({ markdown, clipboard, exports, text: document.body.innerText, rich: rich()?.innerHTML, selected: window.getSelection()?.toString(),
    active: document.activeElement?.getAttribute('aria-label'), saved: [...saved.values()], dialog: !!document.querySelector('[role="dialog"]'),
    mode: document.querySelector('button[aria-haspopup="menu"]')?.getAttribute('aria-label'),
    menu: [...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.getAttribute('aria-label')) }),
} });
