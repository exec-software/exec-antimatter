import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { DEV_PARENT_PID_ENV } from './devParentWatch';

type ElectronProcessSlot = {
  electronApp?: ChildProcess;
};

export type DevElectronProcessOptions = {
  executable: string;
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  shutdownTimeoutMs?: number;
  spawnOptions?: Omit<SpawnOptions, 'cwd' | 'env' | 'stdio' | 'detached'>;
  log?: Pick<Console, 'info' | 'warn'>;
};

/** Signals that end the Vite owner without running its `exit` handlers. */
const TERMINATING_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Relaunch Electron at most this many times after consecutive unexpected exits.
 * Chromium can die at startup with a "GPU process isn't usable" fatal that is
 * independent of the code running in it; one immediate retry clears it. Cap the
 * restarts so a build that fails on arrival cannot loop forever.
 */
const MAX_UNEXPECTED_RESTARTS = 3;

/**
 * Owns the Electron child used by Vite development mode.
 *
 * vite-plugin-electron's default restart helper discovers descendants from the
 * Vite process rather than from Electron. That can make an Electron rebuild kill
 * sibling Vite/esbuild processes. This manager puts Electron in its own process
 * group on POSIX and only ever signals that group (or its exact task tree on
 * Windows).
 */
export class DevElectronProcess {
  private readonly executable: string;
  private readonly argv: string[];
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly shutdownTimeoutMs: number;
  private readonly spawnOptions: Omit<SpawnOptions, 'cwd' | 'env' | 'stdio' | 'detached'>;
  private readonly log: Pick<Console, 'info' | 'warn'>;

  private child: ChildProcess | undefined;
  private operation = Promise.resolve();
  private requestedRevision = 0;
  private stoppingPid: number | undefined;
  private isolatedGroupPid: number | undefined;
  private consecutiveUnexpectedExits = 0;

  constructor(options: DevElectronProcessOptions) {
    this.executable = options.executable;
    this.argv = options.argv ?? ['.', '--no-sandbox'];
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_500;
    this.spawnOptions = options.spawnOptions ?? {};
    this.log = options.log ?? console;

    // Vite can reload its config inside the same Node process. Adopt an Electron
    // child created by the old config so the first safe restart replaces it
    // instead of opening a duplicate window. The plugin wires that child's exit
    // directly to process.exit; remove only that exact listener so Vite survives.
    const inherited = (process as unknown as ElectronProcessSlot).electronApp;
    if (inherited?.pid && inherited.exitCode === null && inherited.signalCode === null) {
      inherited.removeListener('exit', process.exit);
      this.trackChild(inherited, false);
    }

    // The exit event cannot wait for graceful shutdown or a timeout, so
    // synchronously force-stop only the process group we created. This prevents
    // a signal-ignoring Electron descendant from surviving Vite.
    process.once('exit', () => this.stopImmediately());

    // `exit` does not run when Node is terminated by a signal, and Ctrl-C in the
    // terminal running Vite sends exactly that. Electron is deliberately in its own
    // process group so a rebuild cannot kill Vite's esbuild siblings; the same
    // isolation means the terminal's SIGINT never reaches Electron either. A
    // survivor is not merely untidy — it keeps Electron's single-instance lock, so
    // the next `npm run dev` starts, finds the lock held, quits, and focuses the
    // stale window. The symptom is an app that ignores every config change made
    // since it launched.
    for (const signal of TERMINATING_SIGNALS) {
      const onSignal = () => {
        this.stopImmediately();
        // Re-raise with our own handler removed so the owner still dies the way the
        // signal intended and its exit status reflects the signal, rather than a
        // synthetic code that would misreport a Ctrl-C as a clean exit.
        process.removeListener(signal, onSignal);
        try {
          process.kill(process.pid, signal);
        } catch {
          // Windows does not deliver every POSIX signal to its own process.
          process.exit(1);
        }
      };
      process.on(signal, onSignal);
    }
  }

  get pid(): number | undefined {
    return this.isRunning() ? this.child?.pid : undefined;
  }

