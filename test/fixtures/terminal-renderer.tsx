import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { TerminalSessionInfo } from '../../renderer/src/types';
import { TerminalPanel } from '../../renderer/src/plugins/terminal/TerminalPanel';
import { ShellProvider } from '../../renderer/src/plugins/shell';
import * as terminal from '../../renderer/src/plugins/terminal/session';
import { initializeAppearance, saveAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE, type AppearanceAPI, type AppearanceSettings } from '../../src/api/appearance';

let appearance = { ...DEFAULT_APPEARANCE };
const appearanceListeners = new Set<(settings: AppearanceSettings) => void>();
const appearanceAPI: AppearanceAPI = {
  initial: appearance,
  get: async () => appearance,
  update: async (patch) => {
    appearance = { ...appearance, ...patch };
    for (const listener of appearanceListeners) listener(appearance);
    return appearance;
  },
  onChanged: (listener) => { appearanceListeners.add(listener); return () => { appearanceListeners.delete(listener); }; },
};
initializeAppearance(appearanceAPI);

const entry = (id: string, patch: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo => ({ id, kind: 'shell', shell: '/bin/bash', cwd: '/workspace/antimatter', cols: 80, rows: 24, startedAt: 1, exit: null, ...patch });
const entries = [entry('manual'), entry('other', { cwd: '/workspace/other' }), entry('command', { kind: 'command', command: 'sudo example-command --verify', startedAt: 3 }), entry('done', { kind: 'command', command: 'npm test', exit: { code: 0 }, startedAt: 2 })];
const history = new Map([['manual', '$ '], ['other', 'other workspace\r\n$ '], ['command', 'Starting verification\r\n'], ['done', 'Tests passed\r\n']]);
const dataListeners = new Set<(chunk: { id: string; data: string; offset: number }) => void>();
const exitListeners = new Set<(exit: { id: string; code: number }) => void>();
const metrics = { created: [] as string[], killed: [] as string[], writeIds: [] as string[] };
const snapshotHolds = new Map<string, { promise: Promise<void>; release(): void }>();
let listHold: { promise: Promise<void>; release(): void } | null = null;
let releaseList = () => {};
const hold = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };
const emit = (id: string, data: string) => {
  const next = (history.get(id) ?? '') + data; history.set(id, next);
  for (const listener of dataListeners) listener({ id, data, offset: next.length });
};
let firstReplay = true;
window.electronAPI = {
  terminal: {
    list: async () => { const snapshot = entries.map((info) => ({ ...info })); const pending = listHold; listHold = null; if (pending) await pending.promise; return snapshot; },
    create: async ({ cwd }: { cwd?: string | null }) => {
      const info = entry(`created-${metrics.created.length}`, { cwd: cwd || '/home/fixture' }); entries.push(info); history.set(info.id, '$ '); metrics.created.push(info.id); return info;
    },
    snapshot: async (id: string) => {
      if (id === 'command' && firstReplay) {
        firstReplay = false; emit(id, 'Before snapshot\r\n');
        const snapshot = { data: history.get(id)!, offset: history.get(id)!.length };
        emit(id, '[sudo] password for tester: ');
        await new Promise((resolve) => setTimeout(resolve, 30));
        return snapshot;
      }
      const snapshot = { data: history.get(id) ?? '', offset: history.get(id)?.length ?? 0 };
      const pending = snapshotHolds.get(id); if (pending) await pending.promise;
      return snapshot;
    },
    write: async (id: string, _data: string) => { metrics.writeIds.push(id); const info = entries.find((item) => item.id === id); if (info?.kind === 'command') info.privateInput = true; },
    resize: async () => {},
    kill: async (id: string) => {
      metrics.killed.push(id);
      if (id === 'command' && metrics.killed.filter((item) => item === id).length === 1) return;
      const info = entries.find((item) => item.id === id); if (info) info.exit = { code: 143 };
      for (const listener of exitListeners) listener({ id, code: 143 });
    },
  },
  onTerminalData: (listener: (chunk: { id: string; data: string; offset: number }) => void) => { dataListeners.add(listener); return () => dataListeners.delete(listener); },
  onTerminalExit: (listener: (exit: { id: string; code: number }) => void) => { exitListeners.add(listener); return () => exitListeners.delete(listener); },
} as unknown as typeof window.electronAPI;

let show: (value: boolean) => void;
let move: () => void;
function Fixture() {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState(0);
  show = setVisible; move = () => setPosition((value) => value + 1);
  return <ShellProvider value={{ workspace: '/workspace/antimatter', conversation: null, sources: { providers: [], activeProviderId: '', activeModelId: '' }, selectProvider: () => {}, openPage: () => {}, openModelLibrary: () => {} }}>
    <div style={{ padding: 20, height: '100vh', background: 'rgb(var(--color-surface))', color: 'rgb(var(--color-ink))' }}>
      <div style={{ height: 28, fontFamily: 'system-ui', fontSize: 12 }}>Terminal · isolated sample session</div>
      {visible && <div key={position} style={{ height: 'calc(100% - 28px)', border: '1px solid #333', borderRadius: 10, overflow: 'hidden' }}><TerminalPanel visible /></div>}
    </div>
  </ShellProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
Object.assign(window, { terminalSmoke: {
  metrics, show: (value: boolean) => show(value), move: () => move(),
  select: async (id: string, automatic = false) => { await terminal.select(id, { automatic }); return true; },
  start: async (cwd: string | null) => { await terminal.start(cwd); return true; },
  restart: async () => { await terminal.restart(); return true; },
  refresh: async () => { await terminal.refresh(); return true; },
  addCommand: (id: string) => { entries.push(entry(id, { kind: 'command', command: `example-${id}`, startedAt: 5 })); history.set(id, `${id} output\r\n`); },
  holdSnapshot: (id: string) => { snapshotHolds.set(id, hold()); },
  releaseSnapshot: (id: string) => { snapshotHolds.get(id)?.release(); snapshotHolds.delete(id); },
  holdList: () => { listHold = hold(); releaseList = listHold.release; },
  releaseList: () => releaseList(),
  current: () => terminal.current()?.id,
  text: () => { const buffer = terminal.current()?.term.buffer.active; return buffer ? Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true)).join('\n') : ''; },
  input: () => terminal.current()?.term.input('synthetic-input\r', true),
  emit, sameHost: () => terminal.current()?.host,
  sameTerminal: () => terminal.current()?.term,
  appearance: async (settings: AppearanceSettings) => { await saveAppearance(settings); return true; },
  theme: () => terminal.current()?.term.options.theme,
} });
