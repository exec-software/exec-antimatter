import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { dump, FAILSAFE_SCHEMA, load } from 'js-yaml';
import { SECRET_PATTERNS } from '../../../mcp/tools/security';
import { ensurePrivateDirectory, migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from '../privateState';
import { NIL_MANIFEST_NAMES } from '../environment/nilProjects';

/**
 * Memory: notes that outlast a conversation.
 *
 * Every conversation used to start from nothing. Whatever a person had explained — that they
 * commit straight to master, that the GPU source is the one to use, that a model reads a silent
 * prompt as a hang when it is a load — had to be explained again, and a correction made on
 * Tuesday was a mistake repeated on Wednesday. These are the notes that carry it across.
 *
 * Two scopes, because a fact is either about the person or about the work. Notes about the user
 * live in ~/.antimatter/memory and are read into every conversation; notes about a project live
 * in ~/.antimatter/projects/<project>/memory and are read into conversations working in it. A
 * project normally follows the git checkout. An explicitly declared NIL application inside a
 * repository owns separate notes, so a validation app does not inherit another app's history.
 *
 * Both are private app state rather than files in the project. A model writing notes into the
 * repository it is working on would put them in front of every `git status` and every commit;
 * a project's own checked-in instructions are a separate thing, read by instructions.ts.
 *
 * One Markdown file per note, with its name and a one-line description in frontmatter. That is
 * the layout Claude Code's memory uses, so a note moved between the two reads the same, and it
 * means a person can read, fix or delete a note with nothing but a text editor.
 */

export type MemoryScope = 'user' | 'project';

export interface MemoryNote {
  /** The file's name without `.md`. Stable across edits, including a rename. */
  id: string;
  scope: MemoryScope;
  name: string;
  /** The one line a conversation sees before it asks for the rest. */
  description: string;
  content: string;
  /** When the file last changed, in ms since the epoch. */
  updatedAt: number;
}

export interface NoteInput {
  name: string;
  description?: string;
  content: string;
}

export interface MemorySettings {
  /** Notes are read into conversations, and the conversation's model is given the tools to keep them. */
  enabled: boolean;
  /** A project's own AGENTS.md (or CLAUDE.md) is read into conversations and agent runs in it. */
  instructions: boolean;
}

export const DEFAULT_SETTINGS: MemorySettings = { enabled: true, instructions: true };

export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 200;
/** A note, not a document. Anything longer belongs in the project, with a note pointing at it. */
export const MAX_CONTENT = 16_000;
/** Larger than any note written here can be; a file this big was put here some other way. */
const MAX_FILE_BYTES = 64 * 1024;
/** The index Claude Code keeps beside its notes. It lists them rather than being one. */
const INDEX_FILE = 'memory.md';
const PROJECT_FILE = 'project.json';

interface SettingsFile extends MemorySettings {
  version: 1;
  /**
   * Bumped whenever a person changes a note from the Memory page.
   *
   * A conversation keeps the notes it started with (see context.ts), because rewriting the top of
   * its prompt makes a local server read the whole conversation again. A note the model saved is
   * already in its transcript, so that costs nothing. A note someone deleted from the page because
   * it was wrong is different: the conversation still believes it until this changes.
   */
  revision: number;
}

let root = join(homedir(), '.antimatter');
let settingsPath = join(root, 'memory.json');
let settingsCache: SettingsFile | null = null;

/** Where the notes live. Main sets it once; tests point it at a scratch directory. */
export const useRoot = (path: string): void => {
  root = path;
};

export const location = (): string => root;

/** Electron owns the real userData path, where settings go; main sets it once at startup. */
export const useConfigPath = (path: string): void => {
  settingsPath = path;
  settingsCache = null;
};

// ─── Settings ────────────────────────────────────────────────────────────────

function readSettingsFile(): SettingsFile {
  if (settingsCache) return settingsCache;
  const fallback: SettingsFile = { version: 1, ...DEFAULT_SETTINGS, revision: 0 };
  const ownsDirectory = migratePrivateDirectory(dirname(settingsPath));
  if (!existsSync(settingsPath)) return (settingsCache = fallback);
  if (ownsDirectory) migratePrivateFile(settingsPath);
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<SettingsFile> | null;
    settingsCache =
      parsed?.version === 1
        ? {
            version: 1,
            enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_SETTINGS.enabled,
            instructions: typeof parsed.instructions === 'boolean' ? parsed.instructions : DEFAULT_SETTINGS.instructions,
            revision: Number.isSafeInteger(parsed.revision) && parsed.revision! >= 0 ? parsed.revision! : 0,
          }
        : fallback;
  } catch (error) {
    console.error('[memory] unreadable settings, using defaults:', error);
    settingsCache = fallback;
  }
  return settingsCache;
}

