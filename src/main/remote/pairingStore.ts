import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  migratePrivateDirectory,
  migratePrivateFile,
  writePrivateFileAtomic,
} from '../privateState';
import type { PairingExchangeInput, RemoteAccessMode, RemoteCapability } from './protocol';
import { RemoteProtocolError } from './protocol';

export interface SecretProtector {
  seal(plaintext: string): string;
  open(ciphertext: string): string;
}

export interface PublicHostIdentity {
  id: string;
  name: string;
  createdAt: number;
}

export interface PublicDeviceRecord {
  id: string;
  name: string;
  clientVersion: string;
  capabilities: RemoteCapability[];
  maxAccess: RemoteAccessMode;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

interface StoredDeviceRecord extends PublicDeviceRecord {
  tokenHash: string;
}

interface StoredPairingState {
  version: 1;
  host: PublicHostIdentity & { secretCiphertext: string };
  devices: StoredDeviceRecord[];
}

interface PairingOfferRecord {
  id: string;
  secretHash: string;
  expiresAt: number;
  capabilities: RemoteCapability[];
  maxAccess: RemoteAccessMode;
}

export interface PairingOffer {
  id: string;
  /** One-time material for the in-app scanner or explicit paste exchange. Never log or persist it. */
  secret: string;
  hostId: string;
  expiresAt: number;
  capabilities: RemoteCapability[];
  maxAccess: RemoteAccessMode;
}

export interface PairingResult {
  host: PublicHostIdentity;
  device: PublicDeviceRecord;
  /** Returned once. The host persists only a keyed hash. */
  credential: string;
}

export interface PairingStoreOptions {
  path: string;
  hostName: string;
  protector: SecretProtector;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  offerTtlMs?: number;
  maxOffers?: number;
  maxDevices?: number;
  touchIntervalMs?: number;
  /** Fault-injection seam. The default is the private atomic-file writer. */
  writeFile?: (path: string, contents: string) => void;
}

const CAPABILITIES = new Set<RemoteCapability>([
  'chat',
  'files',
  'previews',
  'terminal',
  'orchestrator',
  'approvals',
]);
const ACCESS = new Set<RemoteAccessMode>(['read', 'ask', 'full']);

const cloneDevice = (device: StoredDeviceRecord): PublicDeviceRecord => ({
  id: device.id,
  name: device.name,
  clientVersion: device.clientVersion,
  capabilities: [...device.capabilities],
  maxAccess: device.maxAccess,
  createdAt: device.createdAt,
  lastSeenAt: device.lastSeenAt,
  revokedAt: device.revokedAt,
});

const cloneState = (state: StoredPairingState): StoredPairingState => ({
  version: 1,
  host: { ...state.host },
  devices: state.devices.map((device) => ({
    ...device,
    capabilities: [...device.capabilities],
  })),
});

const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

function validDevice(value: unknown): value is StoredDeviceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredDeviceRecord>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.clientVersion === 'string' &&
    Array.isArray(candidate.capabilities) &&
    candidate.capabilities.every((entry) => CAPABILITIES.has(entry)) &&
    ACCESS.has(candidate.maxAccess as RemoteAccessMode) &&
    typeof candidate.createdAt === 'number' &&
    (candidate.lastSeenAt === null || typeof candidate.lastSeenAt === 'number') &&
    (candidate.revokedAt === null || typeof candidate.revokedAt === 'number') &&
    typeof candidate.tokenHash === 'string'
  );
}

export class PairingStore {
  private readonly path: string;
  private readonly protector: SecretProtector;
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly offerTtlMs: number;
  private readonly maxOffers: number;
  private readonly maxDevices: number;
  private readonly touchIntervalMs: number;
  private readonly writeFile: (path: string, contents: string) => void;
  private readonly offers = new Map<string, PairingOfferRecord>();
  private readonly offerConsumedListeners = new Set<(offerId: string) => void>();
  private readonly revokeListeners = new Set<(deviceId: string) => void>();
  private state: StoredPairingState;
  private hostSecret: Buffer;

