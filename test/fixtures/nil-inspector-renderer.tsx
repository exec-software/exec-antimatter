import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NilInspector } from '../../renderer/src/environment/NilInspector';
import { initializeAppearance, saveAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE, type AppearanceSettings } from '../../src/api/appearance';
import type { NyModuleInspection } from '../../src/api/nyInspector';

initializeAppearance({ initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, update: async (patch) => ({ ...DEFAULT_APPEARANCE, ...patch }), onChanged: () => () => {} });
const module: NyModuleInspection = {
  path: 'build/main.nil', modified: 1, format: 'binary', version: 5, flags: 0, byteLength: 8192, moduleName: 'demo', library: false, debugInfo: true,
  functions: [{ name: 'demo.main', parameters: ['count: i32'], generics: [], returnType: 'i32', inline: false, test: false, declarationLine: 1, annotations: ['@doc("Main function")'],
    instructions: Array.from({ length: 120 }, (_, offset) => ({ offset, opcode: offset === 119 ? 'RET' : 'PUSH', operands: [`needle${offset}`], debugLine: offset + 3,
      source: offset === 1 ? { path: '/external/source.ny', line: 4 } : { path: '/original/src/main.ny', workspacePath: 'src/main.ny', line: offset + 3 },
      ...(offset === 0 ? { locals: [{ name: 'count', storage: '%slot0', type: 'i32', depth: 1 }] } : {}),
    })),
  }, { name: 'demo.helper', parameters: [], generics: ['T'], returnType: 'void', inline: true, test: true, declarationLine: 8, annotations: [], instructions: [{ offset: 0, opcode: 'RET', operands: [], debugLine: 0 }] }],
  constants: [{ name: 'MESSAGE', value: '<img src=x onerror="window.injected=true">', byteLength: 45, encoding: 'utf8' }, { name: 'RAW', value: 'ff00', byteLength: 2, encoding: 'hex' }],
  types: [{ kind: 'class', name: 'Point', bases: ['Object'], members: [{ name: 'x', type: 'i32' }], methods: [{ name: 'describe', implementation: 'Point.describe', receiverType: 'Point', returnType: 'text', virtual: true, abstract: false, parameters: ['self'] }] }],
  tests: ['demo.helper'], embeddedSources: [{ path: 'stdlib/core.ny', byteLength: 128 }], dependencies: ['ny.core'], warnings: ['Structural inspection does not execute or verify a module.'],
};
const reveals: { path: string; line: number }[] = [];
const calls: string[] = [];
let pending: ((value: NyModuleInspection) => void) | null = null;
let rejectFile = true;
window.electronAPI = { ny: { inspectNil: async (path: string) => {
  calls.push(path);
  if (path === 'slow.nil') return new Promise<NyModuleInspection>((resolve) => { pending = resolve; });
  if (path === 'broken.nil' && rejectFile) throw new Error('Unsupported NIL version 99');
  return { ...module, path, moduleName: path === 'other.nil' ? 'other-module' : 'demo' };
} } } as unknown as typeof window.electronAPI;

let setPath: (path: string) => void;
let refresh: () => void;
function Fixture() {
  const [path, updatePath] = useState('build/main.nil');
  const [revision, setRevision] = useState(0);
  setPath = updatePath; refresh = () => setRevision((value) => value + 1);
  return <div style={{ height: '100vh', display: 'flex' }}><NilInspector path={path} refreshKey={revision} onReveal={(path, line) => reveals.push({ path, line })} /></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
Object.assign(window, { nilInspectorSmoke: {
  open: (path: string) => setPath(path), refresh: () => refresh(),
  release: () => { pending?.({ ...module, path: 'slow.nil', moduleName: 'STALE MODULE' }); pending = null; },
  repair: () => { rejectFile = false; },
  appearance: (settings: AppearanceSettings) => saveAppearance(settings),
  search: (value: string) => {
    const input = document.querySelector('[aria-label="Search NIL"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },
  click: (label: string) => {
    const button = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label || button.textContent?.trim() === label || button.getAttribute('title') === label);
    if (!button || button.disabled) throw new Error(`Button unavailable: ${label}`);
    button.click();
  },
  tab: (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.startsWith(label));
    if (!button) throw new Error(`Tab missing: ${label}`);
    button.click();
  },
  snapshot: () => ({ text: document.body.textContent, calls, reveals, instructions: [...document.querySelectorAll('[data-nil-instruction]')].map((node) => Number(node.getAttribute('data-nil-instruction'))),
    injectedImages: document.querySelectorAll('img').length, editor: document.querySelector('.cm-editor') !== null,
    mappedButtons: [...document.querySelectorAll('button')].filter((button) => button.textContent?.includes('/external/')).length }),
} });
