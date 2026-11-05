import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { TerminalSessionInfo } from '../../types';
import { matchingShell, terminalTail, type TerminalChunk } from './replay';
import { followTerminalAppearance, terminalThemeFor } from './theme';
import { getAppearance } from '../../appearance';

/** Detached xterms survive panel hides and moves; selecting a session never runs a command. */
export const FONT_STACK = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export interface TerminalSession {
  id: string;
  info: TerminalSessionInfo;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  stopRequested: boolean;
  focusOnMount: boolean;
  error: string;
  offset: number;
  used: number;
  pending: TerminalChunk[] | null;
  pendingChars: number;
  overflow: boolean;
  stopAppearance: () => void;
}
export interface TerminalSnapshot { selected: TerminalSession | null; entries: readonly TerminalSessionInfo[] }

const screens = new Map<string, TerminalSession>();
const attaching = new Map<string, Promise<TerminalSession>>();
const manualStarts = new Map<string, Promise<TerminalSession>>();
const exits = new Map<string, { code: number; signal?: number }>();
const listeners = new Set<() => void>();
let entries: TerminalSessionInfo[] = [];
let selectedId: string | null = null;
let selection = 0;
let pendingSelections = 0;
let pendingExplicitSelections = 0;
let refreshing: Promise<void> | null = null;
let snapshot: TerminalSnapshot = { selected: null, entries };
let wired = false;
const MAX_SCREENS = 8;
const MAX_PENDING_CHARS = 500_000;

export const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const current = (): TerminalSession | null => selectedId ? screens.get(selectedId) ?? null : null;
export const hasPendingSelection = (): boolean => pendingSelections > 0;
export const getSnapshot = (): TerminalSnapshot => snapshot;
const announce = () => { snapshot = { selected: current(), entries }; for (const listener of listeners) listener(); };
const errorText = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

function remember(info: TerminalSessionInfo): void {
  const live = screens.get(info.id);
  const knownExit = info.exit ?? exits.get(info.id) ?? live?.info.exit ?? null;
  const next = { ...info, exit: knownExit, privateInput: !!info.privateInput || !!live?.info.privateInput };
  if (live) live.info = next;
  entries = [...entries.filter((entry) => entry.id !== info.id), next].sort((a, b) => b.startedAt - a.startedAt);
}

function output(live: TerminalSession, chunk: TerminalChunk): void {
  const next = terminalTail(chunk, live.offset);
  if (next.data) live.term.write(next.data);
  live.offset = next.offset;
}

/** Subscribe before requesting history. The snapshot offset separates replay from live data. */
function wire(): void {
  if (wired) return;
  wired = true;
  window.electronAPI.onTerminalData(({ id, data, offset }) => {
    const live = screens.get(id);
    if (!live) return;
    if (live.pending) {
      live.pending.push({ data, offset }); live.pendingChars += data.length;
      if (live.pendingChars > MAX_PENDING_CHARS) { live.pending = []; live.pendingChars = 0; live.overflow = true; }
    } else output(live, { data, offset });
  });
  window.electronAPI.onTerminalExit(({ id, code, signal }) => {
    exits.set(id, { code, signal });
    if (exits.size > 256) exits.delete(exits.keys().next().value!);
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry) { remember({ ...entry, exit: { code, signal } }); announce(); }
  });
}

export async function refresh(): Promise<void> {
  wire();
  if (refreshing) return refreshing;
  refreshing = window.electronAPI.terminal.list().then((next) => {
    // Keep stopped/cached screens reachable even if main removed their PTY. Never kill an
    // unselected terminal to make the menu shorter; pruning a screen only disposes xterm.
    const ids = new Set(next.map((entry) => entry.id));
    entries = entries.filter((entry) => !ids.has(entry.id) && screens.has(entry.id));
    for (const entry of next) remember(entry);
    announce();
  }).finally(() => { refreshing = null; });
  return refreshing;
}

function prune(): void {
  for (const live of [...screens.values()].sort((a, b) => a.used - b.used)) {
    if (screens.size <= MAX_SCREENS) break;
    if (live.id === selectedId || attaching.has(live.id)) continue;
    live.stopAppearance(); live.term.dispose(); screens.delete(live.id);
  }
}

