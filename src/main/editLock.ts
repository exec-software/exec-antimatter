/**
 * The edit lock: an in-process lease the main process takes while a file-writing tool call is
 * in flight, so a shutdown that lands mid-edit — a dev reload that the edit itself triggered is
 * the ordinary case when Antimatter is developing Antimatter — waits for the write to complete
 * and its result to be delivered before the process goes away.
 *
 * The lease covers the whole round trip (request sent, result received) rather than the moment
 * on disk, because a write that finished on disk but never answered the model is exactly as lost
 * as one that never started: told the tool failed, the model retries into the same restart. The
 * MCP server holds its own exit on the same flights (see mcp/server.ts), and this lock is why
 * the app itself does not tear the stdio transport down underneath it.
 */

export interface EditLease {
  release(): void;
}

const active = new Set<symbol>();

/** Holds the edit lock until `release()` is called. Safe to call any number of times. */
export function acquire(): EditLease {
  const token = Symbol('edit');
  active.add(token);
  return {
    release: (): void => {
      active.delete(token);
    },
  };
}

/** True while any edit is mid-call. A shutdown should wait for it before proceeding. */
export const busy = (): boolean => active.size > 0;

/** Number of edits in flight; the renderer and tests can show it without exposing the lease set. */
export const inFlight = (): number => active.size;

/**
 * Resolves `true` once every in-flight edit has finished, or `false` when `timeoutMs` runs out
 * first. Bounded on purpose: a shutdown must never hang on a write that never resolves, and the
 * durable write leaves the file whole either way.
 */
export function waitIdle(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!busy()) {
      resolve(true);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (!busy()) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}