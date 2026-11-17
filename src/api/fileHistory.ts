import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Local file history: the bytes behind the audit trail.
 *
 * A carbon records why a turn did what it did, and deliberately does not keep the data — its own
 * comment says to keep "enough to be evidence, not the whole file", and it clips accordingly. So
 * the audit can tell you exactly which turn ruined a file and cannot give you the file back. This
 * is the other half: every tool write first stores what the file held a moment earlier, keyed so
 * the two can be joined.
 *
 * Not git, on purpose. Git history is a curated artefact and a commit per edit destroys the thing
 * that makes it worth reading. This is the opposite: every change, no judgement, never pushed,
 * evicted when it gets big. The two coexist because they answer different questions — git says
 * what the project is meant to be, this says what the file was ten minutes ago.
 *
 * Captured inside the tool rather than asked for. An agent that intends to commit first and then
 * does not is the ordinary case, and no instruction fixes it: the guarantee has to sit below the
 * model, where there is no decision to make.
 */

/** One directory in the workspace for everything local and disposable. */
export const ANTIMATTER_DIR = '.antimatter';

/** Larger than this is not captured; the timeline records the gap rather than hiding it. */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

/** Total blob budget per workspace before the oldest versions are evicted. */
export const DEFAULT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

/** Pruning walks the store, so it runs on a fraction of writes rather than on each one. */
const PRUNE_EVERY = 32;

export const antimatterDir = (workspace: string): string => join(workspace, ANTIMATTER_DIR);
export const historyDir = (workspace: string): string => join(antimatterDir(workspace), 'history');
export const blobsDir = (workspace: string): string => join(historyDir(workspace), 'blobs');
export const timelinePath = (workspace: string): string => join(historyDir(workspace), 'timeline.jsonl');

/**
 * A shared scratch area, inside the workspace rather than under /tmp.
 *
 * Intermediate output belongs somewhere the next agent can find it: two models asked the same
 * question should not each rebuild the same intermediate file because the first one put it in a
 * private temporary directory that went away. It is also the difference between a project tree
 * littered with `out2.json` and one that stays clean.
 */
export const scratchDir = (workspace: string): string => join(antimatterDir(workspace), 'scratch');

/** What a capture records. One line of `timeline.jsonl`. */
export interface HistoryEntry {
  /** ISO time of the capture, which is just before the write that caused it. */
  at: string;
  /** Workspace-relative path, POSIX separators, so a timeline is readable and portable. */
  path: string;
  /** sha256 of the prior contents, and the blob's name. Absent when there was nothing to keep. */
  blob?: string;
  /** Size of the prior contents in bytes. */
  bytes?: number;
  /** Why there is no blob: the file did not exist yet, or it was past the capture ceiling. */
  skipped?: 'created' | 'too-large';
  /** The tool that was about to write. */
  tool?: string;
  /** Joins to the carbon: which conversation and which turn asked for this. */
  thread?: string;
  turn?: string;
  /** Which agent, when a delegated run did it rather than the conversation itself. */
  actor?: string;
}

/** Provenance a caller knows and the store cannot work out for itself. */
export interface CaptureContext {
  tool?: string;
  thread?: string;
  turn?: string;
  actor?: string;
  budgetBytes?: number;
}

/**
 * Whether history is on for this workspace.
 *
 * The signal is the directory, not a setting, because the check runs in the tool process on every
 * write and that process has no view of the application's settings. Antimatter creates the
 * directory when the experimental flag is on; deleting it turns the feature off and discards the
 * store, which is the behaviour someone deleting a directory called `history` expects.
 *
 * Cached, so "off" costs one `stat` per workspace per process rather than one per write. That is
 * what keeps a disabled install behaving exactly as it did before.
 */
const enabledCache = new Map<string, boolean>();