function writeSettingsFile(next: SettingsFile): SettingsFile {
  writePrivateFileAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  settingsCache = next;
  return next;
}

export function settings(): MemorySettings {
  const { enabled, instructions } = readSettingsFile();
  return { enabled, instructions };
}

export function saveSettings(patch: unknown): MemorySettings {
  const source = (patch && typeof patch === 'object' ? patch : {}) as Partial<MemorySettings>;
  const current = readSettingsFile();
  const next = writeSettingsFile({
    ...current,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : current.enabled,
    instructions: typeof source.instructions === 'boolean' ? source.instructions : current.instructions,
  });
  return { enabled: next.enabled, instructions: next.instructions };
}

export const revision = (): number => readSettingsFile().revision;

/** Marks the notes as changed by a person, so conversations already open read them again. */
export function bumpRevision(): number {
  const current = readSettingsFile();
  return writeSettingsFile({ ...current, revision: current.revision + 1 }).revision;
}

// ─── Projects ────────────────────────────────────────────────────────────────

const canonical = (path: string): string => {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
};

const kindOf = (path: string): 'file' | 'directory' | null => {
  try {
    const stats = statSync(path);
    return stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : null;
  } catch {
    return null;
  }
};

/**
 * The checkout a workspace is in: the nearest directory at or above it holding `.git`, as a
 * directory or as the file a worktree or submodule has instead. Null outside any repository.
 */
