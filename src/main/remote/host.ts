import { createServer, type Server as HttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { CommandLedger } from './commandLedger';
import { EventJournal } from './eventJournal';
import { PairingStore, type PublicDeviceRecord, type SecretProtector } from './pairingStore';
import { RemoteProjectCatalog, RemoteProjectUnavailableError, type RemoteProjectSummary } from './projects';
import {
  REMOTE_LIMITS,
  type JsonValue,
  type RemoteAccessMode,
  type RemoteCapability,
  type RemoteCommand,
  type RemoteCommandReceipt,
} from './protocol';
import {
  RemoteHostRouter,
  validateSecureListenerConfiguration,
  type RemoteDispatchContext,
  type RemoteDispatchResult,
  type RemoteExecutedCommandOutcome,
  type RemoteHttpRequest,
  type RemoteHttpResponse,
} from './router';
import {
  httpsEndpoint,
  listRemoteInterfaces,
  RemoteSettingsStore,
  type RemoteInterface,
  type RemoteSettings,
} from './settings';
import { RemoteTlsIdentityStore, type RemoteTlsIdentity } from './tlsIdentity';

export interface RemoteHostState {
  enabled: boolean;
  running: boolean;
  address: string | null;
  port: number;
  keepAwake: boolean;
  endpoint: string | null;
  certificatePin: string | null;
  interfaces: RemoteInterface[];
  devices: PublicDeviceRecord[];
  error: string | null;
}

export interface RemotePairingOfferView {
  id: string;
  endpoint: string;
  expiresAt: number;
  capabilities: RemoteCapability[];
  maxAccess: RemoteAccessMode;
}

export interface RemoteBootstrapContext {
  device: PublicDeviceRecord;
  workspace: { id: string; name: string };
  projects: RemoteProjectSummary[];
  cursor: { epoch: string; sequence: number };
  selectedThreadId: string | null;
}

export interface RemoteHostCallbacks {
  currentProject(): { root: string; name?: string } | null;
  /** Explicit task directories already chosen on this desktop; never inferred parent folders. */
  knownProjects?(): Array<{ root: string; name?: string }>;
  bootstrap(context: RemoteBootstrapContext): JsonValue | Promise<JsonValue>;
  thread(device: PublicDeviceRecord, threadId: string): JsonValue | null | Promise<JsonValue | null>;
  validateCommand?(device: PublicDeviceRecord, command: RemoteCommand): void | Promise<void>;
  dispatch(
    device: PublicDeviceRecord,
    command: RemoteCommand,
    receipt: RemoteCommandReceipt,
    context: RemoteDispatchContext
  ): RemoteDispatchResult | void | Promise<RemoteDispatchResult | void>;
  onDispatchError?(device: PublicDeviceRecord, command: RemoteCommand, error: unknown): void;
  /** Clear presentation state after a one-time code is consumed or invalidated. */
  onPairingInvalidated?(pairingCode: string, offerId: string): void;
  /** End device-owned turns and reject their pending approvals when authority disappears. */
  onDeviceDisconnected?(deviceId: string, reason: 'revoked' | 'disabled' | 'stopped'): void;
  onState?(state: RemoteHostState): void;
}

export interface RemoteWorkspaceHostOptions {
  userData: string;
  appVersion: string;
  protector: SecretProtector & { available(): boolean };
  callbacks: RemoteHostCallbacks;
  hostName?: string;
  /** Test seam; production offers use the short desktop QR lifetime below. */
  pairingOfferTtlMs?: number;
}

interface PairingCode {
  value: string;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
}

const PAIRING_CODE_PREFIX = 'ANTIMATTER-PAIRING-V1?';
const PAIRING_OFFER_TTL_MS = 2 * 60_000;

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

const publicError = (message: string): string =>
  message.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Remote connections could not start.';

const queryObject = (url: URL): Record<string, string | undefined> => {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      // The protocol never permits ambiguous duplicate query parameters.
      result[key] = undefined;
    } else {
      result[key] = value;
    }
  }
  return result;
};

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const method = request.method?.toUpperCase();
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return undefined;
  const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpAdapterError(415, 'Requests with a body must use application/json.');

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > REMOTE_LIMITS.jsonBodyBytes) throw new HttpAdapterError(413, 'The request body is too large.');
    chunks.push(buffer);
  }
  if (!bytes) throw new HttpAdapterError(400, 'A JSON request body is required.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpAdapterError(400, 'The request body is not valid JSON.');
  }
}

