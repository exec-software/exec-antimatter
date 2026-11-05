import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The tree the tools may touch. Antimatter sets this when the user picks a working
 * directory; without one we fall back to the home directory rather than the whole disk.
 */
export const workspaceRoot = (): string =>
  resolve(process.env.ANTIMATTER_WORKSPACE || process.env.CODING_WORKSPACE_PATH || homedir());

const containedBy = (root: string, target: string): boolean =>
  target === root || target.startsWith(root + sep);

/** `existsSync` follows links, so a broken symlink would otherwise look like a new path. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Returns the path itself when it exists, or the closest existing parent for a path a write is
 * about to create. Resolving that ancestor catches a symlink in any already-present component.
 */
function nearestExisting(path: string): string {
  let cursor = path;
  while (!entryExists(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
  return cursor;
}

/**
 * Resolves `candidate` and refuses anything outside the workspace. Every tool that touches
 * the filesystem goes through here, so "../../.ssh/id_rsa" cannot be read by asking nicely.
 */
export function insideWorkspace(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(absoluteRoot, candidate);
  if (!containedBy(absoluteRoot, target)) {
    throw new Error(`Refused: "${candidate}" is outside the workspace (${root}).`);
  }

  // Lexical containment is insufficient: `workspace/link/file` may resolve through `link` to a
  // directory outside the workspace. Existing targets are checked directly; new targets are
  // checked through the nearest ancestor that already exists.
  const realRoot = realpathSync(absoluteRoot);
  const realAnchor = realpathSync(nearestExisting(target));
  if (!containedBy(realRoot, realAnchor)) {
    throw new Error(`Refused: "${candidate}" resolves outside the workspace (${root}).`);
  }
  return target;
}

/** Paths shown to the model are relative, so it never has to reason about absolute prefixes. */
export const display = (root: string, target: string): string => relative(root, target) || '.';

/** Directories that are never worth walking and would swamp any result. */
export const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'build',
  'release',
  'target',
  'vendor',
  '.next',
  '.cache',
  '.venv',
  '__pycache__',
]);

export interface WalkOptions {
  maxEntries?: number;
  /** Skips files bigger than this; they are almost always build output or media. */
  maxFileBytes?: number;
}

/** Depth-first walk of the workspace, yielding absolute file paths. */
export function* walkFiles(root: string, options: WalkOptions = {}): Generator<string> {
  const maxEntries = options.maxEntries ?? 20_000;
  const stack: string[] = [root];
  let seen = 0;

  while (stack.length) {
    const directory = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip rather than fail the whole tool
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      const full = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      if (options.maxFileBytes) {
        try {
          if (statSync(full).size > options.maxFileBytes) continue;
        } catch {
          continue;
        }
      }

      yield full;
      if (++seen >= maxEntries) return;
    }
  }
}

/**
 * Text files never contain NUL; binary files almost always do. The character is built rather
 * than written literally, because a literal NUL in a source file makes it a binary blob to git.
 */
const NUL = String.fromCharCode(0);

export const looksBinary = (content: string): boolean => content.includes(NUL);
