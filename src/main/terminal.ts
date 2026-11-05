import { randomUUID } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import type { IPty } from 'node-pty';
import type { ToolCallResult } from './mcp';

/** User shells and approved agent commands share a surface, never a shell process. */
export interface SessionInfo {
  id: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: number;
  exit: { code: number; signal?: number } | null;
  kind?: 'shell' | 'command';
  command?: string;
  /** Set on the command event when the command will prompt locally (sudo) and so must be shown. */
  needsInput?: boolean;
  runId?: string;
  threadId?: string;
  activityId?: string;
  /** Any user input makes all command output private to the terminal. */
  privateInput?: boolean;
}

interface Session extends SessionInfo {
  pty: IPty;
  scrollback: string;
  offset: number;
  removeOnExit?: boolean;
  stopCommand?(reason: 'cancelled' | 'closed'): void;
  makePrivate?(): void;
}

export interface TerminalEvents {
  /** offset is the absolute end offset in UTF-16 characters, including trimmed history. */
  onData(id: string, data: string, offset?: number): void;
  onExit(id: string, exit: { code: number; signal?: number }): void;
  onCommand?(info: SessionInfo): void;
}

export interface RunCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  runId?: string;
  threadId?: string;
  activityId?: string;
  /**
   * Extra environment for this one command, merged over the inherited shell environment.
   *
   * This is how a Vault credential reaches a command the model wrote without the model ever
   * holding it (src/main/vault/grants.ts). It is deliberately the environment and not the command
   * line: on Linux `/proc/<pid>/cmdline` is world readable, while `/proc/<pid>/environ` is not.
   */
  env?: Record<string, string>;
}

type PtyModule = Pick<typeof import('node-pty'), 'spawn'>;
/** Injectable native boundary: tests never open a terminal or ask for real credentials. */
export interface TerminalDependencies {
  loadPty?(): Promise<PtyModule>;
  killProcessGroup?(pid: number, signal: NodeJS.Signals): void;
}

const SCROLLBACK_CHARS = 200_000;
const MAX_SESSIONS = 8;
const MAX_RESULT_CHARS = 24_000;
const STOP_GRACE_MS = 200;

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('ELECTRON_OVERRIDE') || key.startsWith('CODEX_')) continue;
    env[key] = value;
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

const dimension = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) ? Math.min(1000, Math.max(2, Math.round(value!))) : fallback;