  isRunning(): boolean {
    return Boolean(
      this.child &&
        this.child.pid &&
        this.child.exitCode === null &&
        this.child.signalCode === null &&
        this.stoppingPid !== this.child.pid
    );
  }

  /** Coalesces queued rebuilds and never overlaps stop/start operations. */
  restart(reason = 'main process rebuilt'): Promise<void> {
    const revision = ++this.requestedRevision;
    // A rebuild means new code and a fresh chance: clear the crash streak so a
    // healthy build gets its full allowance of unexpected-exit relaunches.
    this.consecutiveUnexpectedExits = 0;
    return this.enqueue(async () => {
      if (revision !== this.requestedRevision) return;

      await this.stopCurrent();
      // A newer rebuild may have arrived while Electron was shutting down. Let
      // that queued operation start the newest output instead of an older one.
      if (revision !== this.requestedRevision) return;

      await this.startCurrent(reason);
    });
  }

  stop(): Promise<void> {
    const revision = ++this.requestedRevision;
    return this.enqueue(async () => {
      if (revision !== this.requestedRevision) return;
      await this.stopCurrent();
    });
  }

  stopImmediately(): void {
    const child = this.child;
    if (!child?.pid) return;

    const ownsLiveProcessGroup =
      this.platform !== 'win32' &&
      this.isolatedGroupPid === child.pid &&
      processGroupIsAlive(child.pid);
    if (!ownsLiveProcessGroup && (child.exitCode !== null || child.signalCode !== null)) return;

    this.stoppingPid = child.pid;
    this.clearElectronSlot(child);
    this.signalTree(child, 'SIGKILL', true);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const pending = this.operation.then(task, task);
    // Keep later rebuilds usable after one failed spawn, while still returning
    // the original rejection to the caller for logging.
    this.operation = pending.catch(() => undefined);
    return pending;
  }