  constructor(options: PairingStoreOptions) {
    const hostName = options.hostName.trim();
    if (!hostName || hostName.length > 80) throw new Error('hostName must contain at most 80 characters.');
    this.path = options.path;
    this.protector = options.protector;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.offerTtlMs = options.offerTtlMs ?? 5 * 60_000;
    this.maxOffers = options.maxOffers ?? 8;
    this.maxDevices = options.maxDevices ?? 64;
    this.touchIntervalMs = options.touchIntervalMs ?? 60_000;
    this.writeFile = options.writeFile ?? writePrivateFileAtomic;
    if (this.offerTtlMs <= 0 || this.maxOffers <= 0 || this.maxDevices <= 0) {
      throw new Error('Pairing store limits must be positive.');
    }

    const loaded = this.load();
    if (loaded) {
      this.state = loaded;
      const opened = this.protector.open(loaded.host.secretCiphertext);
      this.hostSecret = Buffer.from(opened, 'base64url');
      if (this.hostSecret.length !== 32) throw new Error('The remote host secret is invalid.');
      if (loaded.host.name !== hostName) {
        const next = cloneState(this.state);
        next.host.name = hostName;
        this.commit(next);
      }
    } else {
      this.hostSecret = this.entropy(32);
      const at = this.now();
      this.state = {
        version: 1,
        host: {
          id: this.token(16),
          name: hostName,
          createdAt: at,
          secretCiphertext: this.protector.seal(this.hostSecret.toString('base64url')),
        },
        devices: [],
      };
      this.persist();
    }
  }

  identity(): PublicHostIdentity {
    const { id, name, createdAt } = this.state.host;
    return { id, name, createdAt };
  }

  listDevices(includeRevoked = true): PublicDeviceRecord[] {
    return this.state.devices
      .filter((device) => includeRevoked || device.revokedAt === null)
      .map(cloneDevice);
  }

  activeDevice(deviceId: string): PublicDeviceRecord | null {
    const device = this.state.devices.find((entry) => entry.id === deviceId && entry.revokedAt === null);
    return device ? cloneDevice(device) : null;
  }

