import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

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
 * Whether this process is a test run, and whether it was given a home of its own.
 *
 * `npm test` points HOME at a temporary directory for every test child, so a store writing to
 * `~/.antimatter` there is writing inside the sandbox and is perfectly safe. A test run started
 * another way — `npx tsx --test test/foo.test.ts`, an editor's runner — inherits the real HOME,
 * and then every default store path is live user data.
 */
export function detectTestRun(
  environment: Record<string, string | undefined>,
  argv: readonly string[],
  execArgv: readonly string[]
): { underTest: boolean; sandboxedHome: boolean } {
  const sandboxedHome = environment.ANTIMATTER_TEST_HOME !== undefined;
  return {
    sandboxedHome,
    underTest:
      sandboxedHome ||
      // Set by node:test in every child it runs, and the only signal that survives a loader:
      // under `tsx --test` the flag is gone from both argv and execArgv by the time a test runs.
      // Guessing at argv alone was tried, did not fire, and wrote a file into a real home.
      environment.NODE_TEST_CONTEXT !== undefined ||
      argv.includes('--test') ||
      execArgv.includes('--test'),
  };
}

const { underTest: UNDER_TEST, sandboxedHome: SANDBOXED_HOME } =
  detectTestRun(process.env, process.argv, process.execArgv);

/**
 * Refuse to write live application state from a test.
 *
 * Every private store funnels through the write below, which makes this the one place that can
 * say no on behalf of all of them. It exists because the alternative was demonstrated: the
 * conversation store's path is module state that tests redirect and restore, a write that outlived
 * its redirect landed after teardown, and 18 MiB of somebody's real conversations were replaced
 * with `{"title":"Concurrent start"}`. The bug was the late write; the reason it was expensive is
 * that the default path for a test is the user's own data.
 *
 * Deliberately not a warning. A test that reaches live state has already lost the thing that
 * makes it a test, and the only useful outcome is a loud failure naming the path.
 *
 * The decision is a pure function so it can be tested from inside a sandboxed run, where the
 * refusal itself can never fire.
 */
export function livesInUserState(
  path: string,
  context: { underTest: boolean; sandboxedHome: boolean; home: string }
): boolean {
  if (!context.underTest || context.sandboxedHome) return false;
  const live = join(context.home, '.antimatter');
  const target = resolve(path);
  return target === live || target.startsWith(live + sep);
}

function refuseLiveState(path: string): void {
  if (!livesInUserState(path, { underTest: UNDER_TEST, sandboxedHome: SANDBOXED_HOME, home: homedir() })) return;
  throw new Error(
    `A test tried to write live application state at ${resolve(path)}. Point the store at a ` +
      'temporary directory in the test, or run the suite with `npm test`, which gives every test ' +
      'child a home of its own. Nothing was written.'
  );
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
  refuseLiveState(path);
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
