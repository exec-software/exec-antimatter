import type { NodeCheckpoint } from './nodeAgent';

/**
 * The boxes this installation knows about, as something the UI can list.
 *
 * ADR 0001 stage 4. These are not a new store: they are the peers already declared in the
 * recipes under `~/.antimatter/recipes/*.yaml`, which exist because a model that does not fit on
 * one machine is the same request with a precondition. Recipes already carry a host, a port, an
 * optional command to bring a peer up, and the probe that says whether it is answering — so the
 * roster is read from there rather than duplicated beside it.
 *
 * A node key is `host:port`, which is what llama.cpp's `--rpc` takes and what a recipe declares.
 * It is the identity a workload stores, so a workload survives a recipe being renamed.
 */
export interface InferenceNode {
  /** `host:port`. Stable, and the same string the runtime would be given. */
  key: string;
  /** What the recipe calls this machine. */
  name: string;
  host: string;
  port: number;
  /** Whether the port accepted a connection on the last probe. */
  reachable: boolean;
  /** When that probe ran. Null when it has not been probed in this session. */
  probedAt: number | null;
  /** Whether a recipe knows how to start this peer when it is down. */
  startable: boolean;
  /** Recipe names that declare this peer, so a person can see what it is for. */
  recipes: string[];
  /** Model ids those recipes apply to. */
  models: string[];
  /** True for the machine Antimatter is running on, which needs no recipe to exist. */
  local: boolean;
  /**
   * Free and total accelerator memory in bytes, when known.
   *
   * Populated for the local box from the driver, and for a remote one from a paired node agent
   * (ADR 0001 stage 5). It stays `null` for a box with no agent on it, because `peerAnswers` is a
   * TCP connect: it proves a port is open and says nothing whatever about capacity, and a figure
   * derived from that would be a number nobody measured.
   */
  memoryFree: number | null;
  memoryTotal: number | null;
  /**
   * Where those two figures came from, so the UI never has to imply a provenance it does not
   * have. `null` means they are unknown, which is not the same as zero.
   */
  capacityFrom: 'driver' | 'agent' | null;
  /** Whether a node agent on this machine is paired with this controller. */
  paired: boolean;
  /** Prepared checkpoints the box reports holding. Empty when nothing has said. */
  checkpoints: NodeCheckpoint[];
  /** Why the last report failed, when one was attempted and did not arrive. */
  agentError: string | null;
}

export interface NodesAPI {
  /** Probes every declared peer. Slow by nature: each unreachable one waits out its timeout. */
  list(): Promise<InferenceNode[]>;
  /** Where the recipes that declare these peers live. */
  storeInfo(): Promise<{ path: string }>;
}

/** `host:port`, validated the same way a preset's RPC target is. */
export function assertNodeKey(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A node is a host:port address.');
  const split = value.lastIndexOf(':');
  const host = value.slice(0, split);
  const port = Number(value.slice(split + 1));
  const named = /^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[a-fA-F0-9:]+\])$/.test(host);
  if (split < 1 || !named || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('A node is a host:port address.');
  }
  return value;
}

export const nodeKey = (host: string, port: number): string => `${host}:${port}`;
