import { createServer, type Server as HttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_NODE_AGENT_PORT,
  NODE_AGENT_PROTOCOL,
  NODE_PAIRING_PREFIX,
  assertNodeScopes,
  type NodeScope,
  type NodeAccelerator,
  type NodeAgentReport,
  type NodeAgentSettings,
  type NodeAgentStatus,
  type NodeCheckpoint,
  type NodePairingOfferView,
} from '../../api/nodeAgent';
import { assertClusterAction, parseClusterEngines, parseClusterVitals, type ClusterVitals, type ClusterEngine, type ClusterEngineAction } from '../../api/cluster';
import { ensurePrivateDirectory } from '../privateState';
import { httpsEndpoint, listRemoteInterfaces } from '../remote/settings';
import type { SecretProtector } from '../remote/pairingStore';
import { RemoteTlsIdentityStore, type RemoteTlsIdentity } from '../remote/tlsIdentity';
import { NodeAgentSettingsStore } from './settings';
import { NodeTrustError, NodeTrustStore } from './trust';

/** Pinned TLS node protocol. Inventory, vitals, and registered-engine controls each enforce their pairing scope. */

export interface NodeReadings {
  accelerators(): Promise<NodeAccelerator[]>;
  /** Prepared checkpoints already verified on this box's disk. */
  checkpoints(): Promise<NodeCheckpoint[]>;
}

export interface NodeAgentOptions {
  userData: string;
  appVersion: string;
  protector: SecretProtector & { available(): boolean };
  readings: NodeReadings;
  nodeName?: string;
  /** Test seam. Production offers use the same short lifetime the desktop QR does. */
  offerTtlMs?: number;
  onState?(status: NodeAgentStatus): void;
  cluster?: {
    vitals(): Promise<ClusterVitals>;
    engines(): Promise<ClusterEngine[]>;
    action(input: ClusterEngineAction): Promise<ClusterEngine[]>;
  };
}

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

/** A pairing body is tiny. Anything larger is not a pairing attempt. */
const BODY_LIMIT_BYTES = 4 * 1024;

export interface AgentResponse {
  status: number;
  body: Record<string, unknown>;
}

const publicError = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'The node agent could not answer.';
};

export class NodeAgent {
  private readonly settings: NodeAgentSettingsStore;
  private readonly identityStore: RemoteTlsIdentityStore;
  private readonly trustPath: string;
  private readonly nodeName: string;
  private readonly offerTtlMs: number;
  private trust: NodeTrustStore | null = null;
  private identity: RemoteTlsIdentity | null = null;
  private server: HttpsServer | null = null;
  private failure: string | null = null;
  private readonly engineActions = new Map<string, { fingerprint: string; at: number; result: Promise<AgentResponse>; pending: boolean }>();
  /** Rendered codes live only here, and only while their offer does. */
  private readonly codes = new Map<string, { value: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly options: NodeAgentOptions) {
    const directory = join(options.userData, 'node-agent');
    ensurePrivateDirectory(directory);
    this.settings = new NodeAgentSettingsStore(join(directory, 'settings.json'));
    this.identityStore = new RemoteTlsIdentityStore(join(directory, 'identity.json'), options.protector, 'node agent');
    this.trustPath = join(directory, 'trust.json');
    this.nodeName = (options.nodeName ?? hostname()).trim().slice(0, 80) || 'this box';
    this.offerTtlMs = options.offerTtlMs ?? 2 * 60_000;
  }

  /** Brings the listener up if the stored setting says it should be. Never throws. */
  async initialize(): Promise<void> {
    try {
      if (this.settings.read().enabled) await this.start();
    } catch (cause) {
      this.failure = publicError(cause);
    }
    this.announce();
  }

  status(): NodeAgentStatus {
    const settings = this.settings.read();
    return {
      ...settings,
      running: this.server?.listening === true,
      endpoint: settings.address ? httpsEndpoint(settings.address, settings.port) : null,
      certificatePin: this.identity?.certificatePin ?? null,
      interfaces: listRemoteInterfaces(),
      controllers: this.trust ? this.trust.listControllers() : [],
      error: this.failure,
    };
  }

  async configure(patch: Partial<NodeAgentSettings>): Promise<NodeAgentStatus> {
    const next = this.settings.write(patch);
    await this.stop();
    this.failure = null;
    if (next.enabled) {
      try {
        await this.start();
      } catch (cause) {
        this.failure = publicError(cause);
        // Enabling it and failing to bind must not leave the setting claiming it is on.
        this.settings.write({ enabled: false });
      }
    }
    const status = this.status();
    this.announce(status);
    return status;
  }

