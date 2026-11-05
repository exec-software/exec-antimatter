import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanChildEnv } from '../child-env';
import { clip, num, str, type ToolDef } from '../types';
import { insideWorkspace } from '../workspace';

const MAX_OUTPUT_BYTES = 200_000;

/** How long launch_program watches a program before saying it came up. */
const LAUNCH_WATCH_MS = 5_000;
const LAUNCH_WATCH_MAX_MS = 60_000;
/** Enough of a program's log to show a traceback, not so much that a chatty one swamps the turn. */
const LAUNCH_LOG_TAIL_BYTES = 12_000;

interface CommandResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Killed because it was still running when its time was up. */
  timedOut: boolean;
}

const VENV = 'python3 -m venv .venv, then .venv/bin/pip install <package>, and run the program with .venv/bin/python';

/**
 * A note after output that a model tends to misread, pointing at the fix it keeps missing.
 *
 * Asked for a GIMP clone on Ubuntu, qwen3-coder-next-80b found the system's Pillow had no ImageTk.
 * It tried pip (refused: the operating system manages that Python), apt-get (no root), a package
 * that does not exist, and the insides of the PIL directory — everything except the virtual
 * environment that would have given it a complete Pillow in one command.
 */
export function installHint(output: string): string | null {
  if (/externally-managed-environment|site-packages is not writeable/.test(output)) {
    return (
      '[note] pip will not install into this Python: it belongs to the operating system. Make a virtual ' +
      `environment in the project instead: ${VENV}.`
    );
  }
  if (/(?:ImportError|ModuleNotFoundError)[^\n]*\/usr\/lib\/python3[^\n]*\/dist-packages\//.test(output)) {
    return (
      "[note] That import came from the operating system's own Python packages, which can be incomplete — " +
      "Ubuntu's Pillow has no ImageTk, for one. A virtual environment in the project gets complete ones from " +
      `PyPI: ${VENV}.`
    );
  }
  if (/Could not open lock file \/var\/lib\/(?:apt|dpkg)|are you root\?|sudo: a (?:terminal|password) is required/.test(output)) {
    return (
      "[note] That needs root, and installing system packages is the user's decision. For a Python package, use " +
      `a virtual environment in the project: ${VENV}. For anything only the system can provide, tell the user ` +
      'what is missing and why.'
    );
  }
  return null;
}

/**
 * Runs a command in the workspace. This is the one tool that can do anything, which is why
 * Antimatter classifies it as "runs commands" and gates it behind an explicit approval.
 */
function execute(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, {
      cwd,
      shell: process.platform === 'win32' ? true : '/bin/bash',
      env: cleanChildEnv(),
      detached: grouped,
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', stop);
      resolve(result);
    };

    const stop = () => {
      truncated = true;
      try {
        if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const collect = (chunk: Buffer, into: 'out' | 'err') => {
      const text = chunk.toString('utf8');
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      if (into === 'out') stdout += text;
      else stderr += text;
    };

    child.stdout.on('data', (chunk) => collect(chunk, 'out'));
    child.stderr.on('data', (chunk) => collect(chunk, 'err'));

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, truncated, timedOut });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish({ code, signal, stdout, stderr, truncated, timedOut });
    });
  });
}

interface Launched {
  pid: number | undefined;
  /** Null while it is still running. */
  exit: { code: number | null; signal: string | null } | null;
  /** Set when the program could not be started at all. */
  error: string | null;
  elapsedMs: number;
  logPath: string;
}

/**
 * Starts a program that is meant to keep running, and watches it long enough to tell whether it
 * came up.
 *
 * run_command cannot do this. It waits for its pipes to close, and a program started with a
 * trailing `&` still holds them — so a GUI that starts correctly keeps the call open until the
 * timeout, which then kills it and reports a failure. Here the program gets its own session and
 * writes to a log file rather than to a pipe, so it outlives this call, the tool server and the
 * turn, and never stalls or dies on a pipe nobody is reading any more.
 */
async function launch(command: string, cwd: string, watchMs: number, signal?: AbortSignal): Promise<Launched> {
  const logPath = join(mkdtempSync(join(tmpdir(), 'antimatter-launch-')), 'output.log');
  const log = openSync(logPath, 'a');
  const started = Date.now();
  const grouped = process.platform !== 'win32';
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, {
      cwd,
      shell: process.platform === 'win32' ? true : '/bin/bash',
      env: cleanChildEnv(),
      detached: true,
      stdio: ['ignore', log, log],
    });
  } finally {
    // The child has its own copy of the descriptor by now.
    closeSync(log);
  }

  const settled = await new Promise<Pick<Launched, 'exit' | 'error'>>((resolve) => {
    const finish = (outcome: Pick<Launched, 'exit' | 'error'>) => {
      clearTimeout(timer);
      child.off('exit', exited);
      child.off('error', failed);
      signal?.removeEventListener('abort', cancelled);
      resolve(outcome);
    };
    const exited = (code: number | null, killedBy: NodeJS.Signals | null) =>
      finish({ exit: { code, signal: killedBy }, error: null });
    const failed = (error: Error) => finish({ exit: null, error: error.message });
    // A call that was cancelled leaves nothing behind, like run_command.
    const cancelled = () => {
      stopGroup(child.pid, grouped);
      finish({ exit: null, error: 'the call was cancelled, so the program was stopped' });
    };
    const timer = setTimeout(() => finish({ exit: null, error: null }), watchMs);
    child.once('exit', exited);
    child.once('error', failed);
    if (signal?.aborted) cancelled();
    else signal?.addEventListener('abort', cancelled, { once: true });
  });
  // Still running means it is the user's now; this process must not wait for it to end.
  child.unref();

  return { pid: child.pid, ...settled, elapsedMs: Date.now() - started, logPath };
}

