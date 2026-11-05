import {
  assertInferenceServerId,
  LOCAL_ENGINE_PREFIX,
  localEngineSourceId,
  type InferenceServerId,
  type InferenceServerState,
} from '../api/inferenceServers';
import type { LocalEngineState } from './localEngineLifecycle';

/**
 * Both engines report nearly the same shape already. This module is the only place that turns
 * them into one list, decides when an action is safe, and names the source each one is serving.
 * It owns no process: every stop and start goes through the engine's own lifecycle queue, so a
 * request from this panel cannot race a model switch.
 */

interface EngineStatus {
  running: boolean;
  ready: boolean;
  ownership: 'app' | 'external' | null;
  pid: number | null;
  startedAt: number | null;
  host: string | null;
  port: number | null;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  logs: string[];
  executionScope?: string;
}

/** Supplied by the caller so the real selection resolver stays in the main entry point. */
export interface RouterSelection {
  sourceId: string;
  modelId: string;
  modelPath: string;
  preset: string;
}

export interface InferenceServerDeps {
  beholdd: {
    inspectStatus(): Promise<EngineStatus & { configPath: string | null }>;
    start(options: Record<string, never>): Promise<unknown>;
    stop(): Promise<unknown>;
    restart(options: Record<string, never>): Promise<unknown>;
  };
  router: {
    status(): EngineStatus & { modelPath: string | null };
    start(selection?: RouterSelection): Promise<unknown>;
    stop(): Promise<unknown>;
    /** The configured source the router is currently bound to, when it has one. */
    managedSourceId(): string | null;
    compatibilitySourceId: string;
    /** Resolves a workload source back to the selection needed to start it again. */
    selectionFor(sourceId: string): RouterSelection | undefined;
    /** Whether the router has a checkpoint to load with no explicit selection. */
    hasPackagedModel(): boolean;
  };
  /** The native engine is reached through its own configured source id. */
  beholddSourceId: string;
  /**
   * The unit-backed loopback engines Antimatter has registered. Only sources present here can be
   * named by an `engine:` id, which is what keeps that id from addressing anything else.
   */
  localEngines: {
    states(): LocalEngineState[];
    stopSource(sourceId: string): Promise<void>;
  };
  busy(sourceId: string): boolean;
  sourceName(sourceId: string): string | null;
}

const NAMES: Record<'bundled-beholdd' | 'bundled-llama-vulkan', { name: string; role: string }> = {
  'bundled-beholdd': {
    name: 'Beholdd (native)',
    role: 'The native engine. Serves configured CPU and qualified HAG models.',
  },
  'bundled-llama-vulkan': {
    name: 'llama.cpp router (Vulkan)',
    role: 'The GPU router. Serves the compatibility source and every prepared workload, including DeepSeek.',
  },
};

export class InferenceServers {
  constructor(private readonly deps: InferenceServerDeps) {}

  private endpoint(host: string | null, port: number | null): string | null {
    return host && port ? `http://${host}:${port}` : null;
  }

  private async beholddState(): Promise<InferenceServerState> {
    const status = await this.deps.beholdd.inspectStatus();
    const sourceId = status.running ? this.deps.beholddSourceId : null;
    return {
      id: 'bundled-beholdd',
      ...NAMES['bundled-beholdd'],
      ...(status.executionScope ? { role: status.executionScope } : {}),
      running: status.running,
      ready: status.ready,
      ownership: status.ownership,
      pid: status.pid,
      startedAt: status.startedAt,
      endpoint: this.endpoint(status.host, status.port),
      detail: status.configPath,
      sourceId,
      sourceName: sourceId ? this.deps.sourceName(sourceId) : null,
      busy: sourceId !== null && this.deps.busy(sourceId),
      startable: true,
      lastExit: status.lastExit,
      logs: status.logs,
      statusError: null,
    };
  }