  async createPairingOffer(requestedScopes: readonly NodeScope[] = ['inventory']): Promise<NodePairingOfferView> {
    const scopes = assertNodeScopes(requestedScopes);
    if (scopes.some((scope) => scope !== 'inventory') && !this.options.cluster) throw new Error('Cluster controls are unavailable on this node.');
    if (!this.server?.listening || !this.identity || !this.trust) {
      throw new Error('Turn this box on as an inference node before pairing a controller.');
    }
    const settings = this.settings.read();
    if (!settings.address) throw new Error('Choose a network interface before pairing a controller.');
    const endpoint = httpsEndpoint(settings.address, settings.port);
    this.clearCodes();
    const offer = this.trust.createOffer(scopes, this.offerTtlMs);
    const parameters = new URLSearchParams({
      endpoint,
      node: offer.nodeId,
      offer: offer.id,
      secret: offer.secret,
      pin: this.identity.certificatePin,
      expires: String(offer.expiresAt),
      scopes: offer.scopes.join(','),
    });
    const value = `${NODE_PAIRING_PREFIX}${parameters.toString()}`;
    const timer = setTimeout(() => this.cancelPairingOffer(offer.id), Math.max(0, offer.expiresAt - Date.now()));
    timer.unref?.();
    this.codes.set(offer.id, { value, expiresAt: offer.expiresAt, timer });
    return { id: offer.id, endpoint, expiresAt: offer.expiresAt, scopes: [...offer.scopes] };
  }

  pairingCode(offerId: string): string | null {
    const code = this.codes.get(offerId);
    if (!code) return null;
    if (code.expiresAt <= Date.now()) {
      this.cancelPairingOffer(offerId);
      return null;
    }
    return code.value;
  }

  cancelPairingOffer(offerId: string): boolean {
    const code = this.codes.get(offerId);
    if (code) {
      clearTimeout(code.timer);
      this.codes.delete(offerId);
    }
    return (this.trust?.cancelOffer(offerId) ?? false) || code !== undefined;
  }

  revokeController(controllerId: string): NodeAgentStatus {
    this.trust?.revoke(controllerId);
    const status = this.status();
    this.announce(status);
    return status;
  }

  /**
   * The routing layer, separated from the socket so the protocol can be tested without one.
   *
   * Every failure answers in the protocol's own shape. A caller holding no credential learns the
   * same thing from `/v1/report` as from a path that does not exist: nothing.
   */
  async respond(method: string, path: string, authorization: string | undefined, body: unknown): Promise<AgentResponse> {
    if (!this.trust) return { status: 503, body: { error: 'UNAVAILABLE', message: 'This node is not answering.' } };
    if (method === 'POST' && path === '/v1/pair') {
      const input = (body ?? {}) as Record<string, unknown>;
      try {
        const result = this.trust.exchange({
          offerId: String(input.offerId ?? ''),
          secret: String(input.secret ?? ''),
          controllerName: String(input.controllerName ?? ''),
          clientVersion: String(input.clientVersion ?? ''),
          requestedScopes: Array.isArray(input.scopes) ? (input.scopes as string[]) : [],
        });
        this.announce();
        return { status: 200, body: { ...result, protocol: NODE_AGENT_PROTOCOL } };
      } catch (cause) {
        const status = cause instanceof NodeTrustError ? cause.status : 400;
        return { status, body: { error: 'PAIRING_REFUSED', message: publicError(cause) } };
      }
    }
    if (method === 'GET' && path === '/v1/report') {
      const prefix = 'Bearer ';
      const credential = authorization?.startsWith(prefix) ? authorization.slice(prefix.length).trim() : '';
      const controller = this.trust.authenticate(credential);
      if (!controller || !controller.scopes.includes('inventory')) {
        return { status: 401, body: { error: 'UNAUTHORIZED', message: 'This node does not know you.' } };
      }
      return { status: 200, body: { ...(await this.report()) } };
    }
    const scope = method === 'GET' && path === '/v1/vitals' ? 'vitals'
      : method === 'GET' && path === '/v1/engines' || method === 'POST' && path === '/v1/engines/action' ? 'manage-engines' : null;
    if (scope) {
      const controller = this.trust.authenticate(authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '');
      if (!controller) return { status: 401, body: { error: 'UNAUTHORIZED', message: 'This node does not know you.' } };
      if (!controller.scopes.includes(scope)) return { status: 403, body: { error: 'SCOPE_REQUIRED', message: 'Pair again with the required permission on this node.' } };
      if (!this.options.cluster) return { status: 503, body: { error: 'UNAVAILABLE', message: 'Cluster controls are unavailable on this node.' } };
      if (path === '/v1/vitals') return { status: 200, body: { ...parseClusterVitals(await this.options.cluster.vitals()) } };
      if (path === '/v1/engines') return { status: 200, body: { engines: parseClusterEngines(await this.options.cluster.engines()) } };
      let input: ClusterEngineAction;
      try { input = assertClusterAction(body); }
      catch { return { status: 400, body: { error: 'INVALID_ACTION', message: 'Choose a valid engine action.' } }; }
      const key = `${controller.id}:${input.requestId}`;
      const fingerprint = JSON.stringify(input);
      for (const [id, record] of this.engineActions) if (!record.pending && Date.now() - record.at > 10 * 60_000) this.engineActions.delete(id);
      const existing = this.engineActions.get(key);
      if (existing) return existing.fingerprint === fingerprint ? existing.result
        : { status: 409, body: { error: 'REQUEST_REUSED', message: 'This request identifier was used for another action.' } };
      if (this.engineActions.size >= 256 || [...this.engineActions.values()].filter((record) => record.pending).length >= 4) {
        return { status: 429, body: { error: 'BUSY', message: 'This node has too many pending requests. Try again later.' } };
      }
      const result = (async (): Promise<AgentResponse> => {
        try {
          const engines = parseClusterEngines(await this.options.cluster!.engines());
          const engine = engines.find((engine) => engine.id === input.serverId);
          if (!engine) return { status: 404, body: { error: 'ENGINE_MISSING', message: 'That engine is no longer registered.' } };
          if (engine.ownership === 'external') return { status: 403, body: { error: 'ENGINE_EXTERNAL', message: 'Antimatter does not own this engine.' } };
          if (engine.busy && !input.force) return { status: 409, body: { error: 'ENGINE_BUSY', message: 'This engine is serving active work. Stop the work or explicitly allow interruption.' } };
          return { status: 200, body: { engines: parseClusterEngines(await this.options.cluster!.action(input)) } };
        } catch {
          return { status: 500, body: { error: 'ACTION_FAILED', message: 'The engine action failed. Check this node’s local logs.' } };
        } finally {
          const entry = this.engineActions.get(key); if (entry) entry.pending = false;
        }
      })();
      this.engineActions.set(key, { fingerprint, at: Date.now(), result, pending: true });
      return result;
    }
    return { status: 404, body: { error: 'NOT_FOUND', message: 'No such route.' } };
  }