class HttpAdapterError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function writeResponse(response: ServerResponse, result: RemoteHttpResponse): void {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(result.body));
  response.writeHead(result.status, {
    ...result.headers,
    'content-length': String(body.length),
  });
  response.end(body);
}

function writeAdapterError(response: ServerResponse, error: unknown): void {
  const known = error instanceof HttpAdapterError;
  const body = Buffer.from(JSON.stringify({
    error: {
      code: known ? 'INVALID_HTTP_REQUEST' : 'INTERNAL',
      message: known ? error.message : 'The remote host could not complete this request.',
      retryable: false,
    },
  }));
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(known ? error.status : 500, { ...JSON_HEADERS, 'content-length': String(body.length) });
  response.end(body);
}

/**
 * Owns the desktop's opt-in LAN/VPN listener and every security primitive around it. The app
 * supplies snapshots and command execution; this class supplies transport, identity and trust.
 */
export class RemoteWorkspaceHost {
  private readonly settings: RemoteSettingsStore;
  private readonly pairing: PairingStore;
  private readonly projects: RemoteProjectCatalog;
  private readonly ledger: CommandLedger;
  private readonly tls: RemoteTlsIdentityStore;
  private readonly callbacks: RemoteHostCallbacks;
  private readonly appVersion: string;
  private readonly pairingOfferTtlMs: number;
  private readonly journals = new Map<string, EventJournal>();
  private readonly pairingCodes = new Map<string, PairingCode>();
  /** Survives enabled-listener reconfiguration so an applied control is never dispatched twice. */
  private readonly executedCommands = new Map<string, RemoteExecutedCommandOutcome>();
  private server: HttpsServer | null = null;
  private router: RemoteHostRouter | null = null;
  private identity: RemoteTlsIdentity | null = null;
  private failure: string | null = null;
  private transition: Promise<void> = Promise.resolve();

  constructor(options: RemoteWorkspaceHostOptions) {
    const root = join(options.userData, 'remote');
    const hostName = options.hostName?.trim() || hostname() || 'Antimatter host';
    this.callbacks = options.callbacks;
    this.appVersion = options.appVersion;
    this.pairingOfferTtlMs = options.pairingOfferTtlMs ?? PAIRING_OFFER_TTL_MS;
    this.settings = new RemoteSettingsStore(join(root, 'settings.json'));
    this.projects = new RemoteProjectCatalog(join(root, 'projects.json'));
    this.ledger = new CommandLedger({ path: join(root, 'commands.json') });
    this.pairing = new PairingStore({
      path: join(root, 'pairing.json'),
      hostName,
      protector: options.protector,
    });
    this.pairing.onOfferConsumed((offerId) => this.invalidatePairingPresentation(offerId));
    this.tls = new RemoteTlsIdentityStore(join(root, 'tls.json'), options.protector);
  }

  workspace(): { id: string; name: string } {
    const host = this.pairing.identity();
    return { id: host.id, name: host.name };
  }

  appRelease(): string {
    return this.appVersion;
  }

  listProjects(): RemoteProjectSummary[] {
    this.enrollKnownProjects();
    const projects = this.projects.list();
    const current = this.callbacks.currentProject();
    if (!current) return projects;
    const selected = this.projects.findByRoot(current.root);
    if (!selected) return projects;
    // Bootstrap marks the first entry as the default project. Keep that tied to the project the
    // desktop has actually confirmed, rather than whichever project happened to be enrolled
    // first months ago.
    return [selected, ...projects.filter((project) => project.id !== selected.id)];
  }

  resolveProject(projectId: string): { id: string; name: string; root: string } | null {
    this.enrollKnownProjects();
    return this.projects.resolve(projectId);
  }

  projectForRoot(root: string): RemoteProjectSummary | null {
    return this.projects.findByRoot(root);
  }

