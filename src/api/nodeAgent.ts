/**
 * The inference-node agent: what one box tells another about itself.
 *
 * ADR 0001 stage 5. Stage 4 could only say whether a port accepted a connection, because
 * `recipes.peerAnswers` is a TCP connect and measures nothing. This is the protocol that answers
 * questions instead — free and total accelerator memory, and which prepared checkpoints the box
 * already holds — so the Distribution section of a workload can report capacity rather than
 * liveness alone.
 *
 * Two halves, both in this repository and both off by default:
 *
 * - The **agent** runs on a box with accelerators in it. It binds one chosen interface, holds a
 *   list of controllers it has been told to trust, and answers exactly two routes.
 * - The **controller** is the Antimatter window a person is sitting at. It holds a credential per
 *   paired node and polls their reports.
 *
 * Trust follows the device pairing already used for phones (`src/api/remoteIpc.ts`): the agent
 * mints a short-lived offer, the person carries its one-time code to the controller out of band,
 * and the exchange returns a bearer the agent stores only as a keyed hash. A paired controller is
 * revocable from the agent, which is the half that owns the machine being described.
 *
 * What an unauthenticated caller can learn is deliberately nothing beyond what a TCP connect
 * already revealed: `/v1/report` without a live credential is 401 with no body of substance, and
 * there is no route that enumerates anything before pairing. An agent that told whoever asked how
 * much memory it had and which checkpoints it held would be an inventory of a private machine
 * published on a LAN.
 */

/** Bumped only on a breaking change. A report whose protocol is unrecognised is not read. */
export const NODE_AGENT_PROTOCOL = 'antimatter-node-1';

/**
 * Deliberately not a URL and not a registered scheme, for the same reason the phone pairing code
 * is not: it carries a one-time bearer, and nothing but Antimatter should offer to open it.
 */
export const NODE_PAIRING_PREFIX = 'ANTIMATTER-NODE-V1?';

/** One past the Remote port, so a box can host both without a collision to discover at runtime. */
export const DEFAULT_NODE_AGENT_PORT = 43_129;

/**
 * What a controller is allowed to ask for.
 *
 * `inventory` is read-only and the only scope that exists. Accepting weight transfers and
 * starting engines are each a separate scope that this protocol version deliberately does not
 * define, so an agent built today cannot be talked into granting one by a newer controller: an
 * unknown scope is rejected at the exchange rather than stored for later interpretation.
 */
export const NODE_SCOPES = ['inventory'] as const;
export type NodeScope = (typeof NODE_SCOPES)[number];

export interface NodeAccelerator {
  name: string;
  /** Bytes. Null where the driver publishes no figure — never zero standing in for unknown. */
  memoryFree: number | null;
  memoryTotal: number | null;
}

/** A prepared checkpoint this box has on disk, verified by the download queue that fetched it. */
export interface NodeCheckpoint {
  id: string;
  name: string;
  bytes: number;
}

export interface NodeAgentReport {
  protocol: typeof NODE_AGENT_PROTOCOL;
  /** The agent's Antimatter version, so a controller can explain a shape it does not understand. */
  agentVersion: string;
  nodeId: string;
  name: string;
  accelerators: NodeAccelerator[];
  /** The sum across accelerators, or null when not one of them published a total. */
  memoryFree: number | null;
  memoryTotal: number | null;
  checkpoints: NodeCheckpoint[];
  /** The agent's clock when it took these readings. */
  observedAt: number;
}