  localReport(): Promise<NodeAgentReport> { return this.report(); }

  private async report(): Promise<NodeAgentReport> {
    const [accelerators, checkpoints] = await Promise.all([
      this.options.readings.accelerators().catch(() => [] as NodeAccelerator[]),
      this.options.readings.checkpoints().catch(() => [] as NodeCheckpoint[]),
    ]);
    // A device publishing no total is unknown, not zero: summing it in would quietly understate
    // the box, and a controller choosing where to put a 90 GiB checkpoint would be misled.
    const known = accelerators.filter((device) => device.memoryTotal !== null);
    const identity = this.trust?.identity();
    return {
      protocol: NODE_AGENT_PROTOCOL,
      agentVersion: this.options.appVersion,
      nodeId: identity?.id ?? 'local',
      name: identity?.name ?? this.nodeName,
      accelerators,
      memoryTotal: known.length ? known.reduce((sum, device) => sum + (device.memoryTotal ?? 0), 0) : null,
      memoryFree: known.length ? known.reduce((sum, device) => sum + (device.memoryFree ?? 0), 0) : null,
      checkpoints,
      observedAt: Date.now(),
    };
  }

  private async start(): Promise<void> {
    const settings = this.settings.read();
    if (!settings.enabled || !settings.address) throw new Error('The node agent has no interface to bind.');
    if (!this.options.protector.available()) {
      throw new Error('Answering as an inference node requires a secure operating-system keyring.');
    }
    this.identity = await this.identityStore.loadOrCreate();
    this.trust ??= new NodeTrustStore({
      path: this.trustPath,
      nodeName: this.nodeName,
      protector: this.options.protector,
      offerTtlMs: this.offerTtlMs,
    });

    const server = createServer({ cert: this.identity.cert, key: this.identity.key }, (request, response) => {
      void this.serve(request, response);
    });
    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: settings.address!, port: settings.port, exclusive: true }, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    server.on('error', (error) => {
      this.failure = publicError(error);
      this.announce();
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    // Pairing material is in memory and must not outlive the listener it was offered on.
    this.clearCodes();
    this.trust?.clearOffers();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
  }

  private clearCodes(): void {
    for (const code of this.codes.values()) clearTimeout(code.timer);
    this.codes.clear();
  }

  private announce(status = this.status()): void {
    try {
      this.options.onState?.(status);
    } catch {
      // Presentation is best-effort and cannot change what this box answers.
    }
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (result: AgentResponse) => {
      const payload = JSON.stringify(result.body);
      response.writeHead(result.status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(payload) });
      response.end(payload);
    };
    try {
      const url = new URL(request.url ?? '/', 'https://node.invalid');
      const method = (request.method ?? 'GET').toUpperCase();
      let body: unknown;
      if (method === 'POST') {
        const type = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
        if (type !== 'application/json') {
          return send({ status: 415, body: { error: 'UNSUPPORTED_MEDIA_TYPE', message: 'Use application/json.' } });
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > BODY_LIMIT_BYTES) {
            return send({ status: 413, body: { error: 'TOO_LARGE', message: 'That request is too large.' } });
          }
          chunks.push(buffer);
        }
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        } catch {
          return send({ status: 400, body: { error: 'MALFORMED', message: 'That request is not JSON.' } });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return send({ status: 400, body: { error: 'MALFORMED', message: 'That request is not an object.' } });
        }
      }
      send(await this.respond(method, url.pathname, request.headers.authorization, body));
    } catch (cause) {
      send({ status: 500, body: { error: 'INTERNAL', message: publicError(cause) } });
    }
  }
}

export const defaultNodeAgentPort = DEFAULT_NODE_AGENT_PORT;