  /** An engine whose status cannot be read is reported as unknown, never as stopped. */
  private unreadable(id: 'bundled-beholdd' | 'bundled-llama-vulkan', cause: unknown): InferenceServerState {
    return {
      id, ...NAMES[id], running: false, ready: false, ownership: null, pid: null, startedAt: null,
      endpoint: null, detail: null, sourceId: null, sourceName: null, busy: false, startable: false,
      lastExit: null, logs: [],
      statusError: cause instanceof Error ? cause.message : String(cause),
    };
  }

  private routerState(): InferenceServerState {
    const status = this.deps.router.status();
    const sourceId = this.deps.router.managedSourceId();
    // A stopped router can still be started when it has a selection to restore, or when the
    // packaged compatibility checkpoint is present. Otherwise starting could only fail.
    const startable = (sourceId !== null && this.routerSelection(sourceId) !== undefined) ||
      this.deps.router.hasPackagedModel();
    return {
      id: 'bundled-llama-vulkan',
      ...NAMES['bundled-llama-vulkan'],
      running: status.running,
      ready: status.ready,
      ownership: status.ownership,
      pid: status.pid,
      startedAt: status.startedAt,
      endpoint: this.endpoint(status.host, status.port),
      detail: status.modelPath,
      sourceId,
      sourceName: sourceId ? this.deps.sourceName(sourceId) : null,
      busy: sourceId !== null && this.deps.busy(sourceId),
      startable,
      lastExit: status.lastExit,
      logs: status.logs,
      statusError: null,
    };
  }

  /**
   * The compatibility source loads the packaged checkpoint and needs no selection; a workload
   * source is resolved back to its verified preset. A workload whose files have gone missing
   * resolves to nothing rather than throwing, so the panel still renders and reports the state.
   */
  private routerSelection(sourceId: string): RouterSelection | undefined {
    if (sourceId === this.deps.router.compatibilitySourceId) return undefined;
    try {
      return this.deps.router.selectionFor(sourceId);
    } catch {
      return undefined;
    }
  }

  /**
   * One row per unit-backed engine Antimatter has registered. A failed engine that spent its
   * restart budget keeps its row, carrying the reason: giving up quietly would leave the panel
   * claiming nothing is wrong while chats fail.
   */
  private localEngineState(engine: LocalEngineState): InferenceServerState {
    const name = this.deps.sourceName(engine.sourceId) ?? engine.model ?? engine.unit;
    const detail = engine.gaveUp || engine.lastError
      ? `${engine.unit} — ${engine.lastError ?? 'stopped repeatedly and was not restarted again.'}`
      : engine.unit;
    return {
      id: `${LOCAL_ENGINE_PREFIX}${engine.sourceId}`,
      name,
      role: engine.ownership === 'external'
        ? 'A local llama.cpp server started outside Antimatter. Used, but not managed from here.'
        : 'A local llama.cpp server Antimatter started for this source. It is released when the window closes.',
      running: engine.running && !engine.gaveUp,
      ready: engine.ready && !engine.gaveUp,
      ownership: engine.ownership,
      pid: null,
      startedAt: engine.startedAt,
      endpoint: engine.endpoint,
      detail,
      sourceId: engine.sourceId,
      sourceName: this.deps.sourceName(engine.sourceId),
      busy: this.deps.busy(engine.sourceId),
      // Starting happens through a request, which is the only thing that knows which model to
      // ask for. Offering a bare "start" here would load a checkpoint with nothing to use it.
      startable: false,
      lastExit: null,
      logs: engine.logs,
      statusError: null,
    };
  }

  /**
   * The native engine probes its endpoint, so resolve both together rather than in sequence.
   * Either may fail on its own without taking the other's controls down with it.
   */
  async list(): Promise<InferenceServerState[]> {
    const [cpu, router] = await Promise.all([
      this.beholddState().catch((cause) => this.unreadable('bundled-beholdd', cause)),
      (async () => this.routerState())().catch((cause) => this.unreadable('bundled-llama-vulkan', cause)),
    ]);
    let engines: InferenceServerState[] = [];
    // The bundled servers' controls must render even if this list cannot be built, but a failure
    // here is a defect rather than a state worth hiding, so it is reported rather than swallowed.
    try { engines = this.deps.localEngines.states().map((engine) => this.localEngineState(engine)); }
    catch (cause) { console.error('[inference-servers] local engine states unavailable:', cause); }
    return [cpu, router, ...engines];
  }

