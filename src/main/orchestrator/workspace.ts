import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { HooksConfig } from './config';
import { OrchestratorError, type Workspace } from './types';

/**
 * Per-issue workspaces and the safety invariants around them (spec §9).
 *
 * §9.5 calls this the most important portability constraint, and it is the same rule the
 * built-in MCP server enforces: a path that escapes its root is refused, never clamped.
 * Clamping `../../etc/hosts` to `etc/hosts` would hide the fact that something asked.
 */

/** §4.2 / §9.5 invariant 3 — only these characters may appear in a workspace directory name. */
export const workspaceKey = (identifier: string): string => {
  const key = identifier.trim().replace(/[^A-Za-z0-9._-]/g, '_');
  if (!key || key === '.' || key === '..') {
    throw new OrchestratorError('workspace_escape', `Issue identifier "${identifier}" has no usable workspace name.`);
  }
  return key;
};

/** §9.5 invariant 2 — the workspace must resolve inside the configured root. */
export function workspacePath(root: string, identifier: string): string {
  const absoluteRoot = isAbsolute(root) ? resolve(root) : resolve(root);
  const target = resolve(absoluteRoot, workspaceKey(identifier));

  if (target !== absoluteRoot && !target.startsWith(absoluteRoot + sep)) {
    throw new OrchestratorError('workspace_escape', `Workspace for ${identifier} would fall outside ${absoluteRoot}.`);
  }
  return target;
}

/**
 * §9.2 — ensure the workspace exists, reporting whether this call created it. Workspaces are
 * reused across runs and are not deleted on success (§9.1), so an agent picks up where the last
 * attempt left off.
 */
export function ensureWorkspace(root: string, identifier: string): Workspace {
  const path = workspacePath(root, identifier);
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const existedBefore = existing !== null;

  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new OrchestratorError('workspace_escape', `${path} is a symbolic link, not an owned workspace directory.`);
    }
    if (!existing.isDirectory()) {
      throw new OrchestratorError('invalid_workspace_cwd', `${path} exists but is not a directory.`);
    }
  }
  if (!existedBefore) mkdirSync(path, { recursive: true });

  return { path, workspaceKey: workspaceKey(identifier), createdNow: !existedBefore };
}

/** §9.5 invariant 1 — refuse to run an agent anywhere but its own workspace. */
export function assertRunnableIn(workspace: Workspace, cwd: string): void {
  if (resolve(cwd) !== resolve(workspace.path)) {
    throw new OrchestratorError('invalid_workspace_cwd', `Agent cwd ${cwd} is not the workspace ${workspace.path}.`);
  }
}

export interface HookResult {
  ran: boolean;
  code: number | null;
  signal: string | null;
  output: string;
  timedOut: boolean;
}

/** §9.4 — hooks run in a shell with the workspace as cwd, under a timeout. */
export function runHook(script: string | null, cwd: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<HookResult> {
  if (!script) return Promise.resolve({ ran: false, code: 0, signal: null, output: '', timedOut: false });

  return new Promise((resolveHook) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(script, {
      cwd,
      shell: process.platform === 'win32' ? true : '/bin/bash',
      detached: grouped,
    });
    let output = '';
    let timedOut = false;
    let settled = false;

    const stop = () => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const finish = (result: HookResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', stop);
      resolveHook(result);
    };

    const collect = (chunk: Buffer) => {
      if (output.length < 64_000) output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    if (abortSignal?.aborted) stop();
    else abortSignal?.addEventListener('abort', stop, { once: true });

    child.on('error', (error) => {
      finish({ ran: true, code: null, signal: null, output: `${output}${error.message}`, timedOut });
    });

    child.on('close', (code, signal) => {
      finish({ ran: true, code, signal, output, timedOut });
    });
  });
}

/**
 * §9.4 failure semantics differ by hook, so the caller says whether a failure is fatal:
 * after_create and before_run abort, after_run and before_remove are logged and ignored.
 */
export async function runHookOrThrow(
  name: keyof Pick<HooksConfig, 'afterCreate' | 'beforeRun'>,
  script: string | null,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<HookResult> {
  const result = await runHook(script, cwd, timeoutMs, signal);
  if (!result.ran) return result;

  if (result.timedOut) {
    throw new OrchestratorError('hook_timeout', `${name} hook timed out after ${timeoutMs} ms: ${result.output.slice(0, 400)}`);
  }
  if (result.code !== 0) {
    throw new OrchestratorError('hook_failed', `${name} hook exited ${result.code}: ${result.output.slice(0, 400)}`);
  }
  return result;
}

export type WorkspaceCleanupWarning = (message: string, result: HookResult) => void;

/** §8.6 / §9 — remove a workspace for a terminal issue, after its before_remove hook. */
export async function removeWorkspace(
  root: string,
  identifier: string,
  hooks: HooksConfig,
  onWarning?: WorkspaceCleanupWarning
): Promise<boolean> {
  let path: string;
  try {
    path = workspacePath(root, identifier);
  } catch {
    return false; // an identifier we cannot map is one we never created
  }
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  // Never follow an issue-directory symlink into somebody else's tree for the hook. A worker
  // with command access can replace its directory, so cleanup must re-check rather than rely on
  // ensureWorkspace's earlier validation. Removing the link itself is safe and recoverable only
  // within the configured root; the target is untouched.
  if (entry.isSymbolicLink()) {
    unlinkSync(path);
    return true;
  }
  if (!entry.isDirectory()) {
    rmSync(path, { force: true });
    return true;
  }

  const realRoot = realpathSync(resolve(root));
  const realPath = realpathSync(path);
  if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) {
    throw new OrchestratorError('workspace_escape', `Refused to remove workspace outside ${realRoot}: ${realPath}`);
  }

  // A cleanup hook is advisory: report the failure, then remove the workspace anyway (§9.4).
  // Previously the result was discarded here, while callers assumed this function logged it.
  const before = await runHook(hooks.beforeRemove, path, hooks.timeoutMs);
  if (before.ran && (before.timedOut || before.code !== 0)) {
    const ending = before.timedOut ? `timed out after ${hooks.timeoutMs} ms` : `exited ${before.code}`;
    const output = before.output.trim();
    onWarning?.(`before_remove hook ${ending}${output ? `: ${output.slice(0, 400)}` : ''}`, before);
  }
  // The hook itself may move or replace the directory. lstat again and unlink a replacement
  // symlink rather than handing a recursive remover a path whose identity changed underneath us.
  try {
    if (lstatSync(path).isSymbolicLink()) {
      unlinkSync(path);
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  rmSync(path, { recursive: true, force: true });
  return true;
}
