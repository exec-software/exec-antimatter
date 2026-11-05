import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface TerminalLaunch { executable: string; args: string[] }

/** Never interpolate a path or a suggested command into a shell command string. */
export function terminalLaunches(platform: NodeJS.Platform, cwd: string): TerminalLaunch[] {
  if (platform === 'darwin') return [{ executable: 'open', args: ['-a', 'Terminal', cwd] }];
  if (platform === 'win32') return [
    { executable: 'wt.exe', args: ['-d', cwd] },
    { executable: 'cmd.exe', args: ['/K'] },
  ];
  return [
    { executable: 'gnome-terminal', args: ['--working-directory', cwd] },
    { executable: 'konsole', args: ['--workdir', cwd] },
    { executable: 'xfce4-terminal', args: ['--working-directory', cwd] },
    { executable: 'kitty', args: ['--directory', cwd] },
    { executable: 'alacritty', args: ['--working-directory', cwd] },
    { executable: 'xterm', args: [] },
    { executable: 'x-terminal-emulator', args: [] },
  ];
}

export function terminalDirectory(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Choose an existing project directory before opening a terminal.');
  }
  const cwd = realpathSync(value);
  if (/[\u0000-\u001f\u007f]/.test(cwd)) throw new Error('The project directory contains unsupported control characters.');
  if (!statSync(cwd).isDirectory()) throw new Error('The terminal needs a directory, not a file.');
  return cwd;
}

/** An interactive shell should not inherit Electron or the launching coding host's control ABI. */
export function externalTerminalEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(parent).filter(([key]) =>
    key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith('ELECTRON_OVERRIDE') && !key.startsWith('CODEX_')));
}

export async function openExternalTerminal(directory: unknown): Promise<void> {
  const cwd = terminalDirectory(directory);
  const env = externalTerminalEnvironment(process.env);
  for (const plan of terminalLaunches(process.platform, cwd)) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(plan.executable, plan.args, { cwd, env, shell: false, detached: true, stdio: 'ignore' });
        const timer = setTimeout(() => { child.unref(); resolve(); }, 350);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`${plan.executable} could not open a window.`));
        });
      });
      return;
    } catch {
      // A missing terminal or failed desktop launcher can fall back to another installed one.
    }
  }
  throw new Error('No desktop terminal could be opened. Use the built-in Terminal panel (Ctrl+`) instead.');
}
