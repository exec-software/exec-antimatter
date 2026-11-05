import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dump, load } from 'js-yaml';
import {
  ensurePrivateDirectory,
  migratePrivateDirectory,
  migratePrivateFile,
  writePrivateFileAtomic,
} from '../privateState';
import { createItem, fromMarkdown, toMarkdown } from './markdown';
import {
  idlePipeline,
  isActiveStage,
  isOpen,
  parseReleaseStatus,
  type ItemDraft,
  type ItemKind,
  type ItemStatus,
  type PipelineState,
  type ProjectDetail,
  type ProjectSummary,
  type SnitchItem,
  type SnitchProject,
  type SnitchRelease,
} from './model';

/**
 * The Snitch store: projects on disk, read on demand.
 *
 * Nothing is cached. A project is a handful of small Markdown files, and the agents that fix
 * these bugs are also allowed to edit them — an in-memory copy would go stale the moment one
 * did, which is exactly the case this has to get right.
 */

export interface StoreConfig {
  root: string;
  /** True when the root came from the user rather than from the default location. */
  custom: boolean;
}

interface ConfigFile {
  version: 1;
  root: string | null;
}

let configPath = join(homedir(), '.antimatter', 'snitch.json');
let listener: ((reason: string) => void) | null = null;

/** Electron owns the real userData path; main sets it once at startup. */
export const useConfigPath = (path: string): void => {
  configPath = path;
};

export const onChange = (callback: (reason: string) => void): void => {
  listener = callback;
};

const announce = (reason: string) => listener?.(reason);

const defaultRoot = () => join(homedir(), '.antimatter', 'snitch');

/** Custom Snitch roots may be shared with exec-snitch, so do not chmod their parent directories. */
const writeExternalAtomic = (path: string, contents: string) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    writeFileSync(descriptor, contents);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
};

export function config(): StoreConfig {
  const ownsDirectory = migratePrivateDirectory(dirname(configPath));
  if (!existsSync(configPath)) return { root: defaultRoot(), custom: false };
  if (ownsDirectory) migratePrivateFile(configPath);
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as ConfigFile;
    const root = typeof parsed?.root === 'string' && parsed.root.trim() ? parsed.root.trim() : null;
    return root ? { root, custom: true } : { root: defaultRoot(), custom: false };
  } catch (error) {
    console.error('[snitch] unreadable config, using the default root:', error);
    return { root: defaultRoot(), custom: false };
  }
}

export function setRoot(root: string | null): StoreConfig {
  const next: ConfigFile = { version: 1, root: root && root.trim() ? resolve(root.trim()) : null };
  writePrivateFileAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  announce('root');
  return config();
}

const root = () => {
  const current = config();
  if (!current.custom) migratePrivateDirectory(current.root);
  return current.root;
};

const privateStore = (): boolean => !config().custom;

const ensureStoreDirectory = (path: string): void => {
  if (privateStore()) ensurePrivateDirectory(path);
  else mkdirSync(path, { recursive: true });
};

const migrateStoreFile = (path: string): void => {
  if (!privateStore()) return;
  if (migratePrivateDirectory(dirname(path))) migratePrivateFile(path);
};

const writeStoreAtomic = (path: string, contents: string): void => {
  if (privateStore()) writePrivateFileAtomic(path, contents);
  else writeExternalAtomic(path, contents);
};

/** A project name is a file name, so anything that could walk out of the root is refused. */
function assertName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A project needs a name.');
  if (/[\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error(`"${trimmed}" cannot be used as a project name.`);
  }
  return trimmed;
}

const projectPath = (name: string) => join(root(), `${assertName(name)}.yaml`);

