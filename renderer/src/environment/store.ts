import { useEffect, useSyncExternalStore } from 'react';
import type { Breakpoint, DebugState, FileEntry, RunState } from '../types';
import type { NilProjectDescription, NilProjectLanguage, NilProjectTarget } from '../../../src/api/nilProject';
import type { NyBuildResult, NyDiagnostic, NyStatus } from '../../../src/api/ny';

/**
 * The environment's state: what is open, what is unsaved, and what is running.
 *
 * Outside React, like the plugin stores, because four separate regions read it — the tree, the
 * tabs, the toolbar and the floating assistant — and the assistant in particular is rendered in
 * a layer of its own so that it can sit over everything. There is no common ancestor to hang a
 * context on that would not also constrain where things can be drawn.
 */

export interface OpenFile {
  path: string;
  /** What is in the editor right now. */
  text: string;
  /** What was last read from or written to disk; the difference is the dirty flag. */
  saved: string;
  /** mtime at the last read or write, so a save can notice the file changed underneath. */
  modified: number;
  binary: boolean;
}

const NO_DEBUG: DebugState = {
  phase: 'stopped',
  reason: null,
  frames: [],
  variables: [],
  resolved: [],
  error: null,
};

export interface CodeWorkspaceContext {
  threadId: string | null;
  title: string;
  path: string | null;
  available: boolean;
  reason?: string;
  ready: boolean;
}
export interface CodeWorkspaceActions {
  chooseWorkspace(): Promise<string | null>;
  bindWorkspace(path: string): Promise<string | null>;
}

export interface EnvironmentState {
  root: string;
  ready: boolean;
  boundThreadId: string | null;
  boundChatTitle: string;
  pendingWorkspace: CodeWorkspaceContext | null;
  workspaceUnavailable: string | null;
  workspaceSwitching: boolean;
  /** Directory path → its children. Loaded a level at a time as things are expanded. */
  tree: Record<string, FileEntry[]>;
  expanded: string[];
  files: OpenFile[];
  activePath: string | null;
  /** Where the editor should scroll and flash, when something else chose the line. */
  reveal: { path: string; line: number } | null;
  breakpoints: Breakpoint[];
  command: string;
  run: RunState | null;
  nyBuilding: boolean;
  project: NilProjectDescription | null;
  projectLoading: boolean;
  projectError: string | null;
  target: NilProjectTarget;
  sdk: NyStatus | null;
  diagnostics: NyDiagnostic[];
  buildOutput: string;
  buildResult: NyBuildResult | null;
  task: 'check' | 'build' | 'run' | 'debug' | null;
  debug: DebugState;
  /** Console output since the last run started, as raw terminal bytes. */
  outputEpoch: number;
  busy: boolean;
  error: string;
}

const EMPTY: EnvironmentState = {
  root: '',
  ready: false,
  boundThreadId: null, boundChatTitle: '', pendingWorkspace: null, workspaceUnavailable: null, workspaceSwitching: false,
  tree: {},
  expanded: [],
  files: [],
  activePath: null,
  reveal: null,
  breakpoints: [],
  command: '',
  run: null,
  nyBuilding: false,
  project: null, projectLoading: false, projectError: null, target: 'vm', sdk: null,
  diagnostics: [], buildOutput: '', buildResult: null, task: null,
  debug: NO_DEBUG,
  outputEpoch: 0,
  busy: false,
  error: '',
};

