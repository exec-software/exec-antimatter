/** Personal navigation metadata. These groups never grant workspace or sharing access. */
export const ALL_CHATS_PROJECT = '@all';
export const UNGROUPED_PROJECT = '@ungrouped';

export interface SidebarProject {
  id: string;
  name: string;
  description: string;
  parentId: string | null;
}

export const DEFAULT_SIDEBAR_PROJECTS: readonly SidebarProject[] = [
  { id: 'inbox', name: 'Inbox', description: '', parentId: null },
  { id: 'projects', name: 'Projects', description: '', parentId: null },
  { id: 'research', name: 'Research', description: '', parentId: null },
];

export type ChatSection = 'recent' | 'pinned' | 'imported-claude' | 'imported-codex' | 'imported-opencode';

export interface SidebarState {
  version: 1;
  revision: number;
  projects: SidebarProject[];
  /** Null means explicitly ungrouped. Missing means use the conversation's existing project. */
  threadProjects: Record<string, string | null>;
  /** Removed groups keep a redirect so older conversations remain visible after upgrades. */
  projectRedirects: Record<string, string | null>;
  /** Only explicit moves take an imported chat out of its private source section. */
  importedInRecent: string[];
  orders: Record<string, string[]>;
  collapsed: Record<string, boolean>;
}

export type SidebarAction =
  | { kind: 'create-project'; name: string; description?: string; parentId?: string | null }
  | { kind: 'update-project'; id: string; name: string; description: string; parentId: string | null }
  | { kind: 'delete-project'; id: string }
  | { kind: 'move-thread'; threadId: string; projectId: string | null }
  | { kind: 'import-location'; threadId: string; recent: boolean }
  | { kind: 'reorder'; section: string; ids: string[] }
  | { kind: 'collapse'; section: string; collapsed: boolean };

export interface SidebarUpdate {
  revision: number;
  action: SidebarAction;
}

export interface SidebarApi {
  load(): Promise<SidebarState>;
  update(request: SidebarUpdate): Promise<SidebarState>;
}

export const emptySidebarState = (): SidebarState => ({
  version: 1,
  revision: 0,
  projects: DEFAULT_SIDEBAR_PROJECTS.map((project) => ({ ...project })),
  threadProjects: {},
  projectRedirects: {},
  importedInRecent: [],
  orders: {},
  collapsed: {},
});

export function sidebarProjectForThread(state: SidebarState, thread: { id: string; projectId: string }): string {
  let project: string | null = Object.prototype.hasOwnProperty.call(state.threadProjects, thread.id)
    ? state.threadProjects[thread.id] : thread.projectId;
  const seen = new Set<string>();
  while (project && Object.prototype.hasOwnProperty.call(state.projectRedirects, project) && !seen.has(project)) {
    seen.add(project);
    project = state.projectRedirects[project];
  }
  return project && state.projects.some((entry) => entry.id === project) ? project : UNGROUPED_PROJECT;
}

export function sidebarDescendants(state: SidebarState, projectId: string): Set<string> {
  const ids = new Set([projectId]);
  let previous = -1;
  while (previous !== ids.size) {
    previous = ids.size;
    for (const project of state.projects) {
      if (project.parentId && ids.has(project.parentId)) ids.add(project.id);
    }
  }
  return ids;
}

/** An explicit order wins; newly arrived rows keep their natural ordering at the end. */
export function orderSidebarRows<T>(rows: readonly T[], ids: readonly string[], key: (row: T) => string): T[] {
  const positions = new Map(ids.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => (positions.get(key(a)) ?? Number.MAX_SAFE_INTEGER)
    - (positions.get(key(b)) ?? Number.MAX_SAFE_INTEGER));
}

/** Reordering a search result preserves the unseen rows' slots. */
export function reorderVisibleSidebarRows(all: readonly string[], visible: readonly string[], moving: string, before: string | null): string[] {
  if (!visible.includes(moving) || (before !== null && !visible.includes(before)) || moving === before) return [...all];
  const reordered = visible.filter((id) => id !== moving);
  const index = before === null ? reordered.length : reordered.indexOf(before);
  reordered.splice(index, 0, moving);
  const selected = new Set(visible);
  let next = 0;
  return all.map((id) => selected.has(id) ? reordered[next++] : id);
}
