import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from '../privateState';
import { assertNodeScopes, type NodeControllerRecord, type NodeScope } from '../../api/nodeAgent';
import type { SecretProtector } from '../remote/pairingStore';

/**
 * Which controllers this box answers questions from.
 *
 * The primitives are the ones `remote/pairingStore.ts` established for phones, deliberately
 * unchanged: a 32-byte host secret sealed by the OS keyring, bearers persisted only as an
 * HMAC keyed by it, constant-time comparison, offers that live in memory and are consumed before
 * anything else can fail, and an atomic private write.
 *
 * It is a separate store rather than a reuse of that class because the thing being trusted is
 * different. A phone is a person holding an access ceiling over chat, files and approvals; a
 * controller here is another machine asking one read-only question. Sharing a file would also
 * mean revoking a phone and dropping a box were the same list, and that a malformed entry written
 * by one feature would refuse to load the other.
 */

interface StoredController extends NodeControllerRecord {
  tokenHash: string;
}

interface StoredTrust {
  version: 1;
  node: { id: string; name: string; createdAt: number; secretCiphertext: string };
  controllers: StoredController[];
}

interface OfferRecord {
  id: string;
  secretHash: string;
  expiresAt: number;
  scopes: NodeScope[];
}

export interface NodeOffer {
  id: string;
  /** One-time material. Never logged, never persisted, never reissued. */
  secret: string;
  nodeId: string;
  expiresAt: number;
  scopes: NodeScope[];
}

export interface NodeExchangeInput {
  offerId: string;
  secret: string;
  controllerName: string;
  clientVersion: string;
  requestedScopes: readonly string[];
}

export interface NodeExchangeResult {
  node: { id: string; name: string };
  controller: NodeControllerRecord;
  /** Returned exactly once. The agent keeps only a keyed hash of it. */
  credential: string;
}

export interface NodeTrustOptions {
  path: string;
  nodeName: string;
  protector: SecretProtector;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  offerTtlMs?: number;
  maxControllers?: number;
  touchIntervalMs?: number;
  writeFile?: (path: string, contents: string) => void;
}

const DEFAULT_OFFER_TTL_MS = 2 * 60_000;

