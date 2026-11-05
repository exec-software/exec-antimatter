import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { IPty } from 'node-pty';

/**
 * Running what is in the editor.
 *
 * Through a pty rather than a pipe, for the same reason the terminal uses one: a test runner
 * that detects a TTY prints colour and progress, and one that does not prints a wall of plain
 * text with the interesting line buried in it. The cost is that output arrives as terminal
 * bytes, which is fine — the console pane is a terminal.
 *
 * One run at a time. Two concurrent runs of the same file racing over the same output pane is
 * not a feature anybody asked for, and a Stop button that has to ask which one is worse than
 * the limitation.
 */

export interface RunSpec {
  command: string;
  args: string[];
  cwd: string;
  /** Shown in the console header, so a run says what it is. */
  label: string;
}

export interface RunState {
  id: string;
  spec: RunSpec;
  startedAt: number;
  pid: number | null;
  exit: { code: number; signal?: number } | null;
}

export interface ExecEvents {
  onData(id: string, data: string): void;
  onExit(id: string, exit: { code: number; signal?: number }): void;
}

let events: ExecEvents | null = null;
let pty: typeof import('node-pty') | null = null;
interface Running { state: RunState; pty: IPty; killTimer?: ReturnType<typeof setTimeout> }
let running: Running | null = null;
let launchGeneration = 0;

export const connect = (handlers: ExecEvents): void => {
  events = handlers;
};

async function ptyModule(): Promise<typeof import('node-pty')> {
  if (pty) return pty;
  try {
    pty = await import('node-pty');
  } catch (error) {
    throw new Error(
      `Running needs node-pty, which did not load: ${(error as Error).message}. ` +
        `It is compiled against Electron's ABI — run "npm run rebuild:native" to rebuild it.`
    );
  }
  return pty;
}

/**
 * How to run a file, by extension.
 *
 * A guess, and presented as one: the toolbar shows the command and lets it be edited before
 * anything runs. Guessing wrong is then a visible, correctable thing rather than a mystery
 * failure, and a project with its own way of running is one edit away rather than unsupported.
 */
export function suggestCommand(relativePath: string, root: string): string {
  const quoted = /[\s"']/.test(relativePath) ? JSON.stringify(relativePath) : relativePath;
  const has = (name: string) => existsSync(join(root, name));

  switch (extname(relativePath).toLowerCase()) {
    case '.ny':
    case '.matrix':
    case '.mat':
    case '.nil':
      return `ny run ${JSON.stringify(relativePath)}`;
    case '.js':
    case '.mjs':
    case '.cjs':
      return `node ${quoted}`;
    case '.ts':
    case '.tsx':
      // tsx if the project has it, since plain node cannot run TypeScript on Node 20.
      return has('node_modules/.bin/tsx') ? `./node_modules/.bin/tsx ${quoted}` : `npx tsx ${quoted}`;
    case '.py':
      return has('.venv/bin/python') ? `./.venv/bin/python ${quoted}` : `python3 ${quoted}`;
    case '.sh':
      return `bash ${quoted}`;
    case '.rb':
      return `ruby ${quoted}`;
    case '.go':
      return `go run ${quoted}`;
    case '.rs':
      return has('Cargo.toml') ? 'cargo run' : `rustc ${quoted} -o /tmp/antimatter-run && /tmp/antimatter-run`;
    case '.php':
      return `php ${quoted}`;
    case '.lua':
      return `lua ${quoted}`;
    default:
      return has('package.json') ? 'npm test' : '';
  }
}

/**
 * Splits a command line the way a shell would for the simple cases, so `python3 "my file.py"`
 * works without handing the whole string to a shell.
 */
export function splitCommand(line: string): { command: string; args: string[] } {
  const parts = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const cleaned = parts.map((part) =>
    (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))
      ? part.slice(1, -1)
      : part
  );
  return { command: cleaned[0] ?? '', args: cleaned.slice(1) };
}

export const current = (): RunState | null => running?.state ?? null;

export async function start(spec: RunSpec, loadPty: () => Promise<typeof import('node-pty')> = ptyModule): Promise<RunState> {
  // Stop also invalidates a launch whose native module has not loaded yet.
  stop();
  const generation = launchGeneration;
  const module = await loadPty();
  if (generation !== launchGeneration) throw new Error('Run cancelled before the process started.');
  const id = randomUUID();
  const state: RunState = { id, spec, startedAt: Date.now(), pid: null, exit: null };

  let child: IPty;
  try {
    child = module.spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: spec.cwd,
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' } as Record<string, string>,
    });
  } catch (error) {
    // A missing interpreter is the common case, and the message should say which one.
    throw new Error(`Could not run "${spec.command}": ${(error as Error).message}`);
  }

  state.pid = child.pid;
  const owned: Running = { state, pty: child };
  running = owned;

  child.onData((data) => { if (running?.state.id === id) events?.onData(id, data); });
  child.onExit(({ exitCode, signal }) => {
    clearTimeout(owned.killTimer);
    const exit = { code: exitCode, signal };
    state.exit = exit;
    if (running?.state.id === id) events?.onExit(id, exit);
  });

  return state;
}

/** Sends input to the running process, so a program that prompts is not a dead end. */
export function write(data: string): void {
  if (running && !running.state.exit) running.pty.write(data);
}

export function resize(cols: number, rows: number): void {
  if (running && !running.state.exit) {
    try {
      running.pty.resize(Math.max(2, cols), Math.max(2, rows));
    } catch {
      // The process can exit between the check and the call; nothing to do about it.
    }
  }
}

export function stop(): void {
  launchGeneration++;
  if (!running || running.state.exit) return;
  const owned = running;
  if (owned.killTimer) return;
  try {
    // nilbuild forwards TERM to compiler process groups and needs up to two seconds
    // to reap them. PTY's default HUP bypasses that cleanup and can orphan a compiler.
    owned.pty.kill('SIGTERM');
    owned.killTimer = setTimeout(() => {
      if (!owned.state.exit) { try { owned.pty.kill('SIGKILL'); } catch { /* already gone */ } }
    }, 5000);
    owned.killTimer.unref();
  } catch { /* already gone */ }
}

export function shutdown(): void {
  stop();
  running = null;
}