function stopGroup(pid: number | undefined, grouped: boolean): void {
  if (!pid) return;
  try {
    if (grouped) process.kill(-pid, 'SIGTERM');
    else process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

/** The last part of a log, decoded as text. */
function tail(path: string, bytes: number): { text: string; size: number } {
  let size = 0;
  try {
    size = statSync(path).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString('utf8');
    return { text: length < size ? `… [${size - length} earlier bytes are in the log]\n${text}` : text, size };
  } catch {
    return { text: '', size };
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export const shellTools: ToolDef[] = [
  {
    name: 'run_command',
    description:
      'Run a Bash command inside the workspace, wait for it to finish, and return its exit code, stdout, and stderr. Use for builds, tests, scripts, inspection, and other non-interactive command-line work. A program that keeps running — a GUI application, a server — holds this call open until the timeout kills it, even when started with a trailing &, so start those with launch_program. Use open_path rather than a terminal editor to open a file.',
    inputSchema: {
      type: 'object',
      properties: {
        command: str('The command line to run, for example "npm test".'),
        cwd: str('Directory to run in, relative to the workspace root.'),
        timeout_ms: num('Kill the command after this many milliseconds. Default 60000.'),
      },
      required: ['command'],
    },
    async run(args, { workspace, signal }) {
      const command = String(args.command ?? '').trim();
      if (!command) throw new Error('No command was given.');

      const cwd = insideWorkspace(workspace, args.cwd ?? '.');
      const timeout = Math.min(Number(args.timeout_ms) || 60_000, 300_000);
      const result = await execute(command, cwd, timeout, signal);

      const report = [
        `$ ${command}`,
        `[cwd] ${cwd}`,
        `[exit] ${result.signal ? `killed by ${result.signal}` : result.code}`,
        `--- stdout (${result.stdout.length} bytes) ---`,
        result.stdout.trimEnd(),
        `--- stderr (${result.stderr.length} bytes) ---`,
        result.stderr.trimEnd(),
      ];
      if (result.timedOut) {
        // A validation script that opened a window sat here until it was killed, and the model
        // read "output truncated or command timed out" as a mystery rather than as its answer.
        report.push(
          `[timeout] It was still running after ${seconds(timeout)}, so it was killed. A program that keeps ` +
            'running — a desktop application, a server, a script that opens a window — belongs in launch_program. ' +
            'A command that is only slow can be given more time with timeout_ms, up to 300000.'
        );
      } else if (result.truncated) {
        report.push('--- output truncated, or the command was stopped ---');
      }
      const hint = installHint(`${result.stdout}\n${result.stderr}`);
      if (hint) report.push(hint);
      return clip(report.join('\n'));
    },
  },
  {
    name: 'launch_program',
    description:
      'Start a program that is meant to keep running — a GUI application, a game, a server — and report whether it is still running after a few seconds, with everything it printed so far. It keeps running after this call returns; the result says how to stop it. This is how to check that a desktop application you built actually starts. Use run_command for commands that finish on their own.',
    inputSchema: {
      type: 'object',
      properties: {
        command: str('The command line that starts the program, for example "./build/editor" or ".venv/bin/python app.py".'),
        cwd: str('Directory to run in, relative to the workspace root.'),
        watch_ms: num(`How long to watch it before reporting, in milliseconds. Default ${LAUNCH_WATCH_MS}, at most ${LAUNCH_WATCH_MAX_MS}.`),
      },
      required: ['command'],
    },
    async run(args, { workspace, signal }) {
      const command = String(args.command ?? '').trim();
      if (!command) throw new Error('No command was given.');

      const cwd = insideWorkspace(workspace, args.cwd ?? '.');
      const watch = Math.min(Math.max(Number(args.watch_ms) || LAUNCH_WATCH_MS, 250), LAUNCH_WATCH_MAX_MS);
      const launched = await launch(command, cwd, watch, signal);
      const output = tail(launched.logPath, LAUNCH_LOG_TAIL_BYTES);

      const report = [`$ ${command}`, `[cwd] ${cwd}`];
      if (launched.error) {
        report.push(`[not running] ${launched.error}`);
      } else if (launched.exit) {
        const how = launched.exit.signal ? `was killed by ${launched.exit.signal}` : `exited with code ${launched.exit.code}`;
        report.push(`[exited] it ${how} after ${seconds(launched.elapsedMs)}, so it is not running.`);
      } else {
        report.push(
          `[running] pid ${launched.pid}, still running after ${seconds(launched.elapsedMs)}. It stays running after this call.`,
          `[stop] ${process.platform === 'win32' ? `taskkill /PID ${launched.pid} /T /F` : `kill -- -${launched.pid}`}`
        );
      }
      report.push(`[log] ${launched.logPath}`, `--- output (${output.size} bytes) ---`, output.text.trimEnd());
      const hint = launched.exit || launched.error ? installHint(output.text) : null;
      if (hint) report.push(hint);
      return clip(report.join('\n'));
    },
  },
];