  createOffer(options: {
    capabilities: readonly RemoteCapability[];
    maxAccess: RemoteAccessMode;
    ttlMs?: number;
  }): PairingOffer {
    this.dropExpiredOffers();
    if (this.offers.size >= this.maxOffers) {
      throw new RemoteProtocolError('PAIRING_BUSY', 'Too many pairing offers are already active.', 429, true);
    }
    if (!ACCESS.has(options.maxAccess)) throw new Error('Unsupported access ceiling.');
    const capabilities = [...new Set(options.capabilities)];
    if (capabilities.some((entry) => !CAPABILITIES.has(entry))) throw new Error('Unsupported remote capability.');
    const ttlMs = options.ttlMs ?? this.offerTtlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 30 * 60_000) {
      throw new Error('Pairing offer lifetime must be between one millisecond and thirty minutes.');
    }
    const id = this.token(16);
    const secret = this.token(32);
    const expiresAt = this.now() + ttlMs;
    this.offers.set(id, {
      id,
      secretHash: this.hash('pairing-offer', secret),
      expiresAt,
      capabilities,
      maxAccess: options.maxAccess,
    });
    return {
      id,
      secret,
      hostId: this.state.host.id,
      expiresAt,
      capabilities: [...capabilities],
      maxAccess: options.maxAccess,
    };
  }

  /** In-memory pairing material must not survive a listener restart or disable. */
  clearOffers(): number {
    const count = this.offers.size;
    this.offers.clear();
    return count;
  }

  /** Invalidates one UI-owned offer without disturbing any future replacement offer. */
  cancelOffer(offerId: string): boolean {
    this.dropExpiredOffers();
    return this.offers.delete(offerId);
  }

  exchangeOffer(input: PairingExchangeInput & { secret: string }): PairingResult {
    this.dropExpiredOffers();
    const offer = this.offers.get(input.offerId);
    const suppliedHash = this.hash('pairing-offer', input.secret);
    if (!offer || offer.expiresAt <= this.now() || !safeEqual(offer.secretHash, suppliedHash)) {
      throw new RemoteProtocolError('PAIRING_OFFER_INVALID', 'This pairing offer is invalid or expired.', 401);
    }

    // Consume before any later operation. A simultaneous exchange cannot mint a second device,
    // even if persistence or response delivery subsequently fails.
    this.offers.delete(offer.id);
    for (const listener of this.offerConsumedListeners) {
      try {
        listener(offer.id);
      } catch {
        // Presentation cleanup is best-effort and cannot change pairing authority.
      }
    }
    const activeDevices = this.state.devices.filter((device) => device.revokedAt === null).length;
    if (activeDevices >= this.maxDevices) {
      throw new RemoteProtocolError('DEVICE_LIMIT', 'This host has reached its trusted-device limit.', 409);
    }

    const deviceId = this.token(16);
    const secret = this.token(32);
    const at = this.now();
    const requested = new Set(input.requestedCapabilities);
    const device: StoredDeviceRecord = {
      id: deviceId,
      name: input.deviceName,
      clientVersion: input.clientVersion,
      capabilities: offer.capabilities.filter((entry) => requested.has(entry)),
      maxAccess: offer.maxAccess,
      createdAt: at,
      lastSeenAt: at,
      revokedAt: null,
      tokenHash: this.hash(`device:${deviceId}`, secret),
    };
    const next = cloneState(this.state);
    next.devices.push(device);
    this.commit(next);
    return {
      host: this.identity(),
      device: cloneDevice(device),
      credential: `${deviceId}.${secret}`,
    };
  }

  authenticate(credential: string): PublicDeviceRecord | null {
    const separator = credential.indexOf('.');
    if (separator <= 0 || separator === credential.length - 1) return null;
    const deviceId = credential.slice(0, separator);
    const secret = credential.slice(separator + 1);
    const device = this.state.devices.find((entry) => entry.id === deviceId);
    if (!device || device.revokedAt !== null) return null;
    const supplied = this.hash(`device:${deviceId}`, secret);
    if (!safeEqual(device.tokenHash, supplied)) return null;

    const at = this.now();
    if (device.lastSeenAt === null || at - device.lastSeenAt >= this.touchIntervalMs) {
      const next = cloneState(this.state);
      const updated = next.devices.find((entry) => entry.id === deviceId);
      if (!updated) throw new Error('Authenticated device disappeared from pairing state.');
      updated.lastSeenAt = at;
      this.commit(next);
      return cloneDevice(updated);
    }
    return cloneDevice(device);
  }

  revoke(deviceId: string): boolean {
    const device = this.state.devices.find((entry) => entry.id === deviceId);
    if (!device || device.revokedAt !== null) return false;
    const next = cloneState(this.state);
    const updated = next.devices.find((entry) => entry.id === deviceId);
    if (!updated) throw new Error('Device disappeared from pairing state.');
    updated.revokedAt = this.now();
    this.commit(next);
    for (const listener of this.revokeListeners) listener(deviceId);
    return true;
  }

  onRevoked(listener: (deviceId: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  onOfferConsumed(listener: (offerId: string) => void): () => void {
    this.offerConsumedListeners.add(listener);
    return () => this.offerConsumedListeners.delete(listener);
  }

  private load(): StoredPairingState | null {
    const directory = dirname(this.path);
    migratePrivateDirectory(directory);
    if (!existsSync(this.path)) return null;
    const stats = lstatSync(this.path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Remote pairing state is not an owned file.');
    migratePrivateFile(this.path);
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredPairingState>;
    if (
      parsed.version !== 1 ||
      !parsed.host ||
      typeof parsed.host.id !== 'string' ||
      typeof parsed.host.name !== 'string' ||
      typeof parsed.host.createdAt !== 'number' ||
      typeof parsed.host.secretCiphertext !== 'string' ||
      !Array.isArray(parsed.devices) ||
      !parsed.devices.every(validDevice)
    ) {
      throw new Error('Remote pairing state is invalid; refusing to replace trusted-device identity.');
    }
    return parsed as StoredPairingState;
  }

  private persist(state = this.state): void {
    this.writeFile(this.path, `${JSON.stringify(state, null, 2)}\n`);
  }

  private commit(next: StoredPairingState): void {
    this.persist(next);
    this.state = next;
  }

  private entropy(size: number): Buffer {
    const value = this.randomBytes(size);
    if (!Buffer.isBuffer(value) || value.length !== size) throw new Error('Random source returned the wrong byte count.');
    return Buffer.from(value);
  }

  private token(size: number): string {
    return this.entropy(size).toString('base64url');
  }

  private hash(purpose: string, secret: string): string {
    return createHmac('sha256', this.hostSecret).update(purpose).update('\0').update(secret).digest('base64url');
  }

  private dropExpiredOffers(): void {
    const at = this.now();
    for (const [id, offer] of this.offers) {
      if (offer.expiresAt <= at) this.offers.delete(id);
    }
  }
}