  cursorFor(deviceId: string): { epoch: string; sequence: number } {
    return this.eventsFor(deviceId).cursor();
  }

  /** Paired devices need replay even while disconnected; an unpaired/stopped host does not. */
  hasEventConsumers(): boolean {
    return this.server?.listening === true && this.pairing.listDevices(false).length > 0;
  }

  emitAll(event: JsonValue): void {
    if (!this.server?.listening) return;
    for (const device of this.pairing.listDevices(false)) {
      try {
        this.eventsFor(device.id).append(event);
      } catch (error) {
        // Bootstrap and command outcomes remain authoritative. Presentation delivery must never
        // turn an already-applied mutation into a failed command.
        console.error(`[remote] could not append event for device ${device.id}:`, error);
      }
    }
  }

  emitDevice(deviceId: string, event: JsonValue): void {
    if (!this.server?.listening) return;
    if (this.pairing.listDevices(false).some((device) => device.id === deviceId)) {
      try {
        this.eventsFor(deviceId).append(event);
      } catch (error) {
        console.error(`[remote] could not append event for device ${deviceId}:`, error);
      }
    }
  }

  async startConfigured(): Promise<RemoteHostState> {
    await this.enqueue(async () => {
      const settings = this.settings.read();
      if (settings.enabled) await this.start(settings);
    });
    return this.state();
  }

  async configure(patch: Partial<RemoteSettings>): Promise<RemoteHostState> {
    await this.enqueue(async () => {
      const next = this.settings.write(patch);
      await this.stopInternal({ disconnectReason: next.enabled ? null : 'disabled' });
      if (next.enabled) await this.start(next);
      else this.failure = null;
    });
    return this.state();
  }

  state(): RemoteHostState {
    const settings = this.settings.read();
    return {
      ...settings,
      running: this.server?.listening === true,
      endpoint: settings.address ? httpsEndpoint(settings.address, settings.port) : null,
      certificatePin: this.identity?.certificatePin ?? null,
      interfaces: listRemoteInterfaces(),
      devices: this.pairing.listDevices(true),
      error: this.failure,
    };
  }

  async createPairingOffer(): Promise<RemotePairingOfferView> {
    if (!this.server?.listening || !this.identity) throw new Error('Turn on Remote connections before pairing a device.');
    const settings = this.settings.read();
    if (!settings.address) throw new Error('Choose a network interface before pairing a device.');
    const endpoint = httpsEndpoint(settings.address, settings.port);
    // The desktop presents exactly one pairing surface. Replacing it must also invalidate the
    // previous bearer, rather than merely hiding an offer that could still be photographed.
    this.cancelPairingOffers();
    const offer = this.pairing.createOffer({
      // Advertise only routes that are complete on both sides. Opaque uploads/assets and direct
      // terminal/orchestrator controls remain protocol-reserved until their host stores exist.
      capabilities: ['chat', 'approvals'],
      maxAccess: 'full',
      ttlMs: this.pairingOfferTtlMs,
    });
    const parameters = new URLSearchParams({
      endpoint,
      host: offer.hostId,
      offer: offer.id,
      secret: offer.secret,
      pin: this.identity.certificatePin,
      expires: String(offer.expiresAt),
    });
    // Deliberately not a URL or registered custom scheme. The code contains a one-time bearer and
    // may leave main only as locally rendered QR pixels or through the user's explicit Copy action;
    // Android accepts it only through Antimatter's in-app scanner or Paste action. This keeps
    // system cameras, browsers, and competing intent handlers out of the pairing trust boundary.
    const code = `${PAIRING_CODE_PREFIX}${parameters.toString()}`;
    const expiryTimer = setTimeout(
      () => this.cancelPairingOffer(offer.id),
      Math.max(0, offer.expiresAt - Date.now())
    );
    expiryTimer.unref?.();
    this.pairingCodes.set(offer.id, { value: code, expiresAt: offer.expiresAt, expiryTimer });
    this.dropExpiredCodes();
    return {
      id: offer.id,
      endpoint,
      expiresAt: offer.expiresAt,
      capabilities: [...offer.capabilities],
      maxAccess: offer.maxAccess,
    };
  }

