import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptySidebarState, sidebarDescendants, type SidebarAction, type SidebarProject, type SidebarState, type SidebarUpdate } from '../api/sidebar';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from './privateState';

const MAX_PROJECTS = 512;
const MAX_ENTRIES = 100_000;
const MAX_BYTES = 16 * 1024 * 1024;
const blockedKeys = new Set(['__proto__', 'prototype', 'constructor']);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sidebar data.');
  return value as Record<string, unknown>;
};
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 180 || /[\u0000-\u001f]/.test(value) || blockedKeys.has(value)) {
    throw new Error('Invalid sidebar identifier.');
  }
  return value;
};
const text = (value: unknown, max: number, required = false): string => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error('Invalid project text.');
  }
  const result = value.trim();
  if (required && !result) throw new Error('Enter a project name.');
  return result;
};
const nullableId = (value: unknown): string | null => value === null ? null : identifier(value);
const list = (value: unknown, max = MAX_ENTRIES): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error('Sidebar data is too large.');
  return value;
};
const uniqueIds = (value: unknown): string[] => {
  const values = list(value).map(identifier);
  if (new Set(values).size !== values.length) throw new Error('Sidebar order contains duplicate items.');
  return values;
};
const mapEntries = (value: unknown): [string, unknown][] => {
  const entries = Object.entries(object(value));
  if (entries.length > MAX_ENTRIES) throw new Error('Sidebar data is too large.');
  entries.forEach(([key]) => identifier(key));
  return entries;
};

export function normalizeSidebarState(input: unknown): SidebarState {
  const value = object(input);
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    throw new Error('Unsupported sidebar data.');
  }
  const projects: SidebarProject[] = list(value.projects, MAX_PROJECTS).map((entry) => {
    const project = object(entry);
    return { id: identifier(project.id), name: text(project.name, 120, true),
      description: text(project.description, 500), parentId: nullableId(project.parentId) };
  });
  const ids = new Set(projects.map((project) => project.id));
  if (ids.size !== projects.length || ids.has('@all') || ids.has('@ungrouped')) throw new Error('Invalid project list.');
  for (const project of projects) {
    const ancestors = new Set([project.id]);
    let parent = project.parentId;
    while (parent !== null) {
      if (!ids.has(parent) || ancestors.has(parent)) throw new Error('Project groups cannot contain cycles.');
      ancestors.add(parent);
      parent = projects.find((entry) => entry.id === parent)!.parentId;
    }
  }
  const threadProjects = Object.fromEntries(mapEntries(value.threadProjects).map(([id, group]) => {
    const target = nullableId(group);
    if (target !== null && !ids.has(target)) throw new Error('The selected project no longer exists.');
    return [id, target];
  }));
  const projectRedirects = Object.fromEntries(mapEntries(value.projectRedirects).map(([id, group]) => {
    const target = nullableId(group);
    if (ids.has(id) || (target !== null && !ids.has(target))) throw new Error('Invalid removed project.');
    return [id, target];
  }));
  const orders = Object.fromEntries(mapEntries(value.orders).map(([key, order]) => [key, uniqueIds(order)]));
  const collapsed = Object.fromEntries(mapEntries(value.collapsed).map(([key, collapsed]) => {
    if (typeof collapsed !== 'boolean') throw new Error('Invalid section state.');
    return [key, collapsed];
  }));
  return { version: 1, revision: Number(value.revision), projects, threadProjects, projectRedirects,
    importedInRecent: uniqueIds(value.importedInRecent), orders, collapsed };
}

function mutate(state: SidebarState, raw: unknown): void {
  const action = object(raw) as unknown as SidebarAction;
  const projectExists = (id: string | null) => {
    if (id !== null && !state.projects.some((project) => project.id === id)) throw new Error('The selected project no longer exists.');
  };
  switch (action.kind) {
    case 'create-project': {
      if (state.projects.length >= MAX_PROJECTS) throw new Error('The project limit has been reached.');
      const parentId = nullableId(action.parentId ?? null);
      projectExists(parentId);
      state.projects.push({ id: randomUUID(), name: text(action.name, 120, true),
        description: text(action.description ?? '', 500), parentId });
      break;
    }
    case 'update-project': {
      const id = identifier(action.id);
      const project = state.projects.find((entry) => entry.id === id);
      if (!project) throw new Error('The selected project no longer exists.');
      const parentId = nullableId(action.parentId);
      projectExists(parentId);
      if (parentId && sidebarDescendants(state, id).has(parentId)) throw new Error('A project cannot be moved inside itself.');
      Object.assign(project, { name: text(action.name, 120, true), description: text(action.description, 500), parentId });
      break;
    }
    case 'delete-project': {
      const id = identifier(action.id);
      const project = state.projects.find((entry) => entry.id === id);
      if (!project) throw new Error('The selected project no longer exists.');
      const replacement = project.parentId;
      state.projects = state.projects.filter((entry) => entry.id !== id)
        .map((entry) => entry.parentId === id ? { ...entry, parentId: replacement } : entry);
      for (const [thread, group] of Object.entries(state.threadProjects)) {
        if (group === id) state.threadProjects[thread] = replacement;
      }
      for (const [removed, group] of Object.entries(state.projectRedirects)) {
        if (group === id) state.projectRedirects[removed] = replacement;
      }
      state.projectRedirects[id] = replacement;
      delete state.collapsed[`project:${id}`];
      delete state.orders[`project:${id}`];
      break;
    }
    case 'move-thread': {
      const id = identifier(action.threadId);
      const projectId = nullableId(action.projectId);
      projectExists(projectId);
      state.threadProjects[id] = projectId;
      break;
    }
    case 'import-location': {
      const id = identifier(action.threadId);
      if (typeof action.recent !== 'boolean') throw new Error('Invalid imported chat destination.');
      state.importedInRecent = state.importedInRecent.filter((entry) => entry !== id);
      if (action.recent) state.importedInRecent.push(id);
      break;
    }
    case 'reorder':
      state.orders[identifier(action.section)] = uniqueIds(action.ids);
      break;
    case 'collapse':
      if (typeof action.collapsed !== 'boolean') throw new Error('Invalid section state.');
      state.collapsed[identifier(action.section)] = action.collapsed;
      break;
    default:
      throw new Error('Unknown sidebar action.');
  }
}

/** The caller owns IPC sender validation. The store accepts only bounded navigation metadata. */
export class SidebarStore {
  constructor(private readonly path: string) {}

  read(): SidebarState {
    if (!existsSync(this.path)) return emptySidebarState();
    const stats = lstatSync(this.path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_BYTES) throw new Error('Sidebar data cannot be read.');
    if (migratePrivateDirectory(dirname(this.path))) migratePrivateFile(this.path);
    // A damaged file is never silently overwritten with defaults.
    return normalizeSidebarState(JSON.parse(readFileSync(this.path, 'utf8')));
  }

  update(input: SidebarUpdate): SidebarState {
    const request = object(input);
    const current = this.read();
    if (!Number.isSafeInteger(request.revision) || request.revision !== current.revision) {
      throw new Error('Sidebar changed in another window. Refresh and try again.');
    }
    mutate(current, request.action);
    current.revision += 1;
    const next = normalizeSidebarState(current);
    const contents = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error('Sidebar data is too large.');
    writePrivateFileAtomic(this.path, contents);
    return next;
  }
}