export function repositoryTop(workspace: string): string | null {
  let cursor = canonical(workspace);
  for (;;) {
    if (kindOf(join(cursor, '.git'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/**
 * The main checkout behind a worktree's `.git` file, or null for anything else that has one.
 *
 * A worktree's file says `gitdir: <main>/.git/worktrees/<name>`. A submodule's also points into a
 * `.git` directory, under `modules/`, but a submodule is a different repository with different
 * facts, so only the worktree shape is followed.
 */
function mainCheckout(dotGit: string): string | null {
  try {
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8').slice(0, 4096));
    if (!pointer) return null;
    const gitdir = resolve(dirname(dotGit), pointer[1]);
    const worktree = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdir);
    if (!worktree || kindOf(join(worktree[1], '.git')) !== 'directory') return null;
    return canonical(worktree[1]);
  } catch {
    return null;
  }
}

/**
 * The directory a workspace's project notes belong to.
 *
 * Ordinary subdirectories share repository notes. A nearest NIL project manifest declares an
 * application boundary, including when several applications live in one validation repository.
 * Any of the driver's manifest formats counts: a v2 NILData project is as much an application as
 * a legacy JSON one, and recognising only the latter silently merged a current-format project's
 * notes into its parent repository's.
 * Worktrees retain the same relative application identity in their main checkout.
 */
export function projectRoot(workspace: string): string {
  const here = canonical(workspace);
  const top = repositoryTop(here);
  let application: string | null = null;
  for (let cursor = here; ; cursor = dirname(cursor)) {
    // The marker declares identity even while its contents are being repaired.
    // Parsing it here would reload parent notes whenever an edit breaks the manifest.
    const declared = NIL_MANIFEST_NAMES.some(name => {
      try { return lstatSync(join(cursor, name)).isFile(); }
      catch { return false; /* An absent marker does not declare an application. */ }
    });
    if (declared) {
      application = cursor;
      break;
    }
    if (cursor === top || dirname(cursor) === cursor) break;
  }
  if (!top) return application ?? here;
  const primary = kindOf(join(top, '.git')) === 'file' ? mainCheckout(join(top, '.git')) ?? top : top;
  return application ? join(primary, relative(top, application)) : primary;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 8);

/** The path with every separator and odd character as a dash, the way Claude Code names its project directories. */
const readableSlug = (projectRootPath: string): string => projectRootPath.replace(/[^A-Za-z0-9]/g, '-');

const projectsDirectory = (): string => join(root, 'projects');

/** The root a project directory was made for; undefined when it has none recorded. */
function recordedRoot(directory: string): string | null | undefined {
  const file = join(directory, PROJECT_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { root?: unknown };
    return typeof parsed.root === 'string' ? parsed.root : null;
  } catch {
    return null;
  }
}

/**
 * Where a project's notes live, claiming the directory when `claim` is set.
 *
 * The readable name is lossy — `/a/b-c` and `/a-b/c` read the same — so each directory records
 * the root it belongs to, and a second project that lands on a taken name gets a hashed one. A
 * directory with no record is adopted: that is what someone copying notes in by hand makes.
 */
function projectDirectory(projectRootPath: string, claim: boolean): string {
  const readable = readableSlug(projectRootPath);
  const hashed = `${readable.slice(0, 150)}-${hash(projectRootPath)}`;
  for (const slug of readable.length <= 160 ? [readable, hashed] : [hashed]) {
    const directory = join(projectsDirectory(), slug);
    const recorded = recordedRoot(directory);
    if (recorded === projectRootPath) return directory;
    if (recorded === undefined) {
      if (claim) {
        writePrivateFileAtomic(
          join(directory, PROJECT_FILE),
          `${JSON.stringify({ version: 1, root: projectRootPath }, null, 2)}\n`
        );
      }
      return directory;
    }
  }
  return join(projectsDirectory(), hashed);
}

export const userDirectory = (): string => join(root, 'memory');

export const projectDirectoryFor = (projectRootPath: string, claim = false): string =>
  join(projectDirectory(projectRootPath, claim), 'memory');

export function directoryFor(scope: MemoryScope, projectRootPath: string | null, claim = false): string {
  if (scope === 'user') return userDirectory();
  if (!projectRootPath) throw new Error('Project notes need a project.');
  return projectDirectoryFor(projectRootPath, claim);
}

export interface ProjectSummary {
  root: string;
  directory: string;
  notes: number;
  /** The newest note's time, or null with none. */
  updatedAt: number | null;
}

/** Every project with notes of its own, most recently changed first. */
export function knownProjects(): ProjectSummary[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(projectsDirectory(), { withFileTypes: true });
  } catch {
    return [];
  }
  const projects: ProjectSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const container = join(projectsDirectory(), entry.name);
    const recorded = recordedRoot(container);
    if (typeof recorded !== 'string') continue;
    const directory = join(container, 'memory');
    const notes = readNotes(directory, 'project');
    if (!notes.length) continue;
    projects.push({ root: recorded, directory, notes: notes.length, updatedAt: notes[0].updatedAt });
  }
  return projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.root.localeCompare(b.root));
}

// ─── Notes ───────────────────────────────────────────────────────────────────

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

const clip = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;

/**
 * A file name for a note, from its name: `Push straight to master` → `push-straight-to-master`.
 * A name with nothing Latin in it would slug to nothing, so it gets a stable hash instead.
 */
export function slugFor(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || `note-${hash(name)}`;
}

/** An id that names a file in a notes directory and nothing outside it. */
const validId = (id: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9 ._-]{0,119}$/.test(id) && !id.includes('..');

const fileFor = (directory: string, id: string): string => {
  if (!validId(id)) throw new Error(`"${id}" is not a note.`);
  return join(directory, `${id}.md`);
};

const titleFromId = (id: string): string => {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : id;
};

/** The first sentence of a note, for one that was written without a description. */
const firstSentence = (content: string): string => {
  const line = content.split('\n').map((entry) => entry.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '';
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(line)?.[1] ?? line;
  return clip(oneLine(sentence), MAX_DESCRIPTION);
};

export function parseNote(id: string, scope: MemoryScope, text: string, updatedAt: number): MemoryNote {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fence = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  let fields: Record<string, unknown> = {};
  if (fence) {
    try {
      const parsed = load(fence[1], { schema: FAILSAFE_SCHEMA });
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
    } catch {
      // A note whose frontmatter does not parse is still a note: its body is the useful part.
    }
  }
  const content = (fence ? normalized.slice(fence[0].length) : normalized).trim();
  const field = (value: unknown): string => (typeof value === 'string' ? oneLine(value) : '');
  return {
    id,
    scope,
    name: clip(field(fields.name) || titleFromId(id), MAX_NAME),
    description: clip(field(fields.description) || firstSentence(content), MAX_DESCRIPTION),
    content,
    updatedAt,
  };
}

export function serializeNote(note: Pick<MemoryNote, 'name' | 'description' | 'content'>): string {
  const frontmatter = dump({ name: note.name, description: note.description }, { lineWidth: -1, noRefs: true });
  return `---\n${frontmatter}---\n\n${note.content.trim()}\n`;
}

export function readNotes(directory: string, scope: MemoryScope): MemoryNote[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const notes: MemoryNote[] = [];
  for (const entry of entries) {
    // Symlinks are skipped with everything else that is not a plain file: a note is text that
    // goes into a prompt, and a link could make that text anything on the disk.
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.toLowerCase() === INDEX_FILE) continue;
    const id = entry.name.slice(0, -3);
    if (!validId(id)) continue;
    const path = join(directory, entry.name);
    try {
      const stats = lstatSync(path);
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) continue;
      notes.push(parseNote(id, scope, readFileSync(path, 'utf8'), stats.mtimeMs));
    } catch (error) {
      console.warn(`[memory] could not read ${path}:`, error);
    }
  }
  return notes.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

/**
 * The note a name refers to: by id, then by name, then by the id that name would have.
 *
 * A model asks for notes by the name it was shown, a person's hand-made file may be named
 * anything, and a note renamed from the page keeps its file. All three have to find it.
 */
export function findNote(notes: MemoryNote[], reference: string): MemoryNote | null {
  const wanted = oneLine(reference).replace(/\.md$/i, '');
  if (!wanted) return null;
  const lower = wanted.toLowerCase();
  return (
    notes.find((note) => note.id === wanted) ??
    notes.find((note) => note.name.toLowerCase() === lower) ??
    notes.find((note) => note.id === slugFor(wanted)) ??
    null
  );
}

/** Why a note cannot be kept as written, or null when it can. */
export function credentialIn(input: NoteInput): string | null {
  const text = `${input.name}\n${input.description ?? ''}\n${input.content}`;
  return SECRET_PATTERNS.find((pattern) => pattern.regex.test(text))?.description ?? null;
}

/** The note as it will be stored, or the reason it cannot be. */
export function normalizeInput(input: NoteInput): { name: string; description: string; content: string } | string {
  const name = clip(oneLine(String(input?.name ?? '')), MAX_NAME);
  const content = String(input?.content ?? '').replace(/\r\n/g, '\n').trim();
  if (!name) return 'A note needs a name: a few words saying what it is about.';
  if (!content) return `"${name}" has nothing in it. Write what the note should say.`;
  if (content.length > MAX_CONTENT) {
    return (
      `"${name}" is ${content.length} characters, and a note holds at most ${MAX_CONTENT}. Keep what the next ` +
      'conversation needs to know, and put anything longer in a file in the project with the note pointing at it.'
    );
  }
  const credential = credentialIn({ name, description: input?.description, content });
  if (credential) {
    return (
      `"${name}" looks like it contains a credential (${credential.toLowerCase()}). Notes are read into ` +
      'conversations and can reach whichever source answers them, so they never hold secrets. Say where the ' +
      'secret is kept instead.'
    );
  }
  const description = clip(oneLine(String(input?.description ?? '')), MAX_DESCRIPTION) || firstSentence(content);
  return { name, description, content };
}

export interface SavedNote {
  note: MemoryNote;
  /** False when an existing note was replaced. */
  created: boolean;
}

function writeNote(directory: string, id: string, scope: MemoryScope, fields: { name: string; description: string; content: string }): MemoryNote {
  const path = fileFor(directory, id);
  ensurePrivateDirectory(directory);
  writePrivateFileAtomic(path, serializeNote(fields));
  return { id, scope, ...fields, updatedAt: lstatSync(path).mtimeMs };
}

const uniqueId = (notes: MemoryNote[], base: string): string => {
  const taken = new Set(notes.map((note) => note.id));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) if (!taken.has(`${base}-${index}`)) return `${base}-${index}`;
};

