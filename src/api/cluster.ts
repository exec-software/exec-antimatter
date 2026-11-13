import { assertInferenceServerId, type InferenceServerId, type InferenceServerState } from './inferenceServers';
import type { NodeAgentReport, NodeScope, PairedNodeView } from './nodeAgent';

export interface ClusterVitals {
  observedAt: number;
  uptimeSeconds: number | null;
  cpuUsage: number | null;
  cpuCores: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  gpus: Array<{ name: string; usage: number | null; memoryUsed: number | null; memoryTotal: number | null; celsius: number | null; watts: number | null }>;
  disks: Array<{ total: number; used: number }>;
  networkRx: number | null;
  networkTx: number | null;
}

/** Deliberately excludes config paths, command lines, logs, and source credentials. */
export type ClusterEngine = Pick<InferenceServerState, 'id' | 'name' | 'running' | 'ready' | 'ownership' | 'busy' | 'startable'>;
export interface ClusterEngineAction {
  requestId: string;
  serverId: InferenceServerId;
  action: 'start' | 'stop' | 'restart';
  force: boolean;
}
export interface ClusterNode {
  key: string;
  name: string;
  local: boolean;
  scopes: NodeScope[];
  peer?: PairedNodeView;
  report: NodeAgentReport | null;
  vitals: ClusterVitals | null;
  engines: ClusterEngine[] | null;
  errors: { inventory?: string; vitals?: string; engines?: string };
  updatedAt: number;
}
export interface ClusterAuditEntry {
  at: number;
  node: string;
  action: ClusterEngineAction['action'];
  serverId: InferenceServerId;
  forced: boolean;
  outcome: 'succeeded' | 'failed';
}
export interface ClusterSnapshot { nodes: ClusterNode[]; actions: ClusterAuditEntry[]; observedAt: number }
export interface ClusterAPI {
  snapshot(): Promise<ClusterSnapshot>;
  action(node: string, action: ClusterEngineAction): Promise<ClusterEngine[]>;
}
export const CLUSTER_IPC = { snapshot: 'cluster:snapshot', action: 'cluster:action' } as const;

const number = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The node returned an invalid response.');
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';

export function parseClusterVitals(value: unknown): ClusterVitals {
  const input = object(value);
  if (number(input.observedAt) === null) throw new Error('The node did not timestamp its vitals.');
  return {
    observedAt: Number(input.observedAt), uptimeSeconds: number(input.uptimeSeconds), cpuUsage: number(input.cpuUsage, 1), cpuCores: number(input.cpuCores, 65536),
    memoryUsed: number(input.memoryUsed), memoryTotal: number(input.memoryTotal), networkRx: number(input.networkRx), networkTx: number(input.networkTx),
    gpus: (Array.isArray(input.gpus) ? input.gpus : []).slice(0, 64).map((value) => {
      const gpu = object(value);
      return { name: text(gpu.name, 120) || 'GPU', usage: number(gpu.usage, 1), memoryUsed: number(gpu.memoryUsed), memoryTotal: number(gpu.memoryTotal), celsius: number(gpu.celsius, 300), watts: number(gpu.watts, 100000) };
    }),
    disks: (Array.isArray(input.disks) ? input.disks : []).slice(0, 128).flatMap((value) => {
      const disk = object(value); const total = number(disk.total); const used = number(disk.used);
      return total !== null && used !== null && used <= total ? [{ total, used }] : [];
    }),
  };
}

export function parseClusterEngines(value: unknown): ClusterEngine[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error('The node returned an invalid engine list.');
  const result = value.map((value) => {
    const input = object(value);
    for (const field of ['running', 'ready', 'busy', 'startable']) if (typeof input[field] !== 'boolean') throw new Error('The node returned an invalid engine state.');
    if (input.ownership !== null && input.ownership !== 'app' && input.ownership !== 'external') throw new Error('The node returned an invalid engine owner.');
    return { id: assertInferenceServerId(input.id), name: text(input.name, 120), running: input.running as boolean, ready: input.ready as boolean,
      ownership: input.ownership as ClusterEngine['ownership'], busy: input.busy as boolean, startable: input.startable as boolean };
  });
  if (new Set(result.map((engine) => engine.id)).size !== result.length) throw new Error('The node returned duplicate engines.');
  return result;
}

export function assertClusterAction(value: unknown): ClusterEngineAction {
  const input = object(value);
  if (Object.keys(input).some((key) => !['requestId', 'serverId', 'action', 'force'].includes(key))) throw new Error('Unknown cluster action option.');
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId)) throw new Error('Invalid cluster request identifier.');
  if (!['start', 'stop', 'restart'].includes(String(input.action))) throw new Error('Choose start, stop, or restart.');
  if (typeof input.force !== 'boolean') throw new Error('Choose whether active work may be interrupted.');
  if (input.action === 'start' && input.force) throw new Error('A start action cannot interrupt active work.');
  return { requestId: input.requestId, serverId: assertInferenceServerId(input.serverId), action: input.action as ClusterEngineAction['action'], force: input.force };
}