export function historyEnabled(workspace: string): boolean {
  const cached = enabledCache.get(workspace);
  if (cached !== undefined) return cached;
  let on = false;
  try {
    on = statSync(historyDir(workspace)).isDirectory();
  } catch {
    on = false;
  }
  enabledCache.set(workspace, on);
  return on;
}

/** Tests and the moment after enabling, where the cached answer is now wrong. */
export function forgetHistoryState(workspace?: string): void {
  if (workspace === undefined) enabledCache.clear();
  else enabledCache.delete(workspace);
}

/**
 * Create the workspace-local directory, its scratch area, and the history store.
 *
 * The `.gitignore` holding `*` ignores the directory including itself, so turning this on never
 * shows up as a change to the project and cannot be committed by accident. That matters more than
 * it sounds: a store of every intermediate version of every file is precisely what should not
 * reach a remote.
 */
export function ensureWorkspaceHistory(workspace: string, options: { history?: boolean } = {}): void {
  const root = antimatterDir(workspace);
  mkdirSync(scratchDir(workspace), { recursive: true });
  const ignore = join(root, '.gitignore');
  if (!existsSync(ignore)) {
    writeFileSync(
      ignore,
      '# Everything here is local to this machine: scratch files and local file history.\n' +
        '# Ignoring the directory including this file, so enabling it never shows as a project change.\n' +
        '*\n',
      'utf8'
    );
  }
  if (options.history !== false) mkdirSync(blobsDir(workspace), { recursive: true });
  forgetHistoryState(workspace);
}

/** Fan out by the first byte of the hash, so one directory never holds every version. */
const blobPath = (workspace: string, hash: string): string =>
  join(blobsDir(workspace), hash.slice(0, 2), hash.slice(2));

export const relativePath = (workspace: string, target: string): string => {
  const prefix = workspace.endsWith('/') ? workspace : `${workspace}/`;
  const value = target.startsWith(prefix) ? target.slice(prefix.length) : target;
  return value.split('\\').join('/');
};

let sincePrune = 0;

/**
 * Store what `target` holds right now, before a caller overwrites it.
 *
 * Throws rather than warning. The point of capturing inside the tool is a guarantee, and a
 * capture that quietly failed would leave exactly the silent gap the feature exists to remove —
 * discovered, if ever, in the one moment somebody needed it. A caller that would rather write than
 * protect should not have turned this on.
 */
export function captureBeforeWrite(
  workspace: string,
  target: string,
  context: CaptureContext = {}
): HistoryEntry | null {
  if (!historyEnabled(workspace)) return null;

  const path = relativePath(workspace, target);
  // Never record the store inside itself, and never record scratch: one would recurse and the
  // other is disposable by definition.
  if (path === ANTIMATTER_DIR || path.startsWith(`${ANTIMATTER_DIR}/`)) return null;

  const entry: HistoryEntry = { at: new Date().toISOString(), path, ...context };
  delete (entry as { budgetBytes?: number }).budgetBytes;

  let size: number | null = null;
  try {
    const stats = statSync(target);
    if (!stats.isFile()) return null;
    size = stats.size;
  } catch {
    // Nothing there yet. Recorded anyway: restoring "to before this turn" has to be able to
    // delete a file the turn created, and only this line says it did not exist before.
    entry.skipped = 'created';
    append(workspace, entry);
    return entry;
  }

  if (size > MAX_CAPTURE_BYTES) {
    entry.skipped = 'too-large';
    entry.bytes = size;
    append(workspace, entry);
    return entry;
  }

  const content = readFileSync(target);
  const hash = createHash('sha256').update(content).digest('hex');
  const destination = blobPath(workspace, hash);
  if (!existsSync(destination)) {
    // Content-addressed, so an unchanged file costs nothing and a reverted file costs nothing
    // twice. Written through a temporary name so a crash cannot leave a half-written version
    // under a hash that claims to be complete.
    mkdirSync(dirname(destination), { recursive: true });
    const staging = `${destination}.${process.pid}.tmp`;
    writeFileSync(staging, deflateSync(content));
    renameSync(staging, destination);
  }
  entry.blob = hash;
  entry.bytes = content.byteLength;
  append(workspace, entry);

  sincePrune += 1;
  if (sincePrune >= PRUNE_EVERY) {
    sincePrune = 0;
    try {
      pruneHistory(workspace, context.budgetBytes ?? DEFAULT_BUDGET_BYTES);
    } catch {
      // Eviction is housekeeping. Failing it must not fail the write it was keeping room for.
    }
  }
  return entry;
}

