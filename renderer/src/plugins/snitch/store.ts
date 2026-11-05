import { useEffect, useSyncExternalStore } from 'react';
import type {
  ItemKind,
  ItemStatus,
  PipelineEntry,
  PipelineStage,
  SnitchItem,
  SnitchItemDraft,
  SnitchProject,
  SnitchProjectPatch,
  SnitchProjectSummary,
  SnitchStoreConfig,
} from '../../types';

/**
 * Snitch's state, shared by both of its tool windows.
 *
 * A store outside React rather than a context, because the two panels are mounted by the shell
 * in different places — one docked right, one docked at the bottom, either of them floating —
 * and there is no common ancestor to hang a provider on. They are looking at the same projects,
 * so they read the same store.
 */

export type SnitchTab = 'items' | 'releases' | 'settings';

export interface SnitchState {
  config: SnitchStoreConfig | null;
  projects: SnitchProjectSummary[];
  project: SnitchProject | null;
  pipeline: PipelineEntry[];
  selectedId: string | null;
  tab: SnitchTab;
  busy: boolean;
  error: string;
}

const EMPTY: SnitchState = {
  config: null,
  projects: [],
  project: null,
  pipeline: [],
  selectedId: null,
  tab: 'items',
  busy: false,
  error: '',
};

let state = EMPTY;
let started = false;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());
const set = (patch: Partial<SnitchState>) => {
  state = { ...state, ...patch };
  emit();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const readable = (error: unknown): string =>
  (error as Error).message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

const api = () => window.electronAPI.snitch;

/** Everything that can change underneath us: the project list, the open project, the pipeline. */
async function reload(): Promise<void> {
  try {
    const [config, projects, pipeline] = await Promise.all([api().config(), api().projects(), api().pipeline()]);
    const name = state.project?.name && projects.some((entry) => entry.name === state.project?.name)
      ? state.project.name
      : (projects[0]?.name ?? null);
    const project = name ? await api().project(name) : null;

    set({
      config,
      projects,
      pipeline,
      project,
      selectedId: project?.items.some((item) => item.id === state.selectedId) ? state.selectedId : null,
      error: '',
    });
  } catch (error) {
    set({ error: readable(error) });
  }
}

/** Wraps a mutation so every panel sees the result and the error lands somewhere visible. */
async function run<T>(operation: () => Promise<T>): Promise<T | null> {
  set({ busy: true, error: '' });
  try {
    const result = await operation();
    if (result && typeof result === 'object' && 'items' in (result as object)) {
      set({ project: result as unknown as SnitchProject });
    }
    return result;
  } catch (error) {
    set({ error: readable(error) });
    return null;
  } finally {
    set({ busy: false });
    // Counts, pipeline stages and the project list all move with a mutation.
    void refreshLists();
  }
}

async function refreshLists(): Promise<void> {
  try {
    const [projects, pipeline] = await Promise.all([api().projects(), api().pipeline()]);
    set({ projects, pipeline });
  } catch (error) {
    set({ error: readable(error) });
  }
}

export const actions = {
  async start(): Promise<void> {
    if (started) return;
    started = true;
    await reload();
    // Items are edited here and by the agents fixing them; either way the panel reloads.
    window.electronAPI.onSnitchChanged(() => void reload());
  },

  reload,
  refreshLists,

  async selectProject(name: string): Promise<void> {
    set({ busy: true, error: '' });
    try {
      set({ project: await api().project(name), selectedId: null });
    } catch (error) {
      set({ error: readable(error) });
    } finally {
      set({ busy: false });
    }
  },

  select(id: string | null): void {
    set({ selectedId: id });
  },

  setTab(tab: SnitchTab): void {
    set({ tab });
  },

  clearError(): void {
    set({ error: '' });
  },

  setRoot: (root: string | null) => run(() => api().setRoot(root)).then(() => reload()),
  createProject: (name: string, repo: string | null) =>
    run(() => api().createProject(name, repo)).then((project) => {
      if (project) set({ project, tab: 'items' });
      return project;
    }),
  deleteProject: (name: string) => run(() => api().deleteProject(name)).then(() => reload()),
  updateProject: (name: string, patch: SnitchProjectPatch) => run(() => api().updateProject(name, patch)),

  addItem: (name: string, kind: ItemKind, draft: SnitchItemDraft) => run(() => api().addItem(name, kind, draft)),
  updateItem: (name: string, item: SnitchItem) => run(() => api().updateItem(name, item)),
  deleteItems: (name: string, ids: string[]) =>
    run(() => api().deleteItems(name, ids)).then((project) => {
      if (project) set({ selectedId: null });
      return project;
    }),
  setStatus: (name: string, ids: string[], status: ItemStatus) => run(() => api().setStatus(name, ids, status)),
  setRelease: (name: string, ids: string[], releaseId: string | null) =>
    run(() => api().setRelease(name, ids, releaseId)),

  addRelease: (name: string, releaseName: string) => run(() => api().addRelease(name, releaseName)),
  updateRelease: (name: string, release: SnitchProject['releases'][number]) =>
    run(() => api().updateRelease(name, release)),
  deleteRelease: (name: string, releaseId: string) => run(() => api().deleteRelease(name, releaseId)),

  /** The one-click fix: queue it, and the orchestrator takes it from there. */
  fix: (name: string, itemId: string) => run(() => api().fix(name, itemId)).then((entries) => entries && set({ pipeline: entries })),
  cancelFix: (name: string, itemId: string) =>
    run(() => api().cancel(name, itemId)).then((entries) => entries && set({ pipeline: entries })),
  acknowledge: (name: string, itemId: string) =>
    run(() => api().acknowledge(name, itemId)).then((entries) => entries && set({ pipeline: entries })),
};

export function useSnitch(): SnitchState {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    void actions.start();
  }, []);
  return snapshot;
}

/** Just the live pipeline, for the stripe badge — it must not pull the whole panel into memory. */
export function usePipelineCount(): number {
  const snapshot = useSyncExternalStore(subscribe, () => state.pipeline);
  useEffect(() => {
    void actions.start();
  }, []);
  return snapshot.filter((entry) => ACTIVE_STAGES.includes(entry.stage)).length;
}

export const ACTIVE_STAGES: PipelineStage[] = ['queued', 'fixing', 'qa'];
