import { hostname } from 'node:os';
import { assertClusterAction, parseClusterEngines, parseClusterVitals, type ClusterAPI, type ClusterAuditEntry, type ClusterEngine, type ClusterEngineAction, type ClusterNode, type ClusterSnapshot, type ClusterVitals } from '../../api/cluster';
import type { NodeAgentReport, PairedNodeView } from '../../api/nodeAgent';
import { assertNodeKey } from '../../api/nodes';
import type { NodePeerStore } from '../nodeAgent/peers';
import { requestNodeEngineAction, requestNodeEngines, requestNodeVitals, requestReport } from '../nodeAgent/client';
import type { VitalsSnapshot } from '../vitals/types';

/** Share measured rates/capacity without process lists, paths, network names, or command lines. */
export function clusterVitals(snapshot: VitalsSnapshot): ClusterVitals {
  return parseClusterVitals({ observedAt: snapshot.at, uptimeSeconds: snapshot.host.uptimeSeconds, cpuUsage: snapshot.cpu.usage,
    cpuCores: snapshot.cpu.cores, memoryUsed: snapshot.memory.used, memoryTotal: snapshot.memory.total,
    gpus: snapshot.gpus, disks: snapshot.mounts.map(({ total, used }) => ({ total, used })),
    networkRx: snapshot.network.length ? snapshot.network.reduce((sum, network) => sum + network.rx, 0) : null,
    networkTx: snapshot.network.length ? snapshot.network.reduce((sum, network) => sum + network.tx, 0) : null });
}

export interface ClusterServiceOptions {
  peers: NodePeerStore;
  local: { name?: string; report(): Promise<NodeAgentReport>; vitals(): Promise<ClusterVitals>; engines(): Promise<ClusterEngine[]>; action(input: ClusterEngineAction): Promise<ClusterEngine[]> };
  remote?: { report: typeof requestReport; vitals: typeof requestNodeVitals; engines: typeof requestNodeEngines; action: typeof requestNodeEngineAction };
  now?: () => number;
}

/** Uses only stored pinned endpoints, never a URL supplied with a management action. */
export class ClusterService implements ClusterAPI {
  private snapshotInFlight: Promise<ClusterSnapshot> | null = null;
  private cached: ClusterSnapshot | null = null;
  private readonly actions: ClusterAuditEntry[] = [];
  private readonly now: () => number;
  private readonly remote: NonNullable<ClusterServiceOptions['remote']>;
  private readonly pendingNodes = new Set<string>();
  private readonly requests = new Map<string, { fingerprint: string; at: number; pending: boolean; result: Promise<ClusterEngine[]> }>();
  constructor(private readonly options: ClusterServiceOptions) {
    this.now = options.now ?? Date.now;
    this.remote = options.remote ?? { report: requestReport, vitals: requestNodeVitals, engines: requestNodeEngines, action: requestNodeEngineAction };
  }

  snapshot(): Promise<ClusterSnapshot> {
    if (this.snapshotInFlight) return this.snapshotInFlight;
    if (this.cached && this.now() - this.cached.observedAt < 1000) return Promise.resolve(structuredClone(this.cached));
    this.snapshotInFlight = this.read().then((snapshot) => { this.cached = snapshot; return structuredClone(snapshot); })
      .finally(() => { this.snapshotInFlight = null; });
    return this.snapshotInFlight;
  }

