import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from '../privateState';
import { assertNodeKey } from '../../api/nodes';
import { assertNodeScopes, endpointKey, type NodeScope, type PairedNodeView } from '../../api/nodeAgent';
import type { SecretProtector } from '../remote/pairingStore';
import type { NodeTarget } from './client';

/**
 * The boxes this controller has paired with.
 *
 * Keyed by `host:port`, which is the roster identity stage 4 already uses and the form
 * `--rpc` takes, so a workload's recorded boxes and a paired node are the same string. The
 * bearer is sealed by the OS keyring and never leaves the main process: `list()` returns a view
 * without it, because a credential has no business in a renderer that renders untrusted text.
 *
 * Pairing is per box, not per model. A box that goes quiet keeps its entry — forgetting it is an
 * explicit act, since the alternative is a roster that empties itself whenever a machine is
 * rebooted.
 */

interface StoredPeer {
  scopes?: NodeScope[];
  key: string;
  name: string;
  nodeId: string;
  endpoint: string;
  certificatePin: string;
  credentialCipher: string;
  pairedAt: number;
  lastSeenAt: number | null;
}

interface StoredPeers {
  version: 1;
  peers: StoredPeer[];
}

const EMPTY: StoredPeers = { version: 1, peers: [] };

const MAX_PEERS = 32;

function validPeer(value: unknown): value is StoredPeer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const peer = value as Partial<StoredPeer>;
  if (typeof peer.key !== 'string') return false;
  try {
    assertNodeKey(peer.key);
    if (peer.scopes !== undefined) assertNodeScopes(peer.scopes);
  } catch {
    return false;
  }
  return (
    typeof peer.name === 'string' &&
    typeof peer.nodeId === 'string' &&
    typeof peer.endpoint === 'string' &&
    typeof peer.certificatePin === 'string' &&
    typeof peer.credentialCipher === 'string' &&
    typeof peer.pairedAt === 'number' &&
    (peer.lastSeenAt === null || typeof peer.lastSeenAt === 'number')
  );
}

export interface PeerStoreOptions {
  path: string;
  protector: SecretProtector;
  now?: () => number;
  writeFile?: (path: string, contents: string) => void;
}

export class NodePeerStore {
  private readonly path: string;
  private readonly protector: SecretProtector;
  private readonly now: () => number;
  private readonly writeFile: (path: string, contents: string) => void;
  /** Why the last poll failed. Not persisted: it describes this session, not the pairing. */
  private readonly failures = new Map<string, string>();
  private state: StoredPeers;

  constructor(options: PeerStoreOptions) {
    this.path = options.path;
    this.protector = options.protector;
    this.now = options.now ?? Date.now;
    this.writeFile = options.writeFile ?? writePrivateFileAtomic;
    this.state = this.load();
  }

  list(): PairedNodeView[] {
    return this.state.peers.map((peer) => ({
      key: peer.key,
      scopes: [...(peer.scopes ?? ['inventory'])],
      name: peer.name,
      endpoint: peer.endpoint,
      nodeId: peer.nodeId,
      pairedAt: peer.pairedAt,
      lastSeenAt: peer.lastSeenAt,
      lastError: this.failures.get(peer.key) ?? null,
    }));
  }

  keys(): string[] {
    return this.state.peers.map((peer) => peer.key);
  }

  /** Endpoint, pin and the opened bearer. Main-process only, by construction. */
  target(key: string): (NodeTarget & { credential: string; name: string }) | null {
    const peer = this.state.peers.find((entry) => entry.key === key);
    if (!peer) return null;
    return {
      endpoint: peer.endpoint,
      certificatePin: peer.certificatePin,
      credential: this.protector.open(peer.credentialCipher),
      name: peer.name,
    };
  }

  remember(input: {
    endpoint: string;
    certificatePin: string;
    nodeId: string;
    name: string;
    credential: string;
    scopes?: NodeScope[];
  }): PairedNodeView {
    const key = assertNodeKey(endpointKey(input.endpoint));
    const peer: StoredPeer = {
      key,
      scopes: assertNodeScopes(input.scopes ?? ['inventory']),
      name: input.name.trim().slice(0, 80) || key,
      nodeId: input.nodeId,
      endpoint: input.endpoint,
      certificatePin: input.certificatePin,
      credentialCipher: this.protector.seal(input.credential),
      pairedAt: this.now(),
      lastSeenAt: null,
    };
    // Re-pairing the same box replaces its credential rather than accumulating entries: the old
    // bearer remains revocable on the agent; replacing this entry never expands its grant.
    const peers = this.state.peers.filter((entry) => entry.key !== key);
    if (peers.length >= MAX_PEERS) throw new Error(`This controller already holds ${MAX_PEERS} paired boxes.`);
    peers.push(peer);
    this.commit({ version: 1, peers });
    this.failures.delete(key);
    return this.list().find((entry) => entry.key === key)!;
  }

  forget(key: unknown): PairedNodeView[] {
    const peers = this.state.peers.filter((entry) => entry.key !== key);
    if (peers.length !== this.state.peers.length) this.commit({ version: 1, peers });
    if (typeof key === 'string') this.failures.delete(key);
    return this.list();
  }

  /** Records a successful poll. Throttled, because a roster refresh should not be a disk write. */
  touch(key: string, touchIntervalMs = 60_000): void {
    this.failures.delete(key);
    const peer = this.state.peers.find((entry) => entry.key === key);
    if (!peer) return;
    const at = this.now();
    if (peer.lastSeenAt !== null && at - peer.lastSeenAt < touchIntervalMs) return;
    this.commit({
      version: 1,
      peers: this.state.peers.map((entry) => (entry.key === key ? { ...entry, lastSeenAt: at } : entry)),
    });
  }

  fail(key: string, cause: unknown): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.failures.set(key, message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'That box did not answer.');
  }

  private load(): StoredPeers {
    const ownsDirectory = migratePrivateDirectory(dirname(this.path));
    if (!existsSync(this.path)) return EMPTY;
    const stats = lstatSync(this.path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Paired node state is not an owned file.');
    if (ownsDirectory) migratePrivateFile(this.path);
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredPeers>;
      if (parsed.version !== 1 || !Array.isArray(parsed.peers)) return EMPTY;
      // One bad entry drops itself. Unlike the agent's own trust list, nothing here authorises
      // anything: losing a pairing costs a re-pair, and refusing to load would cost the roster.
      return { version: 1, peers: parsed.peers.filter(validPeer) };
    } catch (error) {
      console.error('[node-agent] paired boxes unreadable; starting with none:', error);
      return EMPTY;
    }
  }

  private commit(next: StoredPeers): void {
    this.writeFile(this.path, `${JSON.stringify(next, null, 2)}\n`);
    this.state = next;
  }
}