export function createTerminalManager(dependencies: TerminalDependencies = {}) {
  const sessions = new Map<string, Session>();
  let events: TerminalEvents | null = null;
  let module: PtyModule | null = null;

  // A closed/reloading renderer may reject delivery. UI events must never strand a native
  // process or reject its execution promise; the panel can recover through list/snapshot.
  const notify = (deliver: () => void): void => { try { deliver(); } catch { /* UI detached. */ } };

  async function ptyModule(): Promise<PtyModule> {
    if (module) return module;
    try {
      return module = await (dependencies.loadPty?.() ?? import('node-pty'));
    } catch (error) {
      throw new Error(`The terminal needs node-pty, which did not load: ${(error as Error).message}. ` +
        'It is compiled against Electron\'s ABI — run "npm run rebuild:native" to rebuild it.');
    }
  }

  function publicInfo(session: Session): SessionInfo {
    let cwd = session.cwd;
    if (process.platform === 'linux' && session.kind !== 'command' && !session.exit) {
      try { cwd = readlinkSync(`/proc/${session.pty.pid}/cwd`); } catch { /* Shell may have exited. */ }
    }
    const { id, shell, cols, rows, startedAt, exit, kind, command, runId, threadId, activityId, privateInput } = session;
    return { id, shell, cwd, cols, rows, startedAt, exit, kind, command, runId, threadId, activityId, privateInput };
  }

  function capacity(): void {
    if (sessions.size < MAX_SESSIONS) return;
    // Keep results for reopening until space is needed. Never remove a user shell or live run.
    for (const session of sessions.values()) {
      if (session.kind === 'command' && session.exit) sessions.delete(session.id);
      if (sessions.size < MAX_SESSIONS) return;
    }
    throw new Error(`Antimatter already has ${MAX_SESSIONS} terminals open. Close an unused terminal before retrying.`);
  }

  function output(session: Session, data: string): void {
    session.offset += data.length;
    session.scrollback = (session.scrollback + data).slice(-SCROLLBACK_CHARS);
    notify(() => events?.onData(session.id, data, session.offset));
  }

  function exited(session: Session, exit: { code: number; signal?: number }): void {
    if (session.exit) return;
    session.exit = exit;
    notify(() => events?.onExit(session.id, exit));
    if (session.removeOnExit) sessions.delete(session.id);
  }

  function killProcess(session: Session): void {
    if (session.exit) return;
    if (process.platform !== 'win32') {
      try {
        // forkpty creates its own session/process group. Stop children as well as Bash.
        (dependencies.killProcessGroup ?? ((pid, signal) => process.kill(-pid, signal)))(session.pty.pid, 'SIGKILL');
        return;
      } catch { /* Fall back if the process group has already gone. */ }
    }
    try { session.pty.kill('SIGKILL'); } catch { /* Already exited. */ }
  }

  async function create(options: { cwd?: string | null; cols?: number; rows?: number }): Promise<SessionInfo> {
    const native = await ptyModule();
    capacity();
    const shell = process.platform === 'win32' ? process.env.COMSPEC || 'powershell.exe' : process.env.SHELL || '/bin/bash';
    const cwd = options.cwd || homedir();
    const cols = dimension(options.cols, 80);
    const rows = dimension(options.rows, 24);
    const child = native.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd, env: shellEnv() });
    const session: Session = {
      id: `term-${randomUUID()}`, shell, cwd, cols, rows, startedAt: Date.now(), exit: null,
      kind: 'shell', privateInput: false, pty: child, scrollback: '', offset: 0,
    };
    sessions.set(session.id, session);
    child.onData((data) => output(session, data));
    child.onExit(({ exitCode, signal }) => exited(session, { code: exitCode, signal }));
    return publicInfo(session);
  }

  async function runCommand(options: RunCommandOptions): Promise<ToolCallResult> {
    const command = options.command.trim();
    if (!command || command.includes('\0')) return { ok: false, text: 'A nonempty command without NUL characters is required; nothing ran.', attempted: false };
    if (options.signal?.aborted) return { ok: false, text: 'The command was cancelled before it started; nothing ran.', attempted: false };
    let native: PtyModule;
    try {
      native = await ptyModule();
      // Loading yields; a cancellation during that wait must not start Bash.
      if (options.signal?.aborted) return { ok: false, text: 'The command was cancelled before it started; nothing ran.', attempted: false };
      capacity();
    } catch (error) {
      return { ok: false, text: `${(error as Error).message} Nothing ran.`, attempted: false };
    }

    const shell = process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/bash';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    let child: IPty;
    try {
      child = native.spawn(shell, args, {
        name: 'xterm-256color', cols: 120, rows: 30, cwd: options.cwd,
        env: options.env ? { ...shellEnv(), ...options.env } : shellEnv(),
      });
    } catch (error) {
      return { ok: false, text: `Could not start the command: ${(error as Error).message}. Nothing ran.`, attempted: false };
    }
    const session: Session = {
      id: `command-${randomUUID()}`, shell, cwd: options.cwd, cols: 120, rows: 30, startedAt: Date.now(), exit: null,
      kind: 'command', command, runId: options.runId, threadId: options.threadId, activityId: options.activityId,
      privateInput: false, pty: child, scrollback: '', offset: 0,
    };
    sessions.set(session.id, session);
    const timeout = Number.isFinite(options.timeoutMs) ? Math.min(300_000, Math.max(1, options.timeoutMs)) : 60_000;

    return new Promise<ToolCallResult>((resolve) => {
      let captured = '';
      let truncated = false;
      let settled = false;
      let stopped: 'timeout' | 'cancelled' | 'closed' | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (exit: { code: number; signal?: number }, confirmed = true) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(stopTimer);
        options.signal?.removeEventListener('abort', cancel);
        if (confirmed) exited(session, exit);
        const report = [`$ ${command}`, `[cwd] ${options.cwd}`, `[exit] ${!confirmed ? 'unknown — the terminal did not confirm process exit' : exit.signal ? `killed by signal ${exit.signal}` : exit.code}`];
        if (session.privateInput) {
          // Withhold even earlier text: a process may echo input late or mix it into other output.
          report.push('[private interaction] The user entered input directly in the terminal. All command output is withheld from the model and conversation transcript. Use the exit status above; ask the user for a non-secret summary if needed. Never ask for a password in chat.');
        } else {
          report.push('--- terminal output ---', stripVTControlCharacters(captured).replace(/\r\n/g, '\n').trimEnd());
          if (truncated) report.push('--- output truncated ---');
        }
        const termination = confirmed ? 'The command was stopped.' : 'Termination was requested, but process exit was not confirmed. Check the terminal before retrying.';
        if (stopped === 'timeout') report.push(`[timeout] The command exceeded ${(timeout / 1000).toFixed(1)} s. ${termination} Use launch_program for servers and programs meant to keep running.`);
        if (stopped === 'cancelled') report.push(`[cancelled] ${termination} It may have made changes before cancellation; inspect before retrying.`);
        if (stopped === 'closed') report.push(`[closed] ${termination} It may have made changes before it stopped; inspect before retrying.`);
        captured = '';
        resolve({ ok: !stopped && exit.code === 0 && !exit.signal, text: report.join('\n'), attempted: true });
      };
      const stop = (reason: NonNullable<typeof stopped>) => {
        if (settled) { if (!session.exit) killProcess(session); return; }
        if (stopped) return;
        stopped = reason;
        // Install the fallback before killing: an adapter may deliver exit synchronously.
        // A missing exit event is not a successful kill. Keep this session live/non-prunable
        // until a real exit arrives, while allowing the tool call itself to return on time.
        stopTimer = setTimeout(() => finish({ code: -1 }, false), STOP_GRACE_MS);
        killProcess(session);
      };
      const cancel = () => stop('cancelled');
      session.stopCommand = stop;
      session.makePrivate = () => { session.privateInput = true; captured = ''; };
      child.onData((data) => {
        output(session, data);
        if (settled || session.privateInput) return;
        const available = Math.max(0, MAX_RESULT_CHARS - captured.length);
        captured += data.slice(0, available);
        if (data.length > available) truncated = true;
      });
      child.onExit(({ exitCode, signal }) => {
        const exit = { code: exitCode, signal };
        exited(session, exit);
        finish(exit);
      });
      timeoutTimer = setTimeout(() => stop('timeout'), timeout);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      // Attach all listeners before the UI may send input or attach to this session.
      notify(() => events?.onCommand?.(publicInfo(session)));
    });
  }

  function write(id: string, data: string): void {
    const session = sessions.get(id);
    if (!session || session.exit || !data) return;
    // Mark private BEFORE forwarding; programs can echo immediately. Input is never logged.
    if (session.kind === 'command') session.makePrivate?.();
    session.pty.write(data);
  }

  function resize(id: string, cols: number, rows: number): void {
    const session = sessions.get(id);
    if (!session || session.exit) return;
    const nextCols = dimension(cols, session.cols);
    const nextRows = dimension(rows, session.rows);
    if (nextCols === session.cols && nextRows === session.rows) return;
    session.cols = nextCols;
    session.rows = nextRows;
    try { session.pty.resize(nextCols, nextRows); } catch { /* Process may have just exited. */ }
  }

  function kill(id: string): void {
    const session = sessions.get(id);
    if (!session) return;
    if (session.kind === 'command' && !session.exit) {
      // Closing is a termination request, not proof the process died. Retain the private input
      // route and capacity reservation until the native exit event actually confirms it.
      session.removeOnExit = true;
      session.stopCommand?.('closed');
    } else {
      killProcess(session);
      sessions.delete(id);
    }
  }

  return {
    connect: (handlers: TerminalEvents): void => { events = handlers; },
    create,
    runCommand,
    list: (): SessionInfo[] => [...sessions.values()].map(publicInfo),
    history: (id: string): string => sessions.get(id)?.scrollback ?? '',
    snapshot: (id: string): { data: string; offset: number } => {
      const session = sessions.get(id);
      return { data: session?.scrollback ?? '', offset: session?.offset ?? 0 };
    },
    write,
    resize,
    kill,
    shutdown: (): void => { for (const id of [...sessions.keys()]) kill(id); },
  };
}

const terminal = createTerminalManager();
export const { connect, create, runCommand, list, history, snapshot, write, resize, kill, shutdown } = terminal;