  async action(node: string, raw: ClusterEngineAction): Promise<ClusterEngine[]> {
    const input = assertClusterAction(raw);
    if (node !== 'local') assertNodeKey(node);
    const key = `${node}:${input.requestId}`; const fingerprint = JSON.stringify(input);
    for (const [id, request] of this.requests) if (!request.pending && this.now() - request.at > 10 * 60_000) this.requests.delete(id);
    const previous = this.requests.get(key);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('This request identifier was used for another action.'); return previous.result; }
    if (this.requests.size >= 256) throw new Error('Too many recent engine requests. Try again later.');
    const result = this.performAction(node, input).finally(() => { const request = this.requests.get(key); if (request) request.pending = false; });
    this.requests.set(key, { fingerprint, at: this.now(), result, pending: true });
    return result;
  }

  private async performAction(node: string, input: ClusterEngineAction): Promise<ClusterEngine[]> {
    if (this.pendingNodes.has(node)) throw new Error('An engine action is already running on this node.');
    this.pendingNodes.add(node);
    let outcome: ClusterAuditEntry['outcome'] = 'failed';
    try {
      let result: ClusterEngine[];
      if (node === 'local') result = await this.options.local.action(input);
      else {
        const peer = this.options.peers.list().find((peer) => peer.key === node);
        if (!peer || !peer.scopes?.includes('manage-engines')) throw new Error('Pair this node again and explicitly allow engine control.');
        const target = this.options.peers.target(node);
        if (!target) throw new Error('This node is no longer paired.');
        try { result = await this.remote.action(target, target.credential, input); }
        catch { throw new Error('The node could not complete this action. Refresh its status before retrying; check its local logs if it is online.'); }
      }
      const engines = parseClusterEngines(result);
      outcome = 'succeeded';
      return engines;
    } finally {
      this.pendingNodes.delete(node); this.cached = null;
      this.actions.unshift({ at: this.now(), node, action: input.action, serverId: input.serverId, forced: input.force, outcome });
      this.actions.splice(100);
    }
  }

  private async read(): Promise<ClusterSnapshot> {
    const local: ClusterNode = { key: 'local', name: this.options.local.name ?? hostname(), local: true, scopes: ['inventory', 'vitals', 'manage-engines'], report: null, vitals: null, engines: null, errors: {}, updatedAt: this.now() };
    await Promise.all([
      this.options.local.report().then((report) => { local.report = report; }).catch(() => { local.errors.inventory = 'Inventory could not be read.'; }),
      this.options.local.vitals().then((vitals) => { local.vitals = parseClusterVitals(vitals); }).catch(() => { local.errors.vitals = 'Vitals could not be read.'; }),
      this.options.local.engines().then((engines) => { local.engines = parseClusterEngines(engines); }).catch(() => { local.errors.engines = 'Engines could not be read.'; }),
    ]);
    const peers = this.options.peers.list();
    const nodes = new Array<ClusterNode>(peers.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, peers.length) }, async () => {
      while (cursor < peers.length) { const index = cursor++; nodes[index] = await this.readPeer(peers[index]); }
    }));
    return { nodes: [local, ...nodes], actions: [...this.actions], observedAt: this.now() };
  }

  private async readPeer(peer: PairedNodeView): Promise<ClusterNode> {
    const scopes = peer.scopes ?? ['inventory'];
    const node: ClusterNode = { key: peer.key, name: peer.name, local: false, scopes, peer, report: null, vitals: null, engines: null, errors: {}, updatedAt: this.now() };
    try {
      const target = this.options.peers.target(peer.key);
      if (!target) throw new Error('The node is no longer paired.');
      await Promise.all([
        ...(scopes.includes('inventory') ? [this.remote.report(target, target.credential).then((report) => {
          if (report.nodeId !== peer.nodeId) throw new Error('Node identity changed.');
          node.report = report;
        }).catch(() => { node.errors.inventory = 'Inventory unavailable. Check the node, certificate, and pairing.'; })] : []),
        ...(scopes.includes('vitals') ? [this.remote.vitals(target, target.credential).then((vitals) => { node.vitals = parseClusterVitals(vitals); })
          .catch(() => { node.errors.vitals = 'Vitals unavailable. Check the node and its pairing permissions.'; })] : []),
        ...(scopes.includes('manage-engines') ? [this.remote.engines(target, target.credential).then((engines) => { node.engines = parseClusterEngines(engines); })
          .catch(() => { node.errors.engines = 'Engine controls unavailable. Check the node and its pairing permissions.'; })] : []),
      ]);
      if (Object.keys(node.errors).length) this.options.peers.fail(peer.key, Object.values(node.errors).join(' '));
      else this.options.peers.touch(peer.key);
    } catch { node.errors.inventory = 'This node could not be contacted.'; }
    return node;
  }
}
