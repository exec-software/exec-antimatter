/**
 * Ends a development Electron when the Vite process that launched it goes away.
 *
 * `DevElectronProcess` stops the child it spawned, and since the signal fix it does so on Ctrl-C
 * too. Neither helps across process boundaries: a Vite that was SIGKILLed, crashed, or belonged to
 * a session that ended leaves an Electron with no owner, and a *new* `npm run dev` cannot adopt or
 * kill a child it never spawned. What it can do is take the single-instance lock — which the
 * survivor already holds. So the new Electron quits with code 0, the survivor keeps serving, and
 * Vite happily rebuilds a renderer that now talks to a main process from before the rebuild. The
 * symptom is a handler that plainly exists in the source and is "not registered" at runtime.
 *
 * So the child watches for its owner instead of relying on the owner to clean up.
 *
 * Polling rather than a signal: `PR_SET_PDEATHSIG` is Linux-only, is not reachable from Node, and
 * would not survive Electron's own re-exec anyway. A poll costs one `kill(pid, 0)` every few
 * seconds and works the same on every platform.
 */

/** The variable `DevElectronProcess` sets. Absent in a packaged app, where none of this applies. */
export const DEV_PARENT_PID_ENV = 'ANTIMATTER_DEV_PARENT_PID';

/** Long enough to cost nothing, short enough that a stale window cannot mislead for long. */
const DEFAULT_INTERVAL_MS = 3_000;

const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else, which is still alive. Only ESRCH is
    // evidence of death, and treating anything else as death would close a working window.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

export interface DevParentWatchOptions {
  parentPid: number;
  /** Called once, when the parent is first observed to be gone. */
  onParentGone: () => void;
  intervalMs?: number;
  /** Injectable for tests; defaults to a `kill(pid, 0)` probe. */
  alive?: (pid: number) => boolean;
}

/**
 * Starts watching, and returns a function that stops it.
 *
 * A parent that is already gone fires on the first tick rather than immediately, so a caller
 * wiring this up during startup is never re-entered before it has finished.
 */
export function watchDevParent(options: DevParentWatchOptions): () => void {
  const { parentPid, onParentGone, intervalMs = DEFAULT_INTERVAL_MS, alive = defaultAlive } = options;

  // A nonsense pid would make every tick report death and close the window on launch.
  if (!Number.isInteger(parentPid) || parentPid <= 1) return () => undefined;

  let fired = false;
  const timer = setInterval(() => {
    if (fired || alive(parentPid)) return;
    fired = true;
    clearInterval(timer);
    onParentGone();
  }, intervalMs);
  // Never hold the process open on this alone: a watch is not work worth staying alive for.
  timer.unref?.();

  return () => clearInterval(timer);
}

/**
 * Reads the owner's pid out of the environment, or null when this is not a development child.
 *
 * Exported so the wiring in `index.ts` stays a single `if`, and so the parsing has a test of its
 * own — an env var that is present but junk must read as "not a dev child", not as pid 0.
 */
export function devParentPid(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[DEV_PARENT_PID_ENV];
  if (!raw) return null;
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}