function append(workspace: string, entry: HistoryEntry): void {
  appendFileSync(timelinePath(workspace), `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Every recorded version, oldest first. A malformed line is skipped, never fatal. */
export function readTimeline(workspace: string): HistoryEntry[] {
  let raw: string;
  try {
    raw = readFileSync(timelinePath(workspace), 'utf8');
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as HistoryEntry;
      if (parsed && typeof parsed.path === 'string' && typeof parsed.at === 'string') entries.push(parsed);
    } catch {
      // A line torn by a crash mid-append costs that one version, not the timeline.
    }
  }
  return entries;
}

/** What one file held, newest first — the list a restore picks from. */
export function versionsOf(workspace: string, path: string): HistoryEntry[] {
  const wanted = path.split('\\').join('/');
  return readTimeline(workspace)
    .filter((entry) => entry.path === wanted)
    .reverse();
}

/** Everything a single turn was about to change, so a whole step can be put back. */
export function versionsOfTurn(workspace: string, turn: string): HistoryEntry[] {
  return readTimeline(workspace).filter((entry) => entry.turn === turn);
}

/** The stored contents of one version. */
export function readVersion(workspace: string, hash: string): Buffer {
  return inflateSync(readFileSync(blobPath(workspace, hash)));
}

/**
 * Drop the oldest versions until the store fits its budget.
 *
 * A blob is only removed once no surviving entry refers to it, because content addressing means
 * one blob can be the prior state of many writes. The timeline is rewritten through a temporary
 * file so an interrupted prune cannot truncate it.
 */
export function pruneHistory(workspace: string, budgetBytes = DEFAULT_BUDGET_BYTES): { removed: number; freed: number } {
  const entries = readTimeline(workspace);
  const sizes = new Map<string, number>();
  let total = 0;
  for (const [hash, path] of blobEntries(workspace)) {
    try {
      const size = statSync(path).size;
      sizes.set(hash, size);
      total += size;
    } catch {
      // Raced with another prune; whatever is gone is already free.
    }
  }
  if (total <= budgetBytes) return { removed: 0, freed: 0 };

  let keepFrom = 0;
  let freed = 0;
  // Walk oldest-first, releasing a blob only when the entry dropping it was its last mention.
  while (keepFrom < entries.length && total - freed > budgetBytes) {
    const entry = entries[keepFrom];
    keepFrom += 1;
    if (!entry.blob) continue;
    const stillUsed = entries.slice(keepFrom).some((later) => later.blob === entry.blob);
    if (stillUsed) continue;
    freed += sizes.get(entry.blob) ?? 0;
    try {
      rmSync(blobPath(workspace, entry.blob), { force: true });
    } catch {
      // Already gone.
    }
  }

  const kept = entries.slice(keepFrom);
  const staging = `${timelinePath(workspace)}.${process.pid}.tmp`;
  writeFileSync(staging, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
  renameSync(staging, timelinePath(workspace));
  return { removed: keepFrom, freed };
}

function* blobEntries(workspace: string): Generator<[string, string]> {
  let shards: string[];
  try {
    shards = readdirSync(blobsDir(workspace));
  } catch {
    return;
  }
  for (const shard of shards) {
    const dir = join(blobsDir(workspace), shard);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.tmp')) continue;
      yield [`${shard}${name}`, join(dir, name)];
    }
  }
}
