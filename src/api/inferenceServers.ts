/**
 * The inference servers Antimatter runs on this computer, as one list the renderer can show and
 * act on. Two are processes this app spawns itself: the bundled native CPU engine, and the
 * llama.cpp Vulkan router that serves the compatibility source and every prepared workload. The
 * rest are the user systemd units behind configured loopback sources, which Antimatter starts on
 * first use and releases when it is done with them (see main/localEngineLifecycle.ts).
 *
 * The two bundled servers have fixed ids. A unit-backed engine is addressed as `engine:<sourceId>`
 * — still not a path, a port, or a process id, and still not a free-form target: the main process
 * resolves the source id against the engines it has actually registered and owns, so an id the
 * renderer invents resolves to nothing. That is what keeps this list from becoming a way to stop
 * an unrelated process.
 */
export type InferenceServerId = 'bundled-beholdd' | 'bundled-llama-vulkan' | `engine:${string}`;

export const INFERENCE_SERVER_IDS: readonly InferenceServerId[] = Object.freeze([
  'bundled-beholdd',
  'bundled-llama-vulkan',
]);

export const LOCAL_ENGINE_PREFIX = 'engine:';

/** The source id inside an `engine:` server id, or null for the fixed bundled servers. */
export function localEngineSourceId(id: InferenceServerId): string | null {
  return id.startsWith(LOCAL_ENGINE_PREFIX) ? id.slice(LOCAL_ENGINE_PREFIX.length) : null;
}

export interface InferenceServerState {
  id: InferenceServerId;
  name: string;
  /** What this server is for, in one line. */
  role: string;
  running: boolean;
  /** The endpoint answered its model list on the latest probe. */
  ready: boolean;
  /** Only an `app`-owned server may be stopped or restarted from Antimatter. */
  ownership: 'app' | 'external' | null;
  pid: number | null;
  startedAt: number | null;
  endpoint: string | null;
  /** The config path (native engine) or model file (router) the running server started with. */
  detail: string | null;
  /** The configured source this server is serving right now, when it has one. */
  sourceId: string | null;
  sourceName: string | null;
  /** A turn is in flight against this server. Stopping it would abandon that turn. */
  busy: boolean;
  /**
   * Whether a start would have something to load. The router needs either a configured
   * workload or the packaged compatibility checkpoint; without one, starting can only fail.
   */
  startable: boolean;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  logs: string[];
  /**
   * Set when this server's own status could not be read. The other servers still report
   * normally, so one broken engine never hides the controls for the rest.
   */
  statusError: string | null;
}

/** A busy server is refused unless the person explicitly chooses to abandon the turn. */
export interface InferenceServerAction {
  force?: boolean;
}

export interface InferenceServersAPI {
  list(): Promise<InferenceServerState[]>;
  start(id: InferenceServerId): Promise<InferenceServerState[]>;
  stop(id: InferenceServerId, options?: InferenceServerAction): Promise<InferenceServerState[]>;
  restart(id: InferenceServerId, options?: InferenceServerAction): Promise<InferenceServerState[]>;
}

export function assertInferenceServerId(value: unknown): InferenceServerId {
  if (typeof value !== 'string') throw new Error('Choose one of this computer’s inference servers.');
  if (INFERENCE_SERVER_IDS.includes(value as InferenceServerId)) return value as InferenceServerId;
  // Shape only. Whether this names a registered, app-owned engine is decided by the main process
  // against its own records, never by trusting the string.
  const source = value.startsWith(LOCAL_ENGINE_PREFIX) ? value.slice(LOCAL_ENGINE_PREFIX.length) : '';
  if (!source || source.length > 256 || /[\u0000-\u001f\u007f]/.test(source)) {
    throw new Error('Choose one of this computer’s inference servers.');
  }
  return value as InferenceServerId;
}

/** Only an explicit `{ force: true }` from the renderer may interrupt an in-flight turn. */
export function assertInferenceServerAction(value: unknown): Required<InferenceServerAction> {
  if (value === undefined || value === null) return { force: false };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid server action.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'force')) throw new Error('Unknown server action option.');
  if (Object.hasOwn(input, 'force') && typeof input.force !== 'boolean') throw new Error('Invalid server action.');
  return { force: input.force === true };
}
