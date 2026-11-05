import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

type PrivatePathKind = 'directory' | 'file';

/**
 * Tighten an older state path without making a permissions migration an application-startup
 * dependency. Symlinks and unexpected path types are deliberately left alone: following one
 * here could chmod something Antimatter does not own.
 */
function migrateExisting(path: string, kind: PrivatePathKind): boolean {
  if (!existsSync(path)) return false;
  try {
    const stats = lstatSync(path);
    const expected = kind === 'directory' ? stats.isDirectory() : stats.isFile();
    if (!expected || stats.isSymbolicLink()) return false;
    chmodSync(path, kind === 'directory' ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE);
    return true;
  } catch (error) {
    console.warn(`[private-state] could not secure ${kind} ${path}:`, error);
    return false;
  }
}

export const migratePrivateDirectory = (path: string): boolean => migrateExisting(path, 'directory');
export const migratePrivateFile = (path: string): boolean => migrateExisting(path, 'file');

/** Create an owned state directory and make an existing one private before writing into it. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`private state path is not an owned directory: ${path}`);
  }
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

/**
 * Replace one private file atomically. A unique, exclusive temporary file prevents a stale temp
 * path or symlink from redirecting a write, and its 0600 mode follows the inode through rename.
 *
 * Bytes are accepted as well as text, for the one piece of private state that is not JSON: the
 * copy of a chosen notification sound. `encoding` applies to a string and is ignored for a
 * buffer, so both take exactly the same path.
 */
export function writePrivateFileAtomic(path: string, contents: string | Uint8Array): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: PRIVATE_FILE_MODE });
    chmodSync(temporary, PRIVATE_FILE_MODE);
    renameSync(temporary, path);
    chmodSync(path, PRIVATE_FILE_MODE);
  } finally {
    rmSync(temporary, { force: true });
  }
}