const containedBy = (base: string, target: string): boolean => target === base || target.startsWith(base + sep);

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function nearestExisting(path: string): string {
  let cursor = path;
  while (!entryExists(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
  return cursor;
}

/** Item directories are owned by the Snitch root; project YAML cannot redirect writes/deletes. */
function safeItemsDir(project: SnitchProject, value: string, field: string): string {
  const base = resolve(dirname(project.path));
  if (isAbsolute(value)) throw new Error(`${field} must be a relative directory inside ${base}.`);

  const target = resolve(base, value);
  const lexical = relative(base, target);
  if (!lexical || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error(`${field} must name a child directory inside ${base}.`);
  }

  // Lexical checks do not catch a child symlink that points elsewhere. Check the target itself
  // when it exists, or the closest existing parent before a directory is created.
  const realBase = realpathSync(base);
  const realAnchor = realpathSync(nearestExisting(target));
  if (!containedBy(realBase, realAnchor)) {
    throw new Error(`${field} resolves outside ${base}.`);
  }
  return target;
}

const itemsDir = (project: SnitchProject, kind: ItemKind) =>
  safeItemsDir(project, kind === 'issue' ? project.issuesDir : project.requestsDir, `${kind}s_dir`);

function assertItemId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed || trimmed !== id || trimmed === '.' || trimmed === '..' || /[\\/\0]/.test(trimmed)) {
    throw new Error(`Refused unsafe Snitch item id: ${JSON.stringify(id)}.`);
  }
  return trimmed;
}

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

function readReleases(raw: unknown): SnitchRelease[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const version = asString(record.version, 'v0');
    const name = asString(record.name, 'Release');
    return {
      // Snitch backfills ids for legacy releases; do the same so ties survive a load.
      id: asString(record.id) || `REL-${Math.abs(hash(`${version}:${name}`)).toString(16).toUpperCase().padStart(8, '0')}`,
      version,
      name,
      date: asString(record.date, new Date().toISOString().slice(0, 10)),
      status: parseReleaseStatus(asString(record.status)),
      issueCount: 0,
      requestCount: 0,
    };
  });
}

const hash = (input: string): number => {
  let value = 0x811c9dc5;
  for (const char of input) value = Math.imul(value ^ char.charCodeAt(0), 0x01000193);
  return value | 0;
};

