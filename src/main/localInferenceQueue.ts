/** Cancel queued work promptly, but keep a running transition serialized through its cleanup. */
export class LocalInferenceQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let started = false;
    const execution = this.tail.then(() => {
      signal?.throwIfAborted();
      started = true;
      return operation();
    });
    this.tail = execution.catch(() => undefined);
    if (!signal) return execution;
    return new Promise<T>((resolve, reject) => {
      const abort = () => { if (!started) reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      execution.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
}

/** Only race read-only work; lifecycle mutations must finish before the queue is released. */
export function abortableRead<T>(read: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    read.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