  pairingCode(offerId: string): string | null {
    this.dropExpiredCodes();
    return this.pairingCodes.get(offerId)?.value ?? null;
  }

  cancelPairingOffer(offerId: string): boolean {
    const canceled = this.pairing.cancelOffer(offerId);
    return this.invalidatePairingPresentation(offerId) || canceled;
  }

  private invalidatePairingPresentation(offerId: string): boolean {
    const code = this.pairingCodes.get(offerId);
    if (!code) return false;
    clearTimeout(code.expiryTimer);
    this.pairingCodes.delete(offerId);
    try {
      this.callbacks.onPairingInvalidated?.(code.value, offerId);
    } catch {
      // Clipboard cleanup is presentation hygiene; offer invalidation is already authoritative.
    }
    return true;
  }

  /** Cancels any pairing surface whose owning renderer is no longer visible or alive. */
  cancelPairingOffers(): number {
    const ids = [...this.pairingCodes.keys()];
    let count = 0;
    for (const id of ids) {
      if (this.cancelPairingOffer(id)) count += 1;
    }
    return count + this.pairing.clearOffers();
  }

  revokeDevice(deviceId: string): RemoteHostState {
    const revoked = this.pairing.revoke(deviceId);
    if (revoked) this.notifyDeviceDisconnected(deviceId, 'revoked');
    this.journals.get(deviceId)?.close(new Error('Device authorization was revoked.'));
    this.journals.delete(deviceId);
    const state = this.state();
    this.callbacks.onState?.(state);
    return state;
  }

  async stop(): Promise<void> {
    await this.enqueue(() => this.stopInternal({ disconnectReason: 'stopped' }));
  }