const text = (value: unknown, limit: number, what: string): string => {
  if (typeof value !== 'string') throw new Error(`${what} must be text.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > limit) throw new Error(`${what} must contain 1 to ${limit} characters.`);
  return trimmed;
};

const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

const cloneController = (controller: StoredController): NodeControllerRecord => ({
  id: controller.id,
  name: controller.name,
  clientVersion: controller.clientVersion,
  scopes: [...controller.scopes],
  createdAt: controller.createdAt,
  lastSeenAt: controller.lastSeenAt,
  revokedAt: controller.revokedAt,
});

const clone = (state: StoredTrust): StoredTrust => ({
  version: 1,
  node: { ...state.node },
  controllers: state.controllers.map((controller) => ({ ...controller, scopes: [...controller.scopes] })),
});

function validController(value: unknown): value is StoredController {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredController>;
  let scopes: NodeScope[];
  try {
    scopes = assertNodeScopes(candidate.scopes);
  } catch {
    return false;
  }
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.clientVersion === 'string' &&
    scopes.length > 0 &&
    typeof candidate.createdAt === 'number' &&
    (candidate.lastSeenAt === null || typeof candidate.lastSeenAt === 'number') &&
    (candidate.revokedAt === null || typeof candidate.revokedAt === 'number') &&
    typeof candidate.tokenHash === 'string'
  );
}

export class NodeTrustStore {
  private readonly path: string;
  private readonly protector: SecretProtector;
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  private readonly offerTtlMs: number;
  private readonly maxControllers: number;
  private readonly touchIntervalMs: number;
  private readonly writeFile: (path: string, contents: string) => void;
  private readonly offers = new Map<string, OfferRecord>();
  private state: StoredTrust;
  private secret: Buffer;

  constructor(options: NodeTrustOptions) {
    const nodeName = text(options.nodeName, 80, 'A node name');
    this.path = options.path;
    this.protector = options.protector;
    this.now = options.now ?? Date.now;
    this.random = options.randomBytes ?? nodeRandomBytes;
    this.offerTtlMs = options.offerTtlMs ?? DEFAULT_OFFER_TTL_MS;
    this.maxControllers = options.maxControllers ?? 32;
    this.touchIntervalMs = options.touchIntervalMs ?? 60_000;
    this.writeFile = options.writeFile ?? writePrivateFileAtomic;

    const loaded = this.load();
    if (loaded) {
      this.state = loaded;
      this.secret = Buffer.from(this.protector.open(loaded.node.secretCiphertext), 'base64url');
      if (this.secret.length !== 32) throw new Error('This node agent identity is invalid.');
      if (loaded.node.name !== nodeName) {
        const next = clone(this.state);
        next.node.name = nodeName;
        this.commit(next);
      }
      return;
    }
    this.secret = this.entropy(32);
    this.state = {
      version: 1,
      node: {
        id: this.token(16),
        name: nodeName,
        createdAt: this.now(),
        secretCiphertext: this.protector.seal(this.secret.toString('base64url')),
      },
      controllers: [],
    };
    this.persist();
  }

  identity(): { id: string; name: string; createdAt: number } {
    const { id, name, createdAt } = this.state.node;
    return { id, name, createdAt };
  }

  listControllers(): NodeControllerRecord[] {
    return this.state.controllers.map(cloneController);
  }

  createOffer(scopes: readonly NodeScope[], ttlMs = this.offerTtlMs): NodeOffer {
    const granted = assertNodeScopes(scopes);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 30 * 60_000) {
      throw new Error('A pairing offer lives between one millisecond and thirty minutes.');
    }
    // One pairing surface per box. Replacing the offer must invalidate the previous one rather
    // than merely stop showing a code that is still written down somewhere.
    this.offers.clear();
    const id = this.token(16);
    const secret = this.token(32);
    const expiresAt = this.now() + ttlMs;
    this.offers.set(id, { id, secretHash: this.hash('node-offer', secret), expiresAt, scopes: granted });
    return { id, secret, nodeId: this.state.node.id, expiresAt, scopes: granted };
  }

  cancelOffer(offerId: string): boolean {
    this.dropExpired();
    return this.offers.delete(offerId);
  }

  /** In-memory pairing material must not survive the listener being stopped or disabled. */
  clearOffers(): number {
    const count = this.offers.size;
    this.offers.clear();
    return count;
  }

  exchange(input: NodeExchangeInput): NodeExchangeResult {
    this.dropExpired();
    const offer = this.offers.get(typeof input.offerId === 'string' ? input.offerId : '');
    const supplied = this.hash('node-offer', typeof input.secret === 'string' ? input.secret : '');
    if (!offer || offer.expiresAt <= this.now() || !safeEqual(offer.secretHash, supplied)) {
      throw new NodeTrustError('PAIRING_INVALID', 'This pairing offer is invalid or expired.', 401);
    }
    // Consume first. Two simultaneous exchanges must not mint two controllers even if the write
    // or the response that follows fails — and the code stays spent even when what follows is a
    // refusal, so a caller holding the secret cannot keep trying different asks against it.
    this.offers.delete(offer.id);

    const name = text(input.controllerName, 80, 'A controller name');
    const clientVersion = text(input.clientVersion, 40, 'A client version');
    const requested = new Set(assertNodeScopes(input.requestedScopes));
    const scopes = offer.scopes.filter((scope) => requested.has(scope));
    if (!scopes.length) throw new NodeTrustError('SCOPE_EMPTY', 'That pairing granted nothing.', 400);

    const active = this.state.controllers.filter((controller) => controller.revokedAt === null).length;
    if (active >= this.maxControllers) {
      throw new NodeTrustError('CONTROLLER_LIMIT', 'This node already trusts as many controllers as it will.', 409);
    }

    const id = this.token(16);
    const credential = this.token(32);
    const at = this.now();
    const controller: StoredController = {
      id,
      name,
      clientVersion,
      scopes,
      createdAt: at,
      lastSeenAt: at,
      revokedAt: null,
      tokenHash: this.hash(`controller:${id}`, credential),
    };
    const next = clone(this.state);
    next.controllers.push(controller);
    this.commit(next);
    return {
      node: { id: this.state.node.id, name: this.state.node.name },
      controller: cloneController(controller),
      credential: `${id}.${credential}`,
    };
  }

  authenticate(credential: unknown): NodeControllerRecord | null {
    if (typeof credential !== 'string') return null;
    const separator = credential.indexOf('.');
    if (separator <= 0 || separator === credential.length - 1) return null;
    const id = credential.slice(0, separator);
    const secret = credential.slice(separator + 1);
    const controller = this.state.controllers.find((entry) => entry.id === id);
    if (!controller || controller.revokedAt !== null) return null;
    if (!safeEqual(controller.tokenHash, this.hash(`controller:${id}`, secret))) return null;

    const at = this.now();
    if (controller.lastSeenAt === null || at - controller.lastSeenAt >= this.touchIntervalMs) {
      const next = clone(this.state);
      const updated = next.controllers.find((entry) => entry.id === id);
      if (!updated) throw new Error('An authenticated controller disappeared from node trust.');
      updated.lastSeenAt = at;
      this.commit(next);
      return cloneController(updated);
    }
    return cloneController(controller);
  }

  revoke(controllerId: unknown): boolean {
    const controller = this.state.controllers.find((entry) => entry.id === controllerId);
    if (!controller || controller.revokedAt !== null) return false;
    const next = clone(this.state);
    const updated = next.controllers.find((entry) => entry.id === controllerId);
    if (!updated) throw new Error('A controller disappeared from node trust.');
    updated.revokedAt = this.now();
    this.commit(next);
    return true;
  }

  private load(): StoredTrust | null {
    migratePrivateDirectory(dirname(this.path));
    if (!existsSync(this.path)) return null;
    const stats = lstatSync(this.path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Node trust state is not an owned file.');
    migratePrivateFile(this.path);
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredTrust>;
    if (
      parsed.version !== 1 ||
      !parsed.node ||
      typeof parsed.node.id !== 'string' ||
      typeof parsed.node.name !== 'string' ||
      typeof parsed.node.createdAt !== 'number' ||
      typeof parsed.node.secretCiphertext !== 'string' ||
      !Array.isArray(parsed.controllers) ||
      !parsed.controllers.every(validController)
    ) {
      // Refusing beats repairing. Rewriting this file would silently re-authorise or de-authorise
      // other machines, and the person who wrote whatever is here should see the error.
      throw new Error('Node trust state is invalid; refusing to replace the list of trusted machines.');
    }
    return parsed as StoredTrust;
  }

  private persist(state = this.state): void {
    this.writeFile(this.path, `${JSON.stringify(state, null, 2)}\n`);
  }

  private commit(next: StoredTrust): void {
    this.persist(next);
    this.state = next;
  }

  private entropy(size: number): Buffer {
    const value = this.random(size);
    if (!Buffer.isBuffer(value) || value.length !== size) throw new Error('Random source returned the wrong byte count.');
    return Buffer.from(value);
  }

  private token(size: number): string {
    return this.entropy(size).toString('base64url');
  }

  private hash(purpose: string, secret: string): string {
    return createHmac('sha256', this.secret).update(purpose).update('\0').update(secret).digest('base64url');
  }

  private dropExpired(): void {
    const at = this.now();
    for (const [id, offer] of this.offers) if (offer.expiresAt <= at) this.offers.delete(id);
  }
}

export class NodeTrustError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'NodeTrustError';
  }
}