/** A controller the agent has been told to trust. The agent owns this list and can revoke from it. */
export interface NodeControllerRecord {
  id: string;
  name: string;
  clientVersion: string;
  scopes: NodeScope[];
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export interface NodeAgentSettings {
  enabled: boolean;
  /** An exact local address. The agent never implicitly binds every interface. */
  address: string | null;
  port: number;
}

export interface NodeAgentStatus extends NodeAgentSettings {
  running: boolean;
  endpoint: string | null;
  certificatePin: string | null;
  interfaces: Array<{ name: string; address: string; family: 'IPv4' | 'IPv6'; internal: boolean }>;
  controllers: NodeControllerRecord[];
  error: string | null;
}

export interface NodePairingOfferView {
  id: string;
  endpoint: string;
  expiresAt: number;
  scopes: NodeScope[];
}

/** A box this controller has paired with. The credential itself never crosses into the renderer. */
export interface PairedNodeView {
  /** `host:port` — the same identity a workload stores and a recipe declares. */
  key: string;
  name: string;
  endpoint: string;
  nodeId: string;
  pairedAt: number;
  lastSeenAt: number | null;
  /** Why the last poll failed, in words a person can act on. Null after a success. */
  lastError: string | null;
}

export interface NodeAgentAPI {
  /** This box's agent: whether it is listening, on what, and who may ask it questions. */
  status(): Promise<NodeAgentStatus>;
  configure(patch: Partial<NodeAgentSettings>): Promise<NodeAgentStatus>;
  createPairingOffer(): Promise<NodePairingOfferView>;
  copyPairingCode(offerId: string): Promise<boolean>;
  cancelPairingOffer(offerId: string): Promise<boolean>;
  revokeController(controllerId: string): Promise<NodeAgentStatus>;
  /** The other half: boxes this one has paired with. */
  listPaired(): Promise<PairedNodeView[]>;
  pair(code: string): Promise<PairedNodeView>;
  forget(key: string): Promise<PairedNodeView[]>;
}

export const NODE_AGENT_IPC = {
  status: 'node-agent:status',
  configure: 'node-agent:configure',
  createPairingOffer: 'node-agent:pairing-offer',
  copyPairingCode: 'node-agent:pairing-copy',
  cancelPairingOffer: 'node-agent:pairing-cancel',
  revokeController: 'node-agent:controller-revoke',
  listPaired: 'node-agent:paired',
  pair: 'node-agent:pair',
  forget: 'node-agent:forget',
} as const;

export const NODE_AGENT_IPC_CHANNELS = Object.freeze(Object.values(NODE_AGENT_IPC));

/** Bytes a report may occupy. A box with a long inventory is still a small document. */
export const NODE_REPORT_LIMIT_BYTES = 256 * 1024;
/** How long a controller waits for a box before calling it unreachable. */
export const NODE_REQUEST_TIMEOUT_MS = 4_000;

export function assertNodeScopes(value: unknown): NodeScope[] {
  if (!Array.isArray(value) || !value.length) throw new Error('A pairing names at least one scope.');
  const scopes = [...new Set(value)];
  for (const scope of scopes) {
    // An unknown scope is refused, not ignored: a scope this version cannot enforce must never be
    // recorded as granted.
    if (typeof scope !== 'string' || !(NODE_SCOPES as readonly string[]).includes(scope)) {
      throw new Error('That pairing asks for something this node cannot grant.');
    }
  }
  return scopes as NodeScope[];
}

/** The pairing code a person carries from the agent to the controller, parsed and checked. */
export interface NodePairingCode {
  endpoint: string;
  nodeId: string;
  offerId: string;
  secret: string;
  certificatePin: string;
  expiresAt: number;
}

const ENDPOINT = /^https:\/\/(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[a-fA-F0-9:]+\]):([0-9]{1,5})$/;

export function parseNodePairingCode(value: unknown): NodePairingCode {
  const invalid = (): never => {
    throw new Error('That is not an Antimatter node pairing code. Copy it again from the other box.');
  };
  if (typeof value !== 'string') return invalid();
  const trimmed = value.trim();
  if (!trimmed.startsWith(NODE_PAIRING_PREFIX) || trimmed.length > 4_096) return invalid();
  const parameters = new URLSearchParams(trimmed.slice(NODE_PAIRING_PREFIX.length));
  const endpoint = parameters.get('endpoint') ?? '';
  const nodeId = parameters.get('node') ?? '';
  const offerId = parameters.get('offer') ?? '';
  const secret = parameters.get('secret') ?? '';
  const certificatePin = parameters.get('pin') ?? '';
  const expiresAt = Number(parameters.get('expires'));
  const port = Number(ENDPOINT.exec(endpoint)?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return invalid();
  if (!/^[A-Za-z0-9_-]{22}$/.test(nodeId) || !/^[A-Za-z0-9_-]{22}$/.test(offerId)) return invalid();
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return invalid();
  if (!/^sha256\/[A-Za-z0-9+/]{43}=$/.test(certificatePin)) return invalid();
  if (!Number.isFinite(expiresAt)) return invalid();
  return { endpoint, nodeId, offerId, secret, certificatePin, expiresAt };
}

/** `host:port` for an endpoint, which is the roster identity and the `--rpc` form. */
export function endpointKey(endpoint: string): string {
  return endpoint.replace(/^https:\/\//, '');
}
