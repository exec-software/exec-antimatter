import { LocalInferenceQueue } from './localInferenceQueue';

/** Serializes first-request and manual engine transitions. Status/selection never enter this queue. */
export type LocalInferenceTarget =
  | { kind: 'native' }
  | { kind: 'router'; sourceId: string | null }
  | { kind: 'direct'; sourceId: string; endpoint?: string }
  | { kind: 'preview' };

type Status = { running: boolean; ownership: 'app' | 'external' | null };
export interface LocalInferenceCoordinatorDeps {
  nativeSourceId: string;
  previewSourceId: string;
  busy(sourceId: string): boolean;
  native: { inspect(): Promise<Status>; stop(): Promise<Status> };
  router: { status(): Status; sourceId(): string | null; stop(): Promise<Status> };
  direct: { states(): Array<Status & { sourceId: string; endpoint?: string }>;
    inspect?(): Promise<Array<Status & { sourceId: string; endpoint?: string }>>; stop(sourceId: string): Promise<void> };
  preview: { enabled(): boolean; stop(): Promise<unknown> };
}

export class LocalInferenceCoordinator {
  private readonly queue = new LocalInferenceQueue();
  constructor(private readonly deps: LocalInferenceCoordinatorDeps) {}

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.queue.run(operation, signal);
  }

  /** Must be called inside run(); inspect every sibling before stopping any of them. */
  async retireFor(target: LocalInferenceTarget, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const d = this.deps;
    const native = target.kind !== 'native' ? await d.native.inspect() : null;
    const router = d.router.status();
    const routerId = d.router.sourceId();
    const retireRouter = target.kind !== 'router' || routerId !== target.sourceId;
    const direct = (d.direct.inspect ? await d.direct.inspect() : d.direct.states()).filter((state) =>
      (state.running || state.ownership === 'app') &&
      (target.kind !== 'direct' || (state.sourceId !== target.sourceId &&
        (!target.endpoint || state.endpoint !== target.endpoint))));
    signal?.throwIfAborted();
    const reject = (state: Status, name: string, sourceId: string | null) => {
      if (sourceId && d.busy(sourceId)) throw new Error(`${name} is serving a request. Wait for it to finish before switching engines.`);
      if (state.running && state.ownership !== 'app') throw new Error(`${name} is managed outside Antimatter. Stop it before starting another local engine.`);
    };
    if (native) reject(native, 'Beholdd (native)', d.nativeSourceId);
    if (retireRouter) reject(router, 'The Vulkan router', routerId);
    for (const state of direct) reject(state, 'A local model server', state.sourceId);
    if (target.kind !== 'preview' && d.preview.enabled() && d.busy(d.previewSourceId)) {
      throw new Error('Experimental HAG is serving a request. Wait for it to finish before switching engines.');
    }

    if (target.kind !== 'preview' && d.preview.enabled()) await d.preview.stop();
    signal?.throwIfAborted();
    if (native?.running && (await d.native.stop()).running) {
      throw new Error('The native engine has not retired; another engine was not started.');
    }
    signal?.throwIfAborted();
    if (retireRouter && router.running && (await d.router.stop()).running) {
      throw new Error('The Vulkan router has not retired; another engine was not started.');
    }
    signal?.throwIfAborted();
    for (const state of direct) {
      await d.direct.stop(state.sourceId);
      signal?.throwIfAborted();
    }
  }
}
