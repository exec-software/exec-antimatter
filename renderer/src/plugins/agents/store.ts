import { useEffect, useSyncExternalStore } from 'react';
import { mergeToolActivity } from '../../lib/transcript';
import { appendAgentContent } from './transcript';
import type {
  AgentActivity,
  AgentDefinition,
  AgentTask,
  NewAgentTask,
  RoutedTask,
  TaskState,
  ToolActivity,
} from '../../types';

/**
 * Agents and tasks, shared by both of their tool windows.
 *
 * The same reasoning as Snitch's store: the panels are mounted by the shell in different places
 * and may be split, docked, or floating, so there is no ancestor to hang a context on. They are
 * looking at one queue, so they read one store.
 */

const NO_COUNTS: Record<TaskState, number> = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };

export interface AgentsState {
  agents: AgentDefinition[];
  tasks: AgentTask[];
  active: AgentActivity[];
  counts: Record<TaskState, number>;
  busy: boolean;
  /** The task whose session is open, and the carbon behind it. */
  openTaskId: string | null;
  session: { taskId: string; path: string | null; markdown: string | null } | null;
  /** Live text from a running task, so a session can be watched rather than only read. */
  streaming: Record<string, string>;
  /** The same run's tool calls, anchored in that text, so it can be drawn as a transcript. */
  runs: Record<string, ToolActivity[]>;
  runSessions: Record<string, string>;
  records: Record<string, { path: string | null; markdown: string | null }>;
  lastRoute: RoutedTask | null;
  working: boolean;
  error: string;
}

const EMPTY: AgentsState = {
  agents: [],
  tasks: [],
  active: [],
  counts: NO_COUNTS,
  busy: false,
  openTaskId: null,
  session: null,
  streaming: {},
  runs: {},
  runSessions: {},
  records: {},
  lastRoute: null,
  working: false,
  error: '',
};