export function readProject(name: string): SnitchProject {
  const path = projectPath(name);
  if (!existsSync(path)) throw new Error(`No project named "${name}" in ${root()}.`);
  migrateStoreFile(path);

  const raw = (load(readFileSync(path, 'utf8')) ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  const projectName = asString(raw.name, name);

  const project: SnitchProject = {
    name: projectName,
    path,
    created: asString(raw.created, now),
    updated: asString(raw.updated, now),
    version: asString(raw.version, 'v0'),
    issuePrefix: asString(raw.issue_prefix, 'BUG'),
    requestPrefix: asString(raw.request_prefix, 'REQ'),
    repo: asString(raw.repo) || null,
    issuesDir: asString(raw.issues_dir, `${projectName}-issues`),
    requestsDir: asString(raw.requests_dir, `${projectName}-requests`),
    releases: readReleases(raw.releases),
  };
  // Validate both fields together on load. No read, write, or deletion is allowed to partially
  // proceed from a project file whose storage paths escape the configured root.
  itemsDir(project, 'issue');
  itemsDir(project, 'request');
  return project;
}

function readItems(project: SnitchProject, kind: ItemKind): SnitchItem[] {
  const dir = itemsDir(project, kind);
  if (!existsSync(dir)) return [];
  const ownsDirectory = privateStore() && migratePrivateDirectory(dir);

  const items: SnitchItem[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    try {
      const path = join(dir, entry.name);
      if (ownsDirectory) migratePrivateFile(path);
      const item = fromMarkdown(readFileSync(path, 'utf8'), kind);
      assertItemId(item.id);
      items.push(item);
    } catch (error) {
      console.error(`[snitch] skipping ${join(dir, entry.name)}:`, error);
    }
  }
  return items;
}

export function loadProject(name: string): ProjectDetail {
  const project = readProject(name);
  const items = [...readItems(project, 'issue'), ...readItems(project, 'request')].sort((a, b) =>
    a.created === b.created ? a.id.localeCompare(b.id) : a.created.localeCompare(b.created)
  );

  const releases = project.releases.map((release) => ({
    ...release,
    issueCount: items.filter((item) => item.kind === 'issue' && item.releaseId === release.id).length,
    requestCount: items.filter((item) => item.kind === 'request' && item.releaseId === release.id).length,
  }));

  return { ...project, releases, items };
}

function writeProject(project: SnitchProject): void {
  const document: Record<string, unknown> = {
    name: project.name,
    created: project.created,
    updated: new Date().toISOString(),
    version: project.version,
    issue_prefix: project.issuePrefix,
    request_prefix: project.requestPrefix,
    issues_dir: project.issuesDir,
    requests_dir: project.requestsDir,
    releases: project.releases.map((release) => ({
      id: release.id,
      version: release.version,
      name: release.name,
      date: release.date,
      status: release.status,
      issue_count: release.issueCount,
      request_count: release.requestCount,
    })),
  };
  // Only written when set, so a Snitch-authored project file stays as Snitch would write it.
  if (project.repo) document.repo = project.repo;

  writeStoreAtomic(project.path, dump(document, { lineWidth: 100, noRefs: true }));
}

function writeItem(project: SnitchProject, item: SnitchItem): void {
  const dir = itemsDir(project, item.kind);
  ensureStoreDirectory(dir);
  writeStoreAtomic(join(dir, `${assertItemId(item.id)}.md`), toMarkdown(item));
}

export function listProjects(): ProjectSummary[] {
  const dir = root();
  if (!existsSync(dir)) return [];

  const summaries: ProjectSummary[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const name = entry.name.replace(/\.ya?ml$/, '');
    try {
      const detail = loadProject(name);
      summaries.push({
        name: detail.name,
        path: detail.path,
        version: detail.version,
        repo: detail.repo,
        issuePrefix: detail.issuePrefix,
        requestPrefix: detail.requestPrefix,
        openItems: detail.items.filter((item) => isOpen(item.status)).length,
        totalItems: detail.items.length,
        activeItems: detail.items.filter((item) => isActiveStage(item.pipeline.stage)).length,
      });
    } catch (error) {
      console.error(`[snitch] skipping ${entry.name}:`, error);
    }
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

export function createProject(name: string, repo?: string | null): ProjectDetail {
  const clean = assertName(name);
  const path = projectPath(clean);
  if (existsSync(path)) throw new Error(`A project called "${clean}" already exists.`);

  const now = new Date().toISOString();
  const project: SnitchProject = {
    name: clean,
    path,
    created: now,
    updated: now,
    version: 'v0',
    issuePrefix: 'BUG',
    requestPrefix: 'REQ',
    repo: repo?.trim() ? resolve(repo.trim()) : null,
    issuesDir: `${clean}-issues`,
    requestsDir: `${clean}-requests`,
    releases: [
      {
        id: `REL-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
        version: 'v0',
        name: 'Initial Release',
        date: new Date().toISOString().slice(0, 10),
        status: 'active',
        issueCount: 0,
        requestCount: 0,
      },
    ],
  };

  writeProject(project);
  ensureStoreDirectory(itemsDir(project, 'issue'));
  ensureStoreDirectory(itemsDir(project, 'request'));
  announce('projects');
  return loadProject(clean);
}

export function deleteProject(name: string): void {
  const project = readProject(name);
  for (const kind of ['issue', 'request'] as ItemKind[]) {
    const dir = itemsDir(project, kind);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  rmSync(project.path, { force: true });
  announce('projects');
}

/** A prefix becomes part of an item id, so it is normalized the way Snitch normalizes it. */
export function normalizePrefix(raw: string): string {
  const trimmed = raw.trim().replace(/-+$/, '').trim();
  if (!trimmed) throw new Error('A prefix cannot be empty.');
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) throw new Error('A prefix may only contain letters, digits, "_" or "-".');
  return trimmed.toUpperCase();
}

export interface ProjectPatch {
  repo?: string | null;
  issuePrefix?: string;
  requestPrefix?: string;
  version?: string;
}

export function updateProject(name: string, patch: ProjectPatch): ProjectDetail {
  const project = readProject(name);
  writeProject({
    ...project,
    repo: patch.repo === undefined ? project.repo : patch.repo?.trim() ? resolve(patch.repo.trim()) : null,
    issuePrefix: patch.issuePrefix ? normalizePrefix(patch.issuePrefix) : project.issuePrefix,
    requestPrefix: patch.requestPrefix ? normalizePrefix(patch.requestPrefix) : project.requestPrefix,
    version: patch.version?.trim() || project.version,
  });
  announce('projects');
  return loadProject(name);
}

export function addItem(name: string, kind: ItemKind, draft: ItemDraft): ProjectDetail {
  const project = readProject(name);
  writeItem(project, createItem(kind, draft, kind === 'issue' ? project.issuePrefix : project.requestPrefix));
  announce(name);
  return loadProject(name);
}

export function findItem(name: string, itemId: string): SnitchItem | null {
  return loadProject(name).items.find((item) => item.id === itemId) ?? null;
}

export function updateItem(name: string, item: SnitchItem): ProjectDetail {
  const project = readProject(name);
  const existing = findItem(name, item.id);
  if (!existing) throw new Error(`No item ${item.id} in ${name}.`);

  // The pipeline belongs to the orchestrator, never to a form the user is editing.
  writeItem(project, { ...item, kind: existing.kind, pipeline: existing.pipeline, updated: new Date().toISOString() });
  announce(name);
  return loadProject(name);
}

const mutate = (name: string, itemIds: string[], change: (item: SnitchItem) => SnitchItem): ProjectDetail => {
  const project = readProject(name);
  const wanted = new Set(itemIds);
  const now = new Date().toISOString();
  for (const item of loadProject(name).items) {
    if (wanted.has(item.id)) writeItem(project, { ...change(item), updated: now });
  }
  announce(name);
  return loadProject(name);
};

export const setStatus = (name: string, itemIds: string[], status: ItemStatus): ProjectDetail =>
  mutate(name, itemIds, (item) => ({ ...item, status }));

export const setRelease = (name: string, itemIds: string[], releaseId: string | null): ProjectDetail =>
  mutate(name, itemIds, (item) => ({ ...item, releaseId }));

export function deleteItems(name: string, itemIds: string[]): ProjectDetail {
  const project = readProject(name);
  for (const item of loadProject(name).items) {
    if (itemIds.includes(item.id)) {
      rmSync(join(itemsDir(project, item.kind), `${assertItemId(item.id)}.md`), { force: true });
    }
  }
  announce(name);
  return loadProject(name);
}

/**
 * Pipeline writes go through here rather than updateItem, so a stage change never overwrites
 * whatever the agent just wrote into the body of the same file.
 */
export function setPipeline(name: string, itemId: string, patch: Partial<PipelineState>, status?: ItemStatus): void {
  const project = readProject(name);
  const item = findItem(name, itemId);
  if (!item) return;

  writeItem(project, {
    ...item,
    status: status ?? item.status,
    pipeline: { ...item.pipeline, ...patch, updatedAt: new Date().toISOString() },
    updated: new Date().toISOString(),
  });
  announce(name);
}

export function clearPipeline(name: string, itemId: string, status?: ItemStatus): void {
  const generation = findItem(name, itemId)?.pipeline.generation ?? 0;
  setPipeline(name, itemId, { ...idlePipeline(), generation }, status);
}

const nextVersion = (releases: SnitchRelease[]): string =>
  `v${Math.max(0, ...releases.map((release) => Number.parseInt(release.version.replace(/^v/, ''), 10) || 0)) + 1}`;

export function addRelease(name: string, releaseName: string): ProjectDetail {
  const project = readProject(name);
  writeProject({
    ...project,
    releases: [
      ...project.releases,
      {
        id: `REL-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
        version: nextVersion(project.releases),
        name: releaseName.trim() || 'Release',
        date: new Date().toISOString().slice(0, 10),
        status: 'draft',
        issueCount: 0,
        requestCount: 0,
      },
    ],
  });
  announce(name);
  return loadProject(name);
}

export function updateRelease(name: string, release: SnitchRelease): ProjectDetail {
  const project = readProject(name);
  writeProject({
    ...project,
    releases: project.releases.map((entry) => (entry.id === release.id ? { ...entry, ...release } : entry)),
  });
  announce(name);
  return loadProject(name);
}

export function deleteRelease(name: string, releaseId: string): ProjectDetail {
  const project = readProject(name);
  writeProject({ ...project, releases: project.releases.filter((entry) => entry.id !== releaseId) });
  // Deleting a release unlinks its items rather than leaving them pointing at nothing.
  const orphans = loadProject(name).items.filter((item) => item.releaseId === releaseId);
  if (orphans.length) return setRelease(name, orphans.map((item) => item.id), null);

  announce(name);
  return loadProject(name);
}

/** Every item any project has in flight, which is what the orchestrator's tracker reads. */
export function activeItems(): { project: ProjectDetail; item: SnitchItem }[] {
  const rows: { project: ProjectDetail; item: SnitchItem }[] = [];
  for (const summary of listProjects()) {
    const project = loadProject(summary.name);
    for (const item of project.items) {
      if (item.pipeline.stage !== 'idle') rows.push({ project, item });
    }
  }
  return rows;
}