async function attach(info: TerminalSessionInfo): Promise<TerminalSession> {
  const pending = attaching.get(info.id);
  if (pending) return pending;
  const existing = screens.get(info.id);
  if (existing) { existing.used = Date.now(); return existing; }
  wire(); remember(info);
  const term = new Terminal({ fontFamily: FONT_STACK, fontSize: 12, lineHeight: 1.25, theme: terminalThemeFor(getAppearance()),
    cursorBlink: true, scrollback: 5000, allowProposedApi: true, allowTransparency: false });
  const fit = new FitAddon(); term.loadAddon(fit);
  const host = document.createElement('div'); host.style.width = '100%'; host.style.height = '100%'; term.open(host);
  const live: TerminalSession = { id: info.id, info: entries.find((entry) => entry.id === info.id)!, term, fit, host,
    stopRequested: false, focusOnMount: false, error: '', offset: 0, used: Date.now(), pending: [], pendingChars: 0, overflow: false,
    stopAppearance: followTerminalAppearance(term) };
  screens.set(info.id, live);
  const loading = (async () => {
    try {
      let history: { data: string; offset: number } | undefined;
      // A noisy process cannot grow an unbounded replay queue while IPC is in flight. Fetch a
      // newer snapshot if it overran the buffer; fail visibly if it continuously outruns us.
      for (let pass = 0; pass < 3; pass++) {
        live.pending = []; live.pendingChars = 0; live.overflow = false;
        history = await window.electronAPI.terminal.snapshot(info.id);
        if (!live.overflow) break;
        history = undefined;
      }
      if (!history) throw new Error('Terminal output is arriving too quickly to restore. Select the session again to retry.');
      term.write(history.data); live.offset = history.offset;
      for (const chunk of live.pending ?? []) output(live, chunk);
      live.pending = null;
      term.onData((data) => {
        if (live.info.exit) return;
        // Mark the privacy boundary immediately, without retaining or inspecting what was typed.
        if (live.info.kind === 'command' && !live.info.privateInput) { remember({ ...live.info, privateInput: true }); announce(); }
        void window.electronAPI.terminal.write(info.id, data).catch((failure) => { live.error = errorText(failure); announce(); });
      });
      term.onResize(({ cols, rows }) => {
        if (!live.info.exit) void window.electronAPI.terminal.resize(info.id, cols, rows).catch(() => {});
      });
      return live;
    } catch (failure) {
      screens.delete(info.id); live.stopAppearance(); term.dispose(); throw failure;
    } finally { attaching.delete(info.id); }
  })();
  attaching.set(info.id, loading);
  return loading;
}

/** Opens this exact session, including an exited command. Never starts or retries its process. */
export async function select(id: string, options: { automatic?: boolean } = {}): Promise<TerminalSession> {
  // An incoming command must not cancel the user's still-loading picker choice.
  const ticket = options.automatic && pendingExplicitSelections > 0 ? -1 : ++selection;
  if (!options.automatic) pendingExplicitSelections++;
  pendingSelections++;
  try {
    await refresh();
    let info = entries.find((entry) => entry.id === id);
    // We may have joined a poll whose host snapshot predates the command announcement.
    if (!info) { await refresh(); info = entries.find((entry) => entry.id === id); }
    if (!info) throw new Error('That terminal session is no longer available.');
    const protectedSelection = () => {
      const selected = current();
      return selected && !selected.info.exit && (selected.info.privateInput || selected.host.contains(document.activeElement)) ? selected : null;
    };
    const protectedBefore = options.automatic ? protectedSelection() : null;
    if (protectedBefore) return protectedBefore;
    const live = await attach(info);
    // Fetching history is asynchronous: typing may have started after the first check.
    const protectedAfter = options.automatic ? protectedSelection() : null;
    if (protectedAfter) return protectedAfter;
    if (ticket === selection) { selectedId = id; live.used = Date.now(); live.focusOnMount = !options.automatic; announce(); prune(); }
    return live;
  } finally { pendingSelections--; if (!options.automatic) pendingExplicitSelections--; prune(); }
}

async function manual(cwd: string | null, force: boolean, expectedSelection?: number): Promise<TerminalSession> {
  const ticket = expectedSelection !== undefined && expectedSelection !== selection ? -1 : ++selection;
  pendingExplicitSelections++;
  const key = cwd ?? '';
  let pending = !force ? manualStarts.get(key) : undefined;
  if (!pending) {
    pending = (async () => {
      await refresh();
      const adopt = !force ? matchingShell(entries.filter((entry) => !screens.get(entry.id)?.stopRequested), cwd) : undefined;
      const info = adopt ?? await window.electronAPI.terminal.create({ cwd, cols: 80, rows: 24 });
      remember(info);
      return attach(info);
    })();
    manualStarts.set(key, pending);
    void pending.finally(() => { if (manualStarts.get(key) === pending) manualStarts.delete(key); }).catch(() => {});
  }
  try {
    const live = await pending;
    if (ticket === selection) { selectedId = live.id; live.focusOnMount = true; announce(); prune(); }
    return live;
  } finally { pendingExplicitSelections--; prune(); }
}

/** Chooses only a live manual shell at the requested cwd, never a foreground agent command. */
export const start = (cwd: string | null): Promise<TerminalSession> => manual(cwd, false);

/** Explicitly stops only the selected process. Its screen stays available for inspection. */
export async function stop(id = selectedId): Promise<void> {
  if (!id) return;
  await window.electronAPI.terminal.kill(id);
  const live = screens.get(id);
  if (live) { live.stopRequested = true; announce(); }
  await refresh();
}

/** Restart is available only for manual shells, never an agent's command. */
export async function restart(): Promise<TerminalSession> {
  const live = current();
  if (!live || live.info.kind === 'command') throw new Error('Only a manual shell can be restarted. Agent commands are not re-executed.');
  const cwd = live.info.cwd;
  const ticket = selection;
  await stop(live.id);
  return manual(cwd, true, ticket);
}
