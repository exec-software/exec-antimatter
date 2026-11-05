import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NyOutline } from '../../renderer/src/environment/NyOutline';
import { initializeAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';
import type { NyDocument } from '../../src/api/ny';

initializeAppearance({ initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, update: async () => DEFAULT_APPEARANCE, onChanged: () => () => {} });
const initial = { path: 'main.ny', text: 'fn alpha()\nend fn\nfn beta()\nend fn\n' };
let setFile: (file: typeof initial) => void;
let mode: 'immediate' | 'deferred' | 'error' = 'immediate';
let revealed: { path: string; line: number } | null = null;
const calls: NyDocument[] = [];
const pending: Array<() => void> = [];
const symbols = (text: string) => text.split('\n').flatMap((line, index) => {
  const name = line.match(/^fn (.+)\(/)?.[1];
  if (!name) return [];
  return [{ name, kind: 12, detail: `${name}()`, range: { start: { line: index, character: 0 }, end: { line: index, character: line.length } },
    selectionRange: { start: { line: index, character: 3 }, end: { line: index, character: 3 + name.length } } }];
});
window.electronAPI = { ny: { symbols: (document: NyDocument) => {
  calls.push(document);
  if (mode === 'error') return Promise.reject(new Error('Synthetic SDK unavailable'));
  if (mode === 'deferred') return new Promise((resolve) => pending.push(() => resolve(symbols(document.text))));
  return Promise.resolve(symbols(document.text));
} } } as unknown as typeof window.electronAPI;

function Fixture() {
  const [file, update] = useState(initial); setFile = update;
  return <div style={{ height: 520, width: 260, display: 'flex' }}><NyOutline file={file} onReveal={(path, line) => { revealed = { path, line }; }} /></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
Object.assign(window, { nyOutlineSmoke: {
  file: (path: string, text: string) => setFile({ path, text }),
  mode: (value: typeof mode) => { mode = value; },
  resolve: () => pending.shift()?.(),
  filter: (text: string) => {
    const input = document.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },
  snapshot: () => ({
    labels: [...document.querySelectorAll('li button')].map((button) => button.getAttribute('aria-label')),
    status: document.querySelector('[role=status]')?.textContent,
    error: document.querySelector('[role=alert]')?.textContent,
    revealed, calls, pending: pending.length,
  }),
} });