  private async start(settings: RemoteSettings): Promise<void> {
    this.failure = null;
    try {
      if (!settings.address) throw new Error('Choose a network interface before enabling Remote.');
      const bindAddress = settings.address;
      this.identity = await this.tls.loadOrCreate();
      validateSecureListenerConfiguration({
        bindAddress: settings.address,
        port: settings.port,
        tls: true,
        certificatePin: this.identity.certificatePin,
      });
      this.enrollKnownProjects();
      const workspace = this.workspace();
      const router = new RemoteHostRouter({
        pairing: this.pairing,
        ledger: this.ledger,
        workspace,
        certificatePin: this.identity.certificatePin,
        eventsFor: (deviceId) => this.eventsFor(deviceId),
        authorizeProject: (_device, projectId) => this.resolveProject(projectId) !== null,
        validateCommand: this.callbacks.validateCommand,
        bootstrap: (device, selectedThreadId) => this.callbacks.bootstrap({
          device,
          workspace,
          projects: this.listProjects(),
          cursor: this.cursorFor(device.id),
          selectedThreadId,
        }),
        thread: this.callbacks.thread,
        dispatch: this.callbacks.dispatch,
        executedCommands: this.executedCommands,
        onDispatchError: this.callbacks.onDispatchError,
        revokeDevice: (device) => {
          this.revokeDevice(device.id);
        },
        onPaired: (_device, offerId) => {
          this.cancelPairingOffer(offerId);
          this.callbacks.onState?.(this.state());
        },
      });
      const server = createServer({ cert: this.identity.cert, key: this.identity.key }, (request, response) => {
        void this.handleHttp(router, request, response);
      });
      server.requestTimeout = 35_000;
      server.headersTimeout = 5_000;
      server.keepAliveTimeout = 5_000;
      server.maxRequestsPerSocket = 100;
      server.maxConnections = 32;
      // Publish these before listen so a failed bind is closed by the shared cleanup path.
      this.router = router;
      this.server = server;
      // Recovery runs while the listener is still unreachable. Bootstrap snapshots and durable
      // command outcomes become authoritative before a client can submit a newer revision.
      await router.recover();
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          server.off('listening', listening);
          reject(error);
        };
        const listening = () => {
          server.off('error', failed);
          resolve();
        };
        server.once('error', failed);
        server.once('listening', listening);
        server.listen(settings.port, bindAddress);
      });
      this.callbacks.onState?.(this.state());
    } catch (error) {
      this.failure = publicError((error as Error).message);
      await this.stopInternal({ notify: false, disconnectReason: 'stopped' });
      this.callbacks.onState?.(this.state());
    }
  }

  private async handleHttp(router: RemoteHostRouter, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const aborted = () => controller.abort();
    request.once('aborted', aborted);
    response.once('close', aborted);
    try {
      if (request.headers.origin) throw new HttpAdapterError(403, 'Browser-origin requests are not accepted.');
      const rawUrl = request.url ?? '/';
      if (rawUrl.length > 8_192) throw new HttpAdapterError(414, 'The request URL is too long.');
      const parsed = new URL(rawUrl, 'https://antimatter.invalid');
      const input: RemoteHttpRequest = {
        secure: true,
        method: request.method ?? 'GET',
        pathname: parsed.pathname,
        query: queryObject(parsed),
        headers: request.headers,
        body: await jsonBody(request),
        signal: controller.signal,
      };
      writeResponse(response, await router.handle(input));
    } catch (error) {
      writeAdapterError(response, error);
    } finally {
      request.off('aborted', aborted);
      response.off('close', aborted);
    }
  }

  private async stopInternal(options: {
    notify?: boolean;
    disconnectReason?: 'disabled' | 'stopped' | null;
  } = {}): Promise<void> {
    const { notify = true, disconnectReason = null } = options;
    const router = this.router;
    const server = this.server;
    this.router = null;
    this.server = null;
    // A pairing code grants a one-time credential to the exact listener instance the user saw. Never let
    // that secret remain exchangeable after an address change, restart, disable, or failed bind.
    this.cancelPairingOffers();
    // Gate protocol handling and stop accepting sockets before taking the dispatcher-tail
    // snapshot. Work already accepted is drained; requests racing shutdown cannot add new work.
    router?.close();
    const serverClosed = server
      ? new Promise<void>((resolve) => {
          server.close(() => resolve());
          // Node recommends invoking this after close() to avoid a new connection slipping into
          // the gap. Existing responses are no longer authoritative once the router is gated.
          server.closeAllConnections?.();
        })
      : Promise.resolve();
    await router?.drain();
    if (disconnectReason) {
      for (const device of this.pairing.listDevices(false)) {
        this.notifyDeviceDisconnected(device.id, disconnectReason);
      }
    }
    await serverClosed;
    for (const journal of this.journals.values()) journal.close();
    this.journals.clear();
    if (notify) this.callbacks.onState?.(this.state());
  }

  private notifyDeviceDisconnected(
    deviceId: string,
    reason: 'revoked' | 'disabled' | 'stopped'
  ): void {
    try {
      this.callbacks.onDeviceDisconnected?.(deviceId, reason);
    } catch (error) {
      // Revocation and listener shutdown remain authoritative even if app-side cleanup fails.
      console.error(`[remote] could not disconnect work owned by device ${deviceId}:`, error);
    }
  }

  private eventsFor(deviceId: string): EventJournal {
    let journal = this.journals.get(deviceId);
    if (!journal) {
      journal = new EventJournal({ workspaceId: this.workspace().id });
      this.journals.set(deviceId, journal);
    }
    return journal;
  }

  private enrollKnownProjects(): void {
    const current = this.callbacks.currentProject();
    const known = this.callbacks.knownProjects?.() ?? [];
    const seen = new Set<string>();
    for (const project of [...(current ? [current] : []), ...known]) {
      const root = resolve(project.root);
      if (seen.has(root)) continue;
      seen.add(root);
      try {
        this.projects.ensure(project.root, project.name);
      } catch (error) {
        // A stale task directory must not prevent pairing or hide every other
        // project. Failures persisting the catalog still surface to the desktop.
        if (!(error instanceof RemoteProjectUnavailableError)) throw error;
      }
    }
  }

  private dropExpiredCodes(): void {
    const now = Date.now();
    for (const [id, code] of [...this.pairingCodes]) {
      if (code.expiresAt <= now) this.cancelPairingOffer(id);
    }
  }

  private async enqueue(operation: () => void | Promise<void>): Promise<void> {
    const next = this.transition.then(operation, operation);
    this.transition = next.catch(() => undefined);
    await next;
  }
}
