/**
 * Process-local events emitted by the application core.
 *
 * Electron's renderer is one consumer, not the owner of these events. Keeping the fan-out in the
 * main process lets a paired remote client observe the same turn while the desktop window is
 * hidden, and prevents transport code from pretending Electron IPC is a public protocol.
 */
export interface AppEvent<T = unknown> {
  channel: string;
  payload: T;
}

export type AppEventListener = (event: AppEvent) => void;

export class AppEventBus {
  private readonly listeners = new Set<AppEventListener>();

  publish(channel: string, payload: unknown): void {
    const event: AppEvent = { channel, payload };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        // One presentation/transport adapter must never break inference or starve the others.
        console.error(`[events] listener failed for ${channel}:`, error);
      }
    }
  }

  subscribe(listener: AppEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