  private assertActionable(state: InferenceServerState, verb: string, force: boolean): void {
    if (state.statusError !== null) {
      throw new Error(`${state.name} status could not be read, so it was not ${verb}: ${state.statusError}`);
    }
    if (state.ownership === 'external') {
      throw new Error(`${state.name} is managed outside Antimatter and cannot be ${verb} here.`);
    }
    if (state.busy && !force) {
      throw new Error(
        `${state.name} is serving a request right now. Wait for it to finish, or choose ${verb} anyway to abandon that turn.`
      );
    }
  }

  /** Resolve an `engine:` id against the registered engines, so an invented one names nothing. */
  private async localEngine(id: InferenceServerId): Promise<InferenceServerState | null> {
    const sourceId = localEngineSourceId(id);
    if (sourceId === null) return null;
    const engine = this.deps.localEngines.states().find((candidate) => candidate.sourceId === sourceId);
    if (!engine) throw new Error('That inference server is not available.');
    return this.localEngineState(engine);
  }

  async start(value: unknown): Promise<InferenceServerState[]> {
    const id = assertInferenceServerId(value);
    const engine = await this.localEngine(id);
    if (engine) {
      // A unit-backed engine is started by the request that needs it, which is the only place
      // that knows which model to ask for and which source to bill the work to.
      throw new Error(`${engine.name} starts itself on the next request that needs it.`);
    }
    if (id === 'bundled-beholdd') await this.deps.beholdd.start({});
    else {
      const sourceId = this.deps.router.managedSourceId();
      await this.deps.router.start(sourceId ? this.routerSelection(sourceId) : undefined);
    }
    return this.list();
  }

  async stop(value: unknown, force = false): Promise<InferenceServerState[]> {
    const id = assertInferenceServerId(value);
    const engine = await this.localEngine(id);
    if (engine) {
      this.assertActionable(engine, 'stopped', force);
      await this.deps.localEngines.stopSource(engine.sourceId!);
      return this.list();
    }
    const current = (await this.list()).find((state) => state.id === id);
    if (!current) throw new Error('That inference server is not available.');
    this.assertActionable(current, 'stopped', force);
    if (id === 'bundled-beholdd') await this.deps.beholdd.stop();
    else await this.deps.router.stop();
    return this.list();
  }

  /**
   * Stop and start in one action, for a server that is up but wedged. The router is restarted
   * with the selection it already holds, so a crashed workload comes back as itself rather than
   * silently falling back to the packaged checkpoint. Credentials are re-read by the next turn,
   * which asks the engine to prepare again, so restarting under an idle chat is safe.
   */
  async restart(value: unknown, force = false): Promise<InferenceServerState[]> {
    const id = assertInferenceServerId(value);
    const engine = await this.localEngine(id);
    if (engine) {
      // Stop only: the next request brings it back, with its retry budget reset. Restarting it
      // here would reload a checkpoint that may have nothing waiting to use it.
      this.assertActionable(engine, 'restarted', force);
      await this.deps.localEngines.stopSource(engine.sourceId!);
      return this.list();
    }
    const current = (await this.list()).find((state) => state.id === id);
    if (!current) throw new Error('That inference server is not available.');
    this.assertActionable(current, 'restarted', force);
    if (id === 'bundled-beholdd') {
      await this.deps.beholdd.restart({});
      return this.list();
    }
    const sourceId = current.sourceId;
    const selection = sourceId ? this.routerSelection(sourceId) : undefined;
    if (sourceId && sourceId !== this.deps.router.compatibilitySourceId && selection === undefined) {
      throw new Error(
        `${current.sourceName ?? 'This workload'} is no longer set up on this computer. Open Models → Workloads and set it up again before restarting the router.`
      );
    }
    await this.deps.router.stop();
    await this.deps.router.start(selection);
    return this.list();
  }
}