/**
 * Saves a note under its name: one with that name already is replaced, anything else is new.
 *
 * This is the model's way in. Replacing by name is what lets it correct a note rather than pile a
 * second, contradicting one beside it, and the prompt tells it so.
 */
export function rememberNote(scope: MemoryScope, projectRootPath: string | null, input: NoteInput): SavedNote {
  const fields = normalizeInput(input);
  if (typeof fields === 'string') throw new Error(fields);
  const directory = directoryFor(scope, projectRootPath, true);
  const notes = readNotes(directory, scope);
  const existing = findNote(notes, fields.name);
  const id = existing?.id ?? uniqueId(notes, slugFor(fields.name));
  return { note: writeNote(directory, id, scope, fields), created: !existing };
}

/**
 * Saves a note from the Memory page: `id` names the one being edited, and without one the note is
 * new even if another has the same name — a person adding a note has not asked to overwrite one.
 */
export function saveNote(scope: MemoryScope, projectRootPath: string | null, input: NoteInput & { id?: string }): SavedNote {
  const fields = normalizeInput(input);
  if (typeof fields === 'string') throw new Error(fields);
  const directory = directoryFor(scope, projectRootPath, true);
  const notes = readNotes(directory, scope);
  const existing = input.id ? notes.find((note) => note.id === input.id) ?? null : null;
  const id = existing?.id ?? (input.id && validId(input.id) ? input.id : uniqueId(notes, slugFor(fields.name)));
  return { note: writeNote(directory, id, scope, fields), created: !existing };
}

/** Deletes one note. False when there was nothing by that id to delete. */
export function removeNote(scope: MemoryScope, projectRootPath: string | null, id: string): boolean {
  const path = fileFor(directoryFor(scope, projectRootPath), id);
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() && !stats.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}

export function notesFor(scope: MemoryScope, projectRootPath: string | null): MemoryNote[] {
  if (scope === 'project' && !projectRootPath) return [];
  return readNotes(directoryFor(scope, projectRootPath), scope);
}
