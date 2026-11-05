import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from '../privateState';

interface StoredProject {
  id: string;
  name: string;
  root: string;
  createdAt: number;
}

interface ProjectFile {
  version: 1;
  projects: StoredProject[];
}

export interface RemoteProjectSummary {
  id: string;
  name: string;
}

export class RemoteProjectUnavailableError extends Error {}

/** Filesystem names are labels, not user-entered remote project names. */
export function inferRemoteProjectName(root: string): string {
  return basename(root)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trim() || 'Project';
}

const canonicalDirectory = (path: string): string => {
  const absolute = resolve(path);
  try {
    const entry = lstatSync(absolute);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new RemoteProjectUnavailableError('A remote project must be an existing, non-symlink directory.');
    }
    return realpathSync(absolute);
  } catch (error) {
    if (error instanceof RemoteProjectUnavailableError) throw error;
    throw new RemoteProjectUnavailableError('The selected remote project is not available on this computer.');
  }
};

/** Host-private project roots; public callers receive only opaque IDs and display names. */
export class RemoteProjectCatalog {
  private cache: ProjectFile | null = null;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly id: () => string = randomUUID
  ) {}

  ensure(root: string, preferredName?: string): RemoteProjectSummary {
    const canonical = canonicalDirectory(root);
    const current = this.read();
    const existing = current.projects.find((project) => project.root === canonical);
    if (existing) return this.public(existing);

    const project: StoredProject = {
      id: this.id(),
      name: this.cleanName(preferredName ?? inferRemoteProjectName(canonical)),
      root: canonical,
      createdAt: this.now(),
    };
    this.write({ version: 1, projects: [...current.projects, project] });
    return this.public(project);
  }

  list(): RemoteProjectSummary[] {
    // A removable disk, deleted checkout, or renamed directory should not leave an
    // unusable project selected on mobile. Keep its identity on disk so it returns
    // with the same ID when the directory becomes available again.
    return this.read().projects
      .filter((project) => this.availableRoot(project) !== null)
      .map((project) => this.public(project));
  }

  findByRoot(root: string): RemoteProjectSummary | null {
    let canonical: string;
    try {
      canonical = canonicalDirectory(root);
    } catch (error) {
      if (error instanceof RemoteProjectUnavailableError) return null;
      throw error;
    }
    const project = this.read().projects.find((candidate) => candidate.root === canonical);
    return project ? this.public(project) : null;
  }

  resolve(projectId: string): { id: string; name: string; root: string } | null {
    const project = this.read().projects.find((candidate) => candidate.id === projectId);
    if (!project) return null;
    // Re-check at use time. A project directory can be replaced after enrollment.
    const root = this.availableRoot(project);
    if (!root) return null;
    return { id: project.id, name: project.name, root };
  }

  remove(projectId: string): boolean {
    const current = this.read();
    const projects = current.projects.filter((project) => project.id !== projectId);
    if (projects.length === current.projects.length) return false;
    this.write({ version: 1, projects });
    return true;
  }

  private cleanName(value: string): string {
    const name = value.trim();
    if (!name || name.length > 120 || /[\u0000-\u001f]/.test(name)) {
      throw new Error('Remote project names must be between 1 and 120 printable characters.');
    }
    return name;
  }

  private availableRoot(project: StoredProject): string | null {
    try {
      const root = canonicalDirectory(project.root);
      return root === project.root ? root : null;
    } catch (error) {
      if (error instanceof RemoteProjectUnavailableError) return null;
      throw error;
    }
  }

  private public(project: StoredProject): RemoteProjectSummary {
    return { id: project.id, name: project.name };
  }

  private read(): ProjectFile {
    if (this.cache) return this.cache;
    const ownsDirectory = migratePrivateDirectory(dirname(this.path));
    if (!existsSync(this.path)) return (this.cache = { version: 1, projects: [] });
    if (ownsDirectory) migratePrivateFile(this.path);
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as ProjectFile;
      this.cache = parsed?.version === 1 && Array.isArray(parsed.projects) ? parsed : { version: 1, projects: [] };
    } catch (error) {
      console.error('[remote] project catalog unreadable:', error);
      this.cache = { version: 1, projects: [] };
    }
    return this.cache;
  }

  private write(next: ProjectFile): void {
    writePrivateFileAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`);
    this.cache = next;
  }
}
