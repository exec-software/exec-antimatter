import * as mcp from './mcp';

/**
 * The settings UI and manual MCP console share one long-lived status runtime. Serialize control
 * operations on that runtime so a refresh/call cannot overlap a reconnect. Actual chat and
 * orchestrator turns use isolated per-workspace runtimes and do not queue here.
 */
let tail: Promise<void> = Promise.resolve();

export async function withMcpControl<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = tail;
  tail = previous.then(() => mine);

  let removeAbort: () => void = () => {};
  try {
    if (signal?.aborted) throw new Error('the run was cancelled while waiting for tool access');
    if (signal) {
      await Promise.race([
        previous,
        new Promise<never>((_resolve, reject) => {
          const cancelled = () => reject(new Error('the run was cancelled while waiting for tool access'));
          signal.addEventListener('abort', cancelled, { once: true });
          removeAbort = () => signal.removeEventListener('abort', cancelled);
        }),
      ]);
      if (signal.aborted) throw new Error('the run was cancelled while waiting for tool access');
    } else {
      await previous;
    }
  } catch (error) {
    // This waiter remains in the promise chain, so resolve its link. Later callers still wait
    // for the current owner (`previous`) but will pass straight over this cancelled entry.
    release();
    throw error;
  } finally {
    removeAbort();
  }

  try {
    return await run();
  } finally {
    release();
  }
}

export function withMcpWorkspace<T>(workspace: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withMcpControl(async () => {
    await mcp.connectEnabled(workspace);
    return run();
  }, signal);
}
