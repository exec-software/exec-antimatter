/**
 * A ring of the main process's own log lines, for the recovery shell's /logs.
 *
 * The app writes to console and nobody reads it back out afterwards — a recovery shell that can
 * say "here are the last forty lines" is much more useful than one that asks the person to open
 * a terminal and hope the output is still there. Capture is optional and idempotent: tests do not
 * want a global console installed under them, and install() only replaces the methods when the
 * ring is not already wired.
 */

export interface LogLine {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  text: string;
}

const RING_MAX = 400;

const textOf = (args: unknown[]): string =>
  args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');

/** Bulk of a console line, split at awkward but honest boundaries: ~two screen widths each. */
const folded = (line: LogLine): LogLine[] => {
  const width = 160;
  const pieces: LogLine[] = [];
  let rest = line.text;
  while (rest.length > width) {
    breakPoint: {
      const breakAt = rest.lastIndexOf('\n', width);
      const spaceAt = rest.lastIndexOf(' ', width);
      const at = breakAt > 60 ? breakAt : spaceAt > 60 ? spaceAt : -1;
      if (at < 0) break breakPoint;
      pieces.push({ ...line, text: rest.slice(0, at + 1).replace(/\n$/, '') });
      rest = rest.slice(at + 1);
      continue;
    }
    pieces.push({ ...line, text: rest.slice(0, width) });
    rest = rest.slice(width);
  }
  pieces.push({ ...line, text: rest });
  return pieces;
};

export function read(count = 40, level: LogLine['level'] | 'all' = 'all'): LogLine[] {
  const take = Math.max(1, Math.min(count, RING_MAX));
  const latest = ring.slice(-take);
  const want = (line: LogLine) => level === 'all' || line.level === level;
  return latest.filter(want).flatMap(folded);
}

let installed = false;
const ring: LogLine[] = [];
const originals = new Map<string, unknown>();
let length = 0;

export function install(consoleImpl: typeof console = console): typeof console {
  if (installed) return consoleImpl;
  installed = true;
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    originals.set(level, consoleImpl[level]);
    consoleImpl[level] = (...args: unknown[]) => {
      const text = textOf(args);
      if (text) {
        ring.push({ at: Date.now(), level, text });
        if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
      }
      length = ring.length;
      (originals.get(level) as (...args: unknown[]) => void).apply(consoleImpl, args);
    };
  }
  return consoleImpl;
}

/** Restores the original methods, dropping whatever was captured. Tests only. */
export function uninstall(): void {
  if (!installed) return;
  installed = false;
  for (const [level, original] of originals) {
    (console as unknown as Record<string, unknown>)[level] = original;
  }
  originals.clear();
  ring.length = 0;
}