  private async startCurrent(reason: string): Promise<void> {
    const child = spawn(this.executable, this.argv, {
      ...this.spawnOptions,
      cwd: this.cwd,
      env: {
        ...this.env,
        // Tell the child who owns it. Everything this class does to clean up dies with this
        // process; a Vite that is SIGKILLed or crashes cleans up nothing, and the next
        // `npm run dev` cannot adopt a child it never spawned — it only loses the
        // single-instance lock to it. So the child watches back.
        [DEV_PARENT_PID_ENV]: String(process.pid),
      },
      stdio: 'inherit',
      // A separate POSIX process group lets us terminate Electron and its
      // renderer/utility children without discovering siblings by parent PID.
      detached: this.platform !== 'win32',
    });

    this.trackChild(child, true);

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) => {
        if (this.child === child) this.child = undefined;
        this.clearElectronSlot(child);
        reject(error);
      });
    });

    this.log.info(`[electron-dev] Electron pid ${child.pid ?? 'unknown'} started (${reason}).`);
  }

  private async stopCurrent(): Promise<void> {
    const child = this.child;
    if (!child?.pid) {
      if (child) this.clearElectronSlot(child);
      if (this.child === child) this.child = undefined;
      return;
    }

    const pid = child.pid;
    const ownsProcessGroup = this.platform !== 'win32' && this.isolatedGroupPid === pid;
    const treeIsAlive = () =>
      ownsProcessGroup
        ? processGroupIsAlive(pid)
        : child.exitCode === null && child.signalCode === null;

    if (treeIsAlive()) {
      this.stoppingPid = pid;
      this.signalTree(child, 'SIGTERM', false);
    }

    const stoppedGracefully = await waitUntil(treeIsAlive, false, this.shutdownTimeoutMs);
    if (!stoppedGracefully && treeIsAlive()) {
      this.signalTree(child, 'SIGKILL', false);
      await waitUntil(treeIsAlive, false, 500);
    }

    if (this.stoppingPid === pid) this.stoppingPid = undefined;
    if (this.isolatedGroupPid === pid) this.isolatedGroupPid = undefined;
    if (this.child === child) this.child = undefined;
    this.clearElectronSlot(child);
  }

  private signalTree(child: ChildProcess, signal: NodeJS.Signals, synchronous: boolean): void {
    if (!child.pid) return;

    if (this.platform === 'win32') {
      const argv = ['/pid', String(child.pid), '/T', '/F'];
      if (synchronous) {
        spawnSync('taskkill', argv, { stdio: 'ignore', windowsHide: true });
      } else {
        const killer = spawn('taskkill', argv, { stdio: 'ignore', windowsHide: true });
        killer.once('error', () => child.kill());
        killer.once('exit', (code) => {
          if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill();
        });
      }
      return;
    }

    if (this.isolatedGroupPid !== child.pid) {
      try {
        child.kill(signal);
      } catch {
        // It has already exited.
      }
      return;
    }

    try {
      // The child was spawned detached, so -pid identifies Electron's process
      // group and cannot include the Vite process or its esbuild siblings.
      process.kill(-child.pid, signal);
    } catch {
      // If the group disappeared between the liveness check and signal, a direct
      // child signal is the narrowest safe fallback.
      try {
        child.kill(signal);
      } catch {
        // It has already exited.
      }
    }
  }

  private clearElectronSlot(child: ChildProcess): void {
    const slot = process as unknown as ElectronProcessSlot;
    if (slot.electronApp === child) delete slot.electronApp;
  }

  private trackChild(child: ChildProcess, isolatedProcessGroup: boolean): void {
    this.child = child;
    if (isolatedProcessGroup) this.isolatedGroupPid = child.pid;
    (process as unknown as ElectronProcessSlot).electronApp = child;

    child.once('exit', (code, signal) => {
      const expected = this.stoppingPid === child.pid;
      if (expected) this.stoppingPid = undefined;
      const ownsProcessGroup = this.isolatedGroupPid === child.pid;
      // Keep an isolated child record until stopCurrent confirms that every
      // process in its group is gone. The main PID can exit before a descendant.
      if (!ownsProcessGroup && this.child === child) this.child = undefined;
      this.clearElectronSlot(child);

      if (!expected) {
        const outcome = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
        this.log.warn(`[electron-dev] Electron exited (${outcome}); Vite is still running.`);

        // Only a crash — like Chromium's "GPU process isn't usable" fatal — earns a relaunch. A
        // clean self-requested exit (for example the tray's Quit) stays down, both so the user's
        // intent is honored and so an exited-nowhere child cannot keep cycling.
        const abnormal = signal !== null || code !== 0;
        if (abnormal) {
          this.consecutiveUnexpectedExits += 1;
          if (this.consecutiveUnexpectedExits > MAX_UNEXPECTED_RESTARTS) {
            this.log.warn(
              '[electron-dev] Electron exited unexpectedly too many times in a row; not relaunching ' +
                'automatically. Restart Vite to try again.'
            );
          }
        }

        if (ownsProcessGroup) {
          // A crash (for example Chromium's "GPU process isn't usable" fatal) otherwise leaves the
          // window dead until the next rebuild — and the next `npm run dev` cannot take over while
          // this one still holds Electron's single-instance lock. Relaunch once the old process
          // group is gone, but not if a newer request (a rebuild) is queued behind this cleanup and
          // owns the next start, and not while a newer child is already in place.
          const revisionAtExit = this.requestedRevision;
          const attempt = this.consecutiveUnexpectedExits;
          void this.enqueue(async () => {
            if (this.child !== child) return;
            this.stoppingPid = child.pid;
            await this.stopCurrent().catch(() => undefined);
            if (this.child !== undefined || this.requestedRevision !== revisionAtExit) return;
            if (abnormal && this.consecutiveUnexpectedExits <= MAX_UNEXPECTED_RESTARTS) {
              await this.startCurrent(
                `unexpected exit (${outcome}), relaunching${attempt > 1 ? ` (attempt ${attempt})` : ''}`
              );
            }
          }).catch((error: unknown) => {
            this.log.warn(`[electron-dev] Could not relaunch Electron after an unexpected exit: ${String(error)}`);
          });
        }
      }
    });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntil(
  readCurrent: () => boolean,
  expected: boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (readCurrent() !== expected) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(25, remaining));
  }
  return true;
}