let state = EMPTY;
let started = false;
let reloadRevision = 0;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());
const set = (patch: Partial<AgentsState>) => {
  state = { ...state, ...patch };
  emit();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const api = () => window.electronAPI.agents;

/** Imperative snapshot for shell commands and non-React consumers of the shared store. */
export const agentState = (): Readonly<AgentsState> => state;

/** IPC errors arrive wrapped in Electron's own prefix; nobody wants to read that. */
const readable = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

type RunEvent =
  | { kind: 'content'; taskId: string; content: string; sessionId?: string; revision?: number; contentOffset?: number }
  | { kind: 'activity'; taskId: string; activity: ToolActivity; sessionId?: string; revision?: number };
const pending = new Map<string, RunEvent[]>();
const hydration = new Map<string, Promise<void>>();

function applyEvent(event: RunEvent): void {
  const { taskId, sessionId } = event;
  const changedSession = sessionId && state.runSessions[taskId] !== sessionId;
  const content = changedSession ? '' : state.streaming[taskId] ?? '';
  const tools = changedSession ? [] : state.runs[taskId] ?? [];
  if (event.kind === 'content') {
    const next = appendAgentContent(content, event.content, event.contentOffset);
    if (next === null) {
      // A newly opened window missed a prefix; don't present a truncated run as the whole thing.
      void hydrateRun(taskId);
      pending.get(taskId)?.push(event);
      return;
    }
    set({ streaming: { ...state.streaming, [taskId]: next },
      ...(changedSession ? { runs: { ...state.runs, [taskId]: [] } } : {}),
      ...(sessionId ? { runSessions: { ...state.runSessions, [taskId]: sessionId } } : {}) });
  } else {
    set({ runs: { ...state.runs, [taskId]: mergeToolActivity(tools, event.activity, content.length) },
      ...(changedSession ? { streaming: { ...state.streaming, [taskId]: '' } } : {}),
      ...(sessionId ? { runSessions: { ...state.runSessions, [taskId]: sessionId } } : {}) });
  }
}

function receive(event: RunEvent): void {
  const buffered = pending.get(event.taskId);
  if (buffered) buffered.push(event);
  else applyEvent(event);
}

/** Subscribe first, then snapshot and replay only newer events, including when switching panes. */
function hydrateRun(taskId: string): Promise<void> {
  const existing = hydration.get(taskId);
  if (existing) return existing;
  pending.set(taskId, []);
  const work = api().session(taskId).then((session) => {
    const snapshot = session?.transcript;
    if (session) {
      set({ records: { ...state.records, [taskId]: { path: session.path, markdown: session.markdown } },
        ...(snapshot ? {
          streaming: { ...state.streaming, [taskId]: snapshot.content },
          runs: { ...state.runs, [taskId]: snapshot.tools.map((tool) => ({ ...tool, requestId: taskId })) },
          runSessions: { ...state.runSessions, [taskId]: snapshot.sessionId },
        } : {}) });
    }
    const events = pending.get(taskId) ?? [];
    pending.delete(taskId);
    for (const event of events) {
      if (!snapshot || event.sessionId !== snapshot.sessionId || (event.revision ?? Infinity) > snapshot.revision) {
        applyEvent(event);
      }
    }
  }).catch((error) => {
    pending.delete(taskId);
    set({ error: readable(error) });
  }).finally(() => hydration.delete(taskId));
  hydration.set(taskId, work);
  return work;
}

async function reload(): Promise<void> {
  const revision = ++reloadRevision;
  try {
    const [agents, tasks, activity] = await Promise.all([api().list(), api().tasks(), api().activity()]);
    if (revision !== reloadRevision) return;
    set({ agents, tasks, active: activity.active, counts: activity.counts, busy: activity.busy });
    // Recover active work after a renderer reload; finished runs hydrate when opened.
    await Promise.all(tasks.filter((task) => task.state === 'running').map((task) => hydrateRun(task.id)));
  } catch (error) {
    set({ error: readable(error) });
  }
}

/** Wraps a mutation so every path clears the flag and refreshes from the main process. */
async function act<T>(work: () => Promise<T>): Promise<T | null> {
  set({ working: true, error: '' });
  try {
    return await work();
  } catch (error) {
    set({ error: readable(error) });
    return null;
  } finally {
    set({ working: false });
    await reload();
  }
}

export const actions = {
  async start(): Promise<void> {
    if (started) return;
    started = true;
    window.electronAPI.onAgentsChanged(() => void reload());
    // Live output goes to whichever session is open; the rest is kept so switching to it shows
    // what has happened so far rather than an empty pane until the next token.
    window.electronAPI.onAgentContent((event) => {
      receive({ ...event, kind: 'content' });
    });
    window.electronAPI.onAgentActivity((raw) => {
      const event = raw as Omit<ToolActivity, 'requestId'> & { runId?: string; sessionId?: string; revision?: number };
      const taskId = event.runId;
      if (!taskId) return;
      const activity: ToolActivity = { ...event, requestId: taskId };
      receive({ kind: 'activity', taskId, activity, sessionId: event.sessionId, revision: event.revision });
    });
    await reload();
  },

  reload,
  hydrateRun,

  clearError(): void {
    set({ error: '' });
  },
  reportError(error: unknown): void { set({ error: readable(error) }); },

  dispatch: (task: NewAgentTask) => act(() => api().dispatch(task)),

  async route(text: string, workspace?: string | null): Promise<RoutedTask | null> {
    const result = await act(() => api().route(text, workspace));
    set({ lastRoute: result?.routed ?? null });
    return result?.routed ?? null;
  },

  cancelTask: (taskId: string) => act(() => api().cancelTask(taskId)),
  setSchedulePaused: (taskId: string, paused: boolean) => act(() => api().setSchedulePaused(taskId, paused)),
  removeTask: (taskId: string) => act(() => api().removeTask(taskId)),
  saveAgent: (definition: AgentDefinition) => act(() => api().save(definition)),
  removeAgent: (id: string) => act(() => api().remove(id)),

  /** Opens a run's transcript. A task with no carbon yet shows whatever has streamed so far. */
  async openSession(taskId: string | null): Promise<void> {
    set({ openTaskId: taskId, session: null });
    if (!taskId) return;
    try {
      await hydrateRun(taskId);
      const session = state.records[taskId];
      if (state.openTaskId !== taskId) return;
      set({ session: session ? { taskId, path: session.path, markdown: session.markdown } : null });
    } catch (error) {
      set({ error: readable(error) });
    }
  },
};

/** Everything, for a panel that needs it. Starting the store is idempotent. */
export function useAgents(): AgentsState {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    void actions.start();
  }, []);
  return snapshot;
}

/** How many agents are working right now — the number on the stripe. */
export function useActiveCount(): number | null {
  const active = useSyncExternalStore(subscribe, () => state.active);
  useEffect(() => {
    void actions.start();
  }, []);
  return active.length || null;
}

const NO_TOOLS: ToolActivity[] = [];

/**
 * One task, for a row that shows it. Only this task changing re-renders the row, which matters
 * in a transcript where every other agent's streamed text is also passing through the store.
 */
export function useAgentTask(taskId: string | null): AgentTask | null {
  const task = useSyncExternalStore(subscribe, () =>
    taskId ? state.tasks.find((candidate) => candidate.id === taskId) ?? null : null
  );
  useEffect(() => {
    void actions.start();
  }, []);
  return task;
}

/** What a run has written and done so far, while this window has been watching it. */
export function useAgentRun(taskId: string | null): { content: string; tools: ToolActivity[]; record: string | null } {
  const content = useSyncExternalStore(subscribe, () => (taskId ? state.streaming[taskId] ?? '' : ''));
  const tools = useSyncExternalStore(subscribe, () => (taskId ? state.runs[taskId] ?? NO_TOOLS : NO_TOOLS));
  const record = useSyncExternalStore(subscribe, () => (taskId ? state.records[taskId]?.markdown ?? null : null));
  useEffect(() => {
    void actions.start();
  }, []);
  useEffect(() => {
    if (taskId) void hydrateRun(taskId);
  }, [taskId]);
  return { content, tools, record };
}

/** The installed agents, for the tags that pick an agent's symbol. */
export function useAgentDefinitions(): AgentDefinition[] {
  const agents = useSyncExternalStore(subscribe, () => state.agents);
  useEffect(() => {
    void actions.start();
  }, []);
  return agents;
}
