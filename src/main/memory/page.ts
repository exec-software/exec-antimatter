import { instructionFiles } from './instructions';
import * as person from './person';
import type { Person } from './person';
import * as store from './store';
import type { MemoryNote, MemoryScope, MemorySettings, ProjectSummary } from './store';

/**
 * What the Memory page shows, and the checks on what it asks for.
 *
 * The page looks at one project at a time: the one the tools' workspace belongs to, which is
 * where the next turn will run, or another that already has notes. It never reads a directory it
 * was handed by path. A project it names has to be one of those, so the page cannot be turned
 * into a way to read AGENTS.md files, or write notes, anywhere on the disk.
 */

export interface MemoryPageTarget {
  /** Another project to look at, by root. The workspace's own when absent. */
  project?: string | null;
}

export interface InstructionFileView {
  path: string;
  label: string;
  length: number;
  /** Part of it is left out of the prompt, because the allowance ran out. */
  truncated: boolean;
}

export interface MemoryPageState {
  settings: MemorySettings;
  /** Who Antimatter is talking to, which is edited in Settings rather than here. */
  person: Person;
  /** The directory everything is kept under. */
  location: string;
  workspace: string;
  /** The project the workspace belongs to. */
  current: string;
  project: { root: string; directory: string; notes: MemoryNote[]; instructions: InstructionFileView[] };
  user: { directory: string; notes: MemoryNote[] };
  /** Every project with notes, the current one included when it has any. */
  projects: ProjectSummary[];
}

interface Resolved {
  workspace: string;
  current: string;
  /** The project being looked at. */
  root: string;
  /** Where its instruction files are read from: the workspace for the current project. */
  instructionsFrom: string;
  projects: ProjectSummary[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export function resolveTarget(target: unknown, workspace: string): Resolved {
  const request = (target && typeof target === 'object' ? target : {}) as Record<string, unknown>;
  const current = store.projectRoot(workspace);
  const projects = store.knownProjects();
  const asked = text(request.project);
  const root = asked && asked !== current && projects.some((project) => project.root === asked) ? asked : current;
  return { workspace, current, root, instructionsFrom: root === current ? workspace : root, projects };
}

export function pageState(target: unknown, workspace: string): MemoryPageState {
  const { current, root, instructionsFrom, projects } = resolveTarget(target, workspace);
  return {
    settings: store.settings(),
    person: person.read(),
    location: store.location(),
    workspace,
    current,
    project: {
      root,
      directory: store.projectDirectoryFor(root),
      notes: store.notesFor('project', root),
      instructions: instructionFiles(instructionsFrom).map(({ path, label, content, length }) => ({
        path,
        label,
        length,
        truncated: content.length < length,
      })),
    },
    user: { directory: store.userDirectory(), notes: store.notesFor('user', null) },
    projects,
  };
}

export function parseScope(value: unknown): MemoryScope {
  if (value === 'user' || value === 'project') return value;
  throw new Error('A note is either about the user or about a project.');
}

/** The instruction file the page asked to open, if it is one the page is showing. */
export function openableInstruction(target: unknown, workspace: string, path: unknown): string | null {
  const wanted = text(path);
  if (!wanted) return null;
  const { instructionsFrom } = resolveTarget(target, workspace);
  return instructionFiles(instructionsFrom).find((file) => file.path === wanted)?.path ?? null;
}
