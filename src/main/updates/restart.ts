import { spawn } from 'node:child_process';
import { cleanEnvironment } from './apply';

/**
 * Starting the installed version once this process is gone.
 *
 * Electron's app.relaunch() runs its relauncher from this process's own executable. An AppImage's
 * executable lives on a FUSE mount that the AppImage runtime takes down as soon as the app exits,
 * and the relauncher goes with it: nothing starts. So a shell from the host does the waiting. It
 * waits for this process to exit rather than starting the new one beside it, because a second
 * Antimatter hands its arguments to the first through the single-instance lock and quits, and the
 * first is on its way out. If the app has not exited within two minutes, the shell gives up rather
 * than open a copy at some unrelated moment later.
 *
 * The shell starts by closing every descriptor above stdio. It inherits whatever Antimatter left
 * open without close-on-exec, such as Chromium's DevTools listener, pipes to MCP servers, and the
 * AppImage runtime's keep-alive pipe. Kept open, those would outlive the old copy: its children
 * would never see end-of-file, its mount would never be released, and the new copy could not bind
 * the old listener's port.
 */

export const RELAUNCH_SHELL = '/bin/bash';

const WAIT_THEN_EXEC = [
  'for descriptor in /proc/self/fd/*; do descriptor=${descriptor##*/}; if (( descriptor > 2 )); then exec {descriptor}>&-; fi; done',
  'pid=$1; shift; waited=0',
  'while kill -0 "$pid" 2>/dev/null; do',
  '  (( ++waited > 600 )) && exit 1',
  '  sleep 0.2',
  'done',
  'exec "$@"',
].join('\n');

export const relaunchArguments = (target: { execPath: string; args: string[] }, pid: number): string[] => [
  '-c',
  WAIT_THEN_EXEC,
  'antimatter-restart',
  String(pid),
  target.execPath,
  ...target.args,
];

export function relaunchAfterExit(
  target: { execPath: string; args: string[] },
  env: NodeJS.ProcessEnv,
  pid = process.pid,
  shell = RELAUNCH_SHELL
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, relaunchArguments(target, pid), {
      detached: true,
      stdio: 'ignore',
      env: cleanEnvironment(env),
    });
    // Do not exit the application until the host shell has actually accepted the helper. A spawn
    // error otherwise leaves the installed update with neither the old app nor a replacement.
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