let state = EMPTY;
let wired = false;
let workspaceVersion = 0;
let openRequest = 0;
let runRequest = 0;
let nyBuildVersion = 0;
let projectRequest = 0;
let workspaceContext: CodeWorkspaceContext | null = null;
let workspaceCallbacks: CodeWorkspaceActions | null = null;
let workspaceContextVersion = 0;
let workspaceContextKey = '';
let workspaceContextConfigured = false;
const contextKey = (context: CodeWorkspaceContext) => JSON.stringify([context.threadId, context.path, context.available, context.ready, context.reason]);
const hasWork = () => !!state.task || state.nyBuilding || !!(state.run && !state.run.exit) || state.debug.phase !== 'stopped';
export const environmentSnapshot = (): Readonly<EnvironmentState> => state;
const projectTargets = new Map<string, NilProjectTarget>();
const commands = new Map<string, string>();
const completedRuns = new Map<string, { code: number; signal?: number }>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());
const set = (patch: Partial<EnvironmentState>) => {
  state = { ...state, ...patch };
  emit();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

async function waitForWorkspaceSwitch(): Promise<void> {
  while (state.workspaceSwitching) await new Promise<void>(resolve => {
    const unsubscribe = subscribe(() => {
      if (!state.workspaceSwitching) { unsubscribe(); resolve(); }
    });
  });
}

/** Host binding events can reach React before the picker/bind IPC reply does. */
async function adoptChosenWorkspace(path: string, context: CodeWorkspaceContext | null, version: number): Promise<boolean> {
  const sameChoice = () => workspaceContext?.threadId === context?.threadId && workspaceContext?.path === path;
  const waitingForHost = workspaceContext?.threadId === context?.threadId && workspaceContext?.ready === false;
  if (version !== workspaceContextVersion && !sameChoice() && !waitingForHost) return false;
  if (workspaceContext && (version === workspaceContextVersion || waitingForHost)) {
    workspaceContext = { ...workspaceContext, path, available: true, ready: true, reason: undefined };
    // Keep the last prop key until React delivers the host's changed binding. A sync store
    // render can otherwise replay the old props before its queued setState is committed.
    workspaceContextVersion++;
  }
  if (workspaceContext) {
    await actions.switchWorkspace('preserve');
    await waitForWorkspaceSwitch();
    return sameChoice() && state.root === path && !state.pendingWorkspace;
  }
  return actions.open(path);
}

const api = () => window.electronAPI.environment;

const readable = (error: unknown): string =>
  (error as Error).message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

export const active = (): OpenFile | null =>
  state.files.find((file) => file.path === state.activePath) ?? null;

export const analysisDocuments = (): { path: string; text: string }[] => state.files
  .filter(file => !file.binary && /\.(ny|matrix|mat)$/i.test(file.path)).map(({ path, text }) => ({ path, text }));

export const isDirty = (file: OpenFile): boolean => file.text !== file.saved;

/** Paths whose editor buffers have not been written. Automatic restart treats these as blockers. */
export const dirtyFilePaths = (): string[] => state.files.filter(isDirty).map((file) => file.path);

/** Breakpoints for one file, which is what the editor gutter draws. */
export const breakpointsIn = (path: string): number[] =>
  state.breakpoints.filter((breakpoint) => breakpoint.file === path).map((breakpoint) => breakpoint.line);

/** Where execution is stopped, when it is stopped in the file on screen. */
export const pausedAt = (path: string): number | null => {
  if (state.debug.phase !== 'paused') return null;
  const frame = state.debug.frames.find((entry) => entry.id === state.debug.selectedFrameId) ?? state.debug.frames[0];
  return frame && frame.file === path ? frame.line : null;
};

const BREAKPOINTS_KEY = 'antimatter.environment.breakpoints';

/** Breakpoints outlive a session — losing them on every restart makes them not worth setting. */
function loadBreakpoints(root: string): Breakpoint[] {
  try {
    const stored = JSON.parse(localStorage.getItem(BREAKPOINTS_KEY) ?? '{}') as Record<string, Breakpoint[]>;
    return stored[root] ?? [];
  } catch {
    return [];
  }
}

function saveBreakpoints(root: string, breakpoints: Breakpoint[]): void {
  try {
    const stored = JSON.parse(localStorage.getItem(BREAKPOINTS_KEY) ?? '{}') as Record<string, Breakpoint[]>;
    localStorage.setItem(BREAKPOINTS_KEY, JSON.stringify({ ...stored, [root]: breakpoints }));
  } catch {
    // A browser that refuses storage is not a reason to refuse a breakpoint.
  }
}

export const actions = {
  /** Follow the active chat without discarding buffers or stopping tasks implicitly. */
  async followWorkspace(context: CodeWorkspaceContext, callbacks: CodeWorkspaceActions): Promise<void> {
    workspaceContextConfigured = true;
    workspaceCallbacks = callbacks;
    const key = contextKey(context);
    if (key === workspaceContextKey) {
      if (state.boundThreadId === context.threadId && state.boundChatTitle !== context.title) set({ boundChatTitle: context.title });
      return;
    }
    workspaceContext = context;
    workspaceContextKey = key;
    const version = ++workspaceContextVersion;
    if (!context.ready) { set({ pendingWorkspace: context }); return; }
    const changesRoot = !context.available || context.path !== state.root;
    if (state.root && changesRoot && (dirtyFilePaths().length || hasWork())) {
      set({ pendingWorkspace: context }); return;
    }
    await actions.switchWorkspace('preserve', version);
  },

  async switchWorkspace(choice: 'save' | 'discard' | 'preserve', expectedVersion = workspaceContextVersion): Promise<boolean> {
    const context = workspaceContext;
    if (!context?.ready || expectedVersion !== workspaceContextVersion || state.workspaceSwitching) return false;
    set({ workspaceSwitching: true, error: '' });
    try {
      const changesRoot = !context.available || context.path !== state.root;
      if (choice === 'save' && !await actions.saveAll()) return false;
      if (expectedVersion !== workspaceContextVersion) return false;
      if (choice === 'preserve' && state.root && changesRoot && (dirtyFilePaths().length || hasWork())) {
        set({ pendingWorkspace: context }); return false;
      }
      if (hasWork() && changesRoot) await actions.stop();
      if (expectedVersion !== workspaceContextVersion) return false;
      if (!context.available) {
        openRequest++; workspaceVersion++; runRequest++; nyBuildVersion++; projectRequest++;
        set({ ...EMPTY, ready: true, boundThreadId: context.threadId, boundChatTitle: context.title,
          workspaceUnavailable: context.reason || 'This chat’s folder is unavailable. Choose a folder to continue.',
          outputEpoch: state.outputEpoch + 1, workspaceSwitching: true });
        return true;
      }
      const opened = await actions.open(context.path, context.threadId ?? undefined, context.title);
      if (opened && expectedVersion === workspaceContextVersion) set({ pendingWorkspace: null, workspaceUnavailable: null });
      return opened;
    } finally {
      set({ workspaceSwitching: false });
      // A newer chat may have arrived while an older open/save was awaiting IPC.
      if (expectedVersion !== workspaceContextVersion && workspaceContext?.ready) {
        const latest = workspaceContext;
        if (state.root && latest.path !== state.root && (dirtyFilePaths().length || hasWork())) set({ pendingWorkspace: latest });
        else void actions.switchWorkspace('preserve');
      }
    }
  },

  async chooseFolder(): Promise<void> {
    if (state.busy || state.workspaceSwitching || state.pendingWorkspace || hasWork()) return;
    const version = workspaceContextVersion;
    const context = workspaceContext; const callbacks = workspaceCallbacks;
    if (!await actions.saveAll() || version !== workspaceContextVersion) return;
    try {
      const chosen = callbacks ? await callbacks.chooseWorkspace() : await window.electronAPI.workspace.chooseDirectory();
      if (chosen) await adoptChosenWorkspace(chosen, context, version);
    } catch (error) { if (version === workspaceContextVersion) set({ error: readable(error) }); }
  },

  /** Open a host-selected folder; chat IDs bind the host's file service to the same identity. */
  async open(directory: string | null, threadId?: string, chatTitle = ''): Promise<boolean> {
    const opening = ++openRequest;
    const previousRoot = state.root;
    // Invalidate outstanding root-relative reads/saves before the host begins switching.
    if (directory !== previousRoot) { workspaceVersion++; runRequest++; nyBuildVersion++; }
    projectRequest++;
    set({ busy: true, error: '' });
    try {
      const { root, entries } = await api().open(directory, threadId);
      if (opening !== openRequest) return false;
      const changed = root !== previousRoot;
      set({
        ...(changed ? { project: null, projectError: null, diagnostics: [], buildOutput: '', buildResult: null, task: null, debug: NO_DEBUG,
          command: '', reveal: null, outputEpoch: state.outputEpoch + 1 } : {}),
        root, ready: true, boundThreadId: threadId ?? null, boundChatTitle: chatTitle,
        workspaceUnavailable: null, tree: { '': entries }, expanded: [],
        files: changed ? [] : state.files,
        activePath: changed ? null : state.activePath,
        breakpoints: loadBreakpoints(root), run: changed ? null : state.run,
        nyBuilding: changed ? false : state.nyBuilding,
      });
      await actions.refreshProject();
      return opening === openRequest;
    } catch (error) {
      if (opening === openRequest) set({ error: readable(error) });
      return false;
    } finally {
      if (opening === openRequest) set({ busy: false });
    }
  },

  async reload(directory = ''): Promise<void> {
    if (!state.root || state.busy) return;
    const version = workspaceVersion;
    try {
      const entries = await api().list(directory);
      if (version !== workspaceVersion) return;
      set({ tree: { ...state.tree, [directory]: entries } });
    } catch (error) {
      if (version === workspaceVersion) set({ error: readable(error) });
    }
  },

  async toggleDirectory(path: string): Promise<void> {
    if (state.expanded.includes(path)) {
      set({ expanded: state.expanded.filter((entry) => entry !== path) });
      return;
    }
    set({ expanded: [...state.expanded, path] });
    if (!state.tree[path]) await actions.reload(path);
  },

  async openFile(path: string): Promise<void> {
    if (!state.root || state.busy) return;
    const version = workspaceVersion;
    const already = state.files.find((file) => file.path === path);
    if (already && !/\.nil$/i.test(path)) {
      set({ activePath: path });
      void actions.suggestCommand(path);
      void actions.refreshProject();
      return;
    }

    try {
      const content = await api().read(path);
      if (version !== workspaceVersion) return;
      const file: OpenFile = {
        path: content.path,
        text: content.text,
        saved: content.text,
        modified: content.modified,
        binary: content.binary,
      };
      set({ files: [...state.files.filter(entry => entry.path !== file.path), file], activePath: file.path, error: '' });
      void actions.suggestCommand(file.path);
      void actions.refreshProject();
    } catch (error) {
      if (version === workspaceVersion) set({ error: readable(error) });
    }
  },

  edit(path: string, text: string): void {
    set({ files: state.files.map((file) => (file.path === path ? { ...file, text } : file)),
      diagnostics: state.diagnostics.filter(item => item.path !== path) });
  },

  select(path: string): void {
    set({ activePath: path, reveal: null });
    void actions.suggestCommand(path);
    void actions.refreshProject();
  },

  /** Opens a file at a line — how the call stack and the assistant point at code. */
  async reveal(path: string, line: number): Promise<void> {
    const version = workspaceVersion;
    await actions.openFile(path);
    if (version === workspaceVersion && state.files.some(file => file.path === path)) set({ activePath: path, reveal: { path, line } });
  },

  clearReveal(): void {
    if (state.reveal) set({ reveal: null });
  },

  close(path: string): void {
    const remaining = state.files.filter((file) => file.path !== path);
    set({
      files: remaining,
      activePath: state.activePath === path ? remaining[remaining.length - 1]?.path ?? null : state.activePath,
      diagnostics: state.diagnostics.filter(item => item.path !== path),
    });
    void actions.refreshProject();
  },

  async save(path?: string): Promise<boolean> {
    const file = path ? state.files.find((entry) => entry.path === path) : active();
    if (!file || file.binary) return false;
    const root = state.root; const version = workspaceVersion;
    if (state.busy) return false;

    try {
      if (!await api().unchanged(file.path, file.modified)) throw new Error(`${file.path} changed on disk. Reopen it or reconcile the changes before saving.`);
      if (root !== state.root || version !== workspaceVersion || state.busy) return false;
      const written = await api().write(file.path, file.text);
      if (root !== state.root || version !== workspaceVersion || state.busy) return false;
      set({
        files: state.files.map((entry) =>
          entry.path === file.path ? { ...entry, saved: written.text, modified: written.modified } : entry
        ),
        error: '',
      });
      if (/(^|\/)nil\.project\.json$/.test(file.path)) await actions.refreshProject();
      return true;
    } catch (error) {
      if (root === state.root && version === workspaceVersion) set({ error: readable(error) });
      return false;
    }
  },

  async create(path: string, kind: 'file' | 'directory'): Promise<void> {
    if (!state.root || state.busy || state.workspaceSwitching) return;
    const version = workspaceVersion;
    try {
      const entry = await api().create(path, kind);
      if (version !== workspaceVersion) return;
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      await actions.reload(parent);
      if (version === workspaceVersion && kind === 'file') await actions.openFile(entry.path);
    } catch (error) {
      if (version === workspaceVersion) set({ error: readable(error) });
    }
  },

  async rename(from: string, to: string): Promise<void> {
    if (!state.root || state.busy || state.workspaceSwitching) return;
    const version = workspaceVersion;
    try {
      await api().rename(from, to);
      if (version !== workspaceVersion) return;
      const parent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
      await actions.reload(parent);
      if (parent !== '') await actions.reload('');
      if (version !== workspaceVersion) return;
      set({
        files: state.files.map((file) => (file.path === from ? { ...file, path: to } : file)),
        activePath: state.activePath === from ? to : state.activePath,
      });
    } catch (error) {
      if (version === workspaceVersion) set({ error: readable(error) });
    }
  },

  async remove(path: string): Promise<void> {
    if (!state.root || state.busy || state.workspaceSwitching) return;
    const version = workspaceVersion;
    try {
      await api().remove(path);
      if (version !== workspaceVersion) return;
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      await actions.reload(parent);
      if (version === workspaceVersion) actions.close(path);
    } catch (error) {
      if (version === workspaceVersion) set({ error: readable(error) });
    }
  },

  setCommand(command: string): void {
    if (state.activePath) commands.set(`${state.root}:${state.activePath}`, command);
    set({ command });
  },

  async suggestCommand(path: string): Promise<void> {
    const root = state.root;
    try {
      const command = commands.get(`${root}:${path}`) ?? await api().suggestCommand(path);
      if (state.root === root && state.activePath === path) set({ command });
    } catch {
      // A guess that fails is not worth reporting; the field is editable.
    }
  },

  /** Saves the open file first: running the previous version is a special kind of maddening. */
  async saveAll(): Promise<boolean> {
    const version = workspaceVersion;
    for (const file of state.files.filter(isDirty)) {
      if (version !== workspaceVersion || state.busy || !await actions.save(file.path)) return false;
    }
    if (version !== workspaceVersion || state.busy) return false;
    if (state.files.some(isDirty)) { set({ error: 'Source changed while saving. Save again before starting the task.' }); return false; }
    return true;
  },

  async refreshProject(): Promise<void> {
    const request = ++projectRequest; const root = state.root;
    if (!root) return;
    set({ projectLoading: true });
    const [project, sdk] = await Promise.allSettled([
      window.electronAPI.nilProject.describe(state.activePath ?? undefined), window.electronAPI.ny.status(),
    ]);
    if (request !== projectRequest || root !== state.root) return;
    const description = project.status === 'fulfilled' ? project.value : null;
    set({ project: description, projectLoading: false,
      projectError: project.status === 'rejected' ? readable(project.reason) : null,
      sdk: sdk.status === 'fulfilled' ? sdk.value : null,
      target: description ? projectTargets.get(description.projectFile) ?? 'vm' : 'vm',
    });
  },

  setTarget(target: NilProjectTarget): void {
    if (state.task || state.nyBuilding || state.debug.phase !== 'stopped' || (state.run && !state.run.exit)) return;
    if (state.project) projectTargets.set(state.project.projectFile, target);
    set({ target });
  },

  async createProject(name: string, language: NilProjectLanguage): Promise<boolean> {
    if (state.pendingWorkspace || state.workspaceSwitching || state.task || state.busy || state.nyBuilding || state.debug.phase !== 'stopped' || (state.run && !state.run.exit)) return false;
    const contextVersion = workspaceContextVersion;
    const context = workspaceContext; const callbacks = workspaceCallbacks;
    if (!await actions.saveAll() || contextVersion !== workspaceContextVersion) return false;
    try {
      const created = await window.electronAPI.nilProject.create(name, language);
      if (!created || contextVersion !== workspaceContextVersion) return false;
      if (context?.threadId && callbacks) {
        const bound = await callbacks.bindWorkspace(created.root);
        if (!bound || !await adoptChosenWorkspace(bound, context, contextVersion)) return false;
      } else await actions.open(created.root);
      if (state.root !== created.root) return false;
      await actions.openFile(created.entry);
      await actions.refreshProject();
      return true;
    } catch (error) { if (workspaceContext?.threadId === context?.threadId) set({ error: readable(error) }); return false; }
  },

  async check(): Promise<void> { await buildTask('check'); },
  async build(): Promise<void> { await buildTask('build'); },

  async run(): Promise<void> {
    if (state.pendingWorkspace || state.workspaceSwitching || state.workspaceUnavailable || state.task || state.nyBuilding || state.busy || state.projectLoading || state.debug.phase !== 'stopped') return;
    const request = ++runRequest; const version = workspaceVersion; const root = state.root;
    const file = active(); const command = state.command; const project = state.project;
    const current = () => version === workspaceVersion && request === runRequest && root === state.root;
    set({ task: 'run', nyBuilding: true });
    try {
      if (!await actions.saveAll() || !current()) return;
      if (state.projectError) throw new Error(state.projectError);
      if (!project && !command.trim()) throw new Error('There is no command to run. Type one in the toolbar.');
      const ny = !!file && /\.(ny|matrix|mat|nil)$/i.test(file.path) && command === `ny run ${JSON.stringify(file.path)}`;
      set({ outputEpoch: state.outputEpoch + 1, error: '' });
      const run = project ? await window.electronAPI.nilProject.run(project.projectFile, state.target)
        : ny ? await window.electronAPI.ny.run(file!.path) : await api().run(command, file?.path ?? command);
      if (current()) set({ run: { ...run, exit: completedRuns.get(run.id) ?? run.exit } });
    } catch (error) { if (current()) set({ error: readable(error) }); }
    finally { if (current()) set({ task: null, nyBuilding: false }); }
  },

  async stop(): Promise<void> {
    runRequest++; nyBuildVersion++;
    set({ nyBuilding: false, task: null });
    try { await Promise.all([window.electronAPI.ny.cancel(), api().stop(), api().debugStop()]); }
    catch (error) { set({ error: readable(error) }); }
  },

  setNyBuilding(nyBuilding: boolean, token?: number): number {
    if (nyBuilding) { nyBuildVersion++; set({ nyBuilding: true }); }
    else if (token === undefined || token === nyBuildVersion) set({ nyBuilding: false });
    return nyBuildVersion;
  },

  toggleBreakpoint(path: string, line: number): void {
    const has = state.breakpoints.some((entry) => entry.file === path && entry.line === line);
    const next = has
      ? state.breakpoints.filter((entry) => !(entry.file === path && entry.line === line))
      : [...state.breakpoints, { file: path, line }];

    set({ breakpoints: next });
    saveBreakpoints(state.root, next);
    // A live session takes them immediately; otherwise they are applied when one starts.
    const version = workspaceVersion;
    if (state.debug.phase !== 'stopped') void api().debugBreakpoints(next).catch((error) => {
      if (version === workspaceVersion && state.debug.phase !== 'stopped') set({ error: readable(error) });
    });
  },

  clearBreakpoints(): void {
    set({ breakpoints: [] });
    saveBreakpoints(state.root, []);
    const version = workspaceVersion;
    if (state.debug.phase !== 'stopped') void api().debugBreakpoints([]).catch((error) => {
      if (version === workspaceVersion && state.debug.phase !== 'stopped') set({ error: readable(error) });
    });
  },

  async debug(): Promise<void> {
    if (state.pendingWorkspace || state.workspaceSwitching || state.workspaceUnavailable || state.busy || state.task || state.nyBuilding || state.projectLoading || state.debug.phase !== 'stopped') return;
    const version = workspaceVersion; const request = ++runRequest; const file = active(); const project = state.project;
    const current = () => version === workspaceVersion && request === runRequest;
    set({ task: 'debug' });
    try {
      if (!project && !file) throw new Error('Open a source file or project to debug.');
      if (project && state.target !== 'vm') throw new Error('Source debugging uses the NIL VM. Select the VM target to debug.');
      if (!await actions.saveAll() || !current()) return;
      if (state.projectError) throw new Error(state.projectError);
      await api().stop();
      if (!current()) return;
      set({ outputEpoch: state.outputEpoch + 1, error: '' });
      const debugState = project ? await window.electronAPI.nilProject.debug(project.projectFile, state.breakpoints)
        : await api().debugStart(file!.path, state.breakpoints);
      if (current()) set({ debug: debugState });
    } catch (error) { if (current()) set({ error: readable(error) }); }
    finally { if (current()) set({ task: null }); }
  },

  async step(which: 'resume' | 'stepOver' | 'stepInto' | 'stepOut'): Promise<void> {
    const version = workspaceVersion; const request = runRequest;
    try {
      const debug = await api()[which]();
      if (version === workspaceVersion && request === runRequest) set({ debug });
    } catch (error) {
      if (version === workspaceVersion && request === runRequest) set({ error: readable(error) });
    }
  },

  async debugStop(): Promise<void> {
    runRequest++; set({ task: null });
    try { await api().debugStop(); } catch (error) { set({ error: readable(error) }); }
  },

  async debugPause(): Promise<void> {
    const version = workspaceVersion; const request = runRequest;
    try { const debug = await api().pause(); if (version === workspaceVersion && request === runRequest) set({ debug }); }
    catch (error) { if (version === workspaceVersion && request === runRequest) set({ error: readable(error) }); }
  },

  async selectDebugFrame(frameId: string): Promise<void> {
    const version = workspaceVersion; const request = runRequest;
    try {
      const debug = await api().selectFrame(frameId);
      if (version !== workspaceVersion || request !== runRequest) return;
      set({ debug });
      const frame = debug.frames.find((entry) => entry.id === frameId);
      if (frame?.file && !frame.file.startsWith('/') && !frame.file.startsWith('node:')) {
        await actions.reveal(frame.file, frame.line);
      }
    } catch (error) { set({ error: readable(error) }); }
  },

  clearError(): void {
    set({ error: '' });
  },
};

async function buildTask(mode: 'check' | 'build'): Promise<void> {
  if (state.pendingWorkspace || state.workspaceSwitching || state.workspaceUnavailable || state.task || state.nyBuilding || state.busy || state.projectLoading || state.debug.phase !== 'stopped' || (state.run && !state.run.exit)) return;
  const version = workspaceVersion; const token = ++nyBuildVersion;
  const project = state.project; const file = active(); const target = state.target;
  const current = () => version === workspaceVersion && token === nyBuildVersion;
  set({ task: mode, nyBuilding: true, error: '' });
  try {
    if (!await actions.saveAll() || !current()) return;
    if (state.projectError) throw new Error(state.projectError);
    if (!project && (!file || !/\.(ny|matrix|mat)$/i.test(file.path))) throw new Error('Open a Ny or Matrix source file, or a NIL Framework project.');
    const checkedBuffers = new Map(state.files.map(file => [file.path, file.saved]));
    const result = project
      ? mode === 'check' ? await window.electronAPI.nilProject.check(project.projectFile) : await window.electronAPI.nilProject.build(project.projectFile, target)
      : await window.electronAPI.ny[mode](file!.path);
    if (!current()) return;
    const fresh = (path?: string) => !path || !state.files.some(file => file.path === path && file.text !== checkedBuffers.get(path));
    set({ buildResult: result, buildOutput: result.output, diagnostics: result.diagnostics.filter(item => fresh(item.path)) });
    for (const open of state.files.filter(file => /\.(ny|matrix|mat)$/i.test(file.path) && file.text === checkedBuffers.get(file.path))) {
      window.dispatchEvent(new CustomEvent('antimatter:ny-diagnostics', { detail: { path: open.path, text: open.text,
        diagnostics: result.diagnostics.filter(item => !item.path || item.path === open.path), origin: 'build' } }));
    }
    if (result.success && mode === 'build') await actions.reload();
  } catch (error) { if (current()) set({ error: readable(error), buildOutput: readable(error), buildResult: null }); }
  finally { if (current()) set({ task: null, nyBuilding: false }); }
}

/** Subscribes once to the streams the main process pushes. */
function wire(): void {
  if (wired) return;
  wired = true;
  window.addEventListener('antimatter:ny-diagnostics', event => {
    const detail = (event as CustomEvent<{ path: string; text: string; diagnostics: NyDiagnostic[]; origin?: string }>).detail;
    if (!detail || detail.origin === 'build' || state.task || !Array.isArray(detail.diagnostics)) return;
    const file = state.files.find(file => file.path === detail.path);
    if (!file || file.text !== detail.text) return;
    set({ diagnostics: [...state.diagnostics.filter(item => item.path !== detail.path),
      ...detail.diagnostics.filter(item => !item.path || item.path === detail.path).map(item => ({ ...item, path: item.path ?? detail.path }))] });
  });

  window.electronAPI.onEnvironmentExit((exit) => {
    if (exit.source === 'run') {
      if (exit.id) {
        completedRuns.set(exit.id, { code: exit.code, signal: exit.signal });
        if (completedRuns.size > 16) completedRuns.delete(completedRuns.keys().next().value!);
      }
      if (state.run && (!exit.id || exit.id === state.run.id)) set({ run: { ...state.run, exit: { code: exit.code, signal: exit.signal } } });
    }
  });

  window.electronAPI.onDebugState((next) => {
    set({ debug: next });
    // Stopping somewhere is only useful if you are shown where — but only for a file in this
    // tree. A frame inside Node's own module loader is not something to try to open.
    const frame = next.frames.find((entry) => entry.id === next.selectedFrameId) ?? next.frames[0];
    const ours = frame?.file && !frame.file.startsWith('/') && !frame.file.startsWith('node:');
    if (next.phase === 'paused' && ours) void actions.reveal(frame.file, frame.line);
  });
}

export function useEnvironment(): EnvironmentState {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    wire();
    if (!workspaceContextConfigured && !state.ready && !state.busy) void actions.open(null);
  }, []);
  return snapshot;
}
