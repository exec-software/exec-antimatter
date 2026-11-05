import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from '../privateState';
import { secureRemoteStorageAvailable } from '../remote/safeStorageProtector';

/**
 * The Vault: credentials the user holds and an agent may *use* without ever being shown.
 *
 * Two rules shape everything here, and they are the whole point of the feature:
 *
 *  1. A secret is sealed by the operating system's keyring and is never written in the clear.
 *     Unlike `sourceStore`, there is **no plaintext fallback**. An API key written in plain text
 *     is a tolerable degradation — the file is 0600 and the key is scoped to one service. A
 *     machine password is not: it is the key to the box, and often reused elsewhere. On a session
 *     with no real keyring the Vault refuses to store anything and says so, which is a worse
 *     product and a correct one.
 *
 *  2. The plaintext never leaves this process. It is not returned by any tool, does not cross IPC
 *     to the renderer, is not written into a transcript, and is not handed to the bundled MCP
 *     child. It reaches a command only as an environment variable on a shell this process spawns
 *     (see ./grants and src/main/terminal.ts).
 *
 * What the model gets instead is the *metadata*: a tag to name the credential by, who it is for,
 * and a note saying what it is. That is enough to pick the right one; the value itself is
 * delivered past the model rather than through it.
 */

export type VaultSecretKind = 'password' | 'token' | 'passphrase' | 'key';

const KINDS: readonly VaultSecretKind[] = ['password', 'token', 'passphrase', 'key'];

/** Everything about a credential except the credential. Safe to cross IPC and to show a model. */
export interface VaultEntrySummary {
  id: string;
  /** The handle a model names in `vault_use`. Lowercase, stable, unique: `sudo`, `github`. */
  tag: string;
  label: string;
  kind: VaultSecretKind;
  /** Not a secret: an account name is routinely printed by the very commands that need it. */
  username?: string;
  /** Free text shown to the model so it can tell two similar credentials apart. */
  notes?: string;
  /** The environment variable a granted secret arrives under, derived from the tag. */
  envName: string;
  createdAt: number;
  updatedAt: number;
  /** When a grant last handed this secret to a command. */
  usedAt?: number;
  useCount: number;
}

interface StoredEntry extends Omit<VaultEntrySummary, 'envName'> {
  /** base64 safeStorage blob. The only representation of the secret that ever touches disk. */
  cipher: string;
}

interface StoreFile {
  version: 1;
  /** Off until the user turns it on. A vault nobody asked for offers a model nothing. */
  enabled: boolean;
  entries: StoredEntry[];
}

const EMPTY: StoreFile = { version: 1, enabled: false, entries: [] };

/** Electron owns the real userData path; main sets it once at startup. */
let storePath = '';
let cache: StoreFile | null = null;

export const useStorePath = (path: string): void => {
  storePath = path;
  cache = null;
};

const file = (): string => storePath || join(app.getPath('userData'), 'vault.json');

/**
 * Whether the machine can keep a secret at all.
 *
 * Deliberately the strict check — Electron's Linux `basic_text` backend reports encryption as
 * available while protecting it with a key compiled into the binary, which for a machine password
 * is indistinguishable from plaintext.
 */
export const sealingAvailable = (): boolean => secureRemoteStorageAvailable(safeStorage);

const requireSealing = (): void => {
  if (!sealingAvailable()) {
    throw new Error(
      'The Vault needs an operating-system keyring (GNOME Keyring or KWallet) so secrets are never written in plain text. None is available on this session.'
    );
  }
};

/**
 * A tag is an identifier a model types, so it is narrow on purpose: one token, no spaces, no
 * case to get wrong, and nothing that could be mistaken for shell syntax when it is interpolated
 * into the name of an environment variable.
 */
export const normalizeTag = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** The variable a granted secret arrives under. Derived, never stored, so a rename cannot desync it. */
export const envNameFor = (tag: string): string => `ANTIMATTER_VAULT_${tag.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

const text = (value: unknown, limit: number): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim().slice(0, limit) : '';
  return trimmed || undefined;
};

const normalizeEntry = (value: unknown): StoredEntry | null => {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<StoredEntry>;
  const tag = normalizeTag(source.tag);
  const cipher = typeof source.cipher === 'string' ? source.cipher : '';
  if (!tag || !cipher) return null;
  return {
    id: typeof source.id === 'string' && source.id ? source.id : randomUUID(),
    tag,
    label: text(source.label, 120) ?? tag,
    kind: KINDS.includes(source.kind as VaultSecretKind) ? (source.kind as VaultSecretKind) : 'password',
    ...(text(source.username, 200) ? { username: text(source.username, 200) } : {}),
    ...(text(source.notes, 500) ? { notes: text(source.notes, 500) } : {}),
    createdAt: Number(source.createdAt) || Date.now(),
    updatedAt: Number(source.updatedAt) || Date.now(),
    ...(Number(source.usedAt) ? { usedAt: Number(source.usedAt) } : {}),
    useCount: Number.isFinite(Number(source.useCount)) ? Math.max(0, Math.trunc(Number(source.useCount))) : 0,
    cipher,
  };
};

const read = (): StoreFile => {
  if (cache) return cache;
  const path = file();
  const ownsDirectory = migratePrivateDirectory(dirname(path));
  if (!existsSync(path)) return (cache = { ...EMPTY, entries: [] });
  if (ownsDirectory) migratePrivateFile(path);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreFile> | null;
    if (parsed?.version !== 1) return (cache = { ...EMPTY, entries: [] });
    const entries = (Array.isArray(parsed.entries) ? parsed.entries : []).map(normalizeEntry).filter(
      (entry): entry is StoredEntry => entry !== null
    );
    // A duplicate tag would make `vault_use` ambiguous, which for a credential is worse than
    // losing one: the first wins, deterministically, rather than whichever the search found.
    const seen = new Set<string>();
    cache = {
      version: 1,
      enabled: parsed.enabled === true,
      entries: entries.filter((entry) => !seen.has(entry.tag) && seen.add(entry.tag)),
    };
  } catch (error) {
    // Never fall back to "empty but enabled": an unreadable vault must not look like one the
    // user emptied, and must not leave tools advertised that cannot resolve anything.
    console.error('[vault] unreadable store, treating the vault as off:', error);
    cache = { ...EMPTY, entries: [] };
  }
  return cache;
};

const write = (next: StoreFile): void => {
  writePrivateFileAtomic(file(), `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
};

const summary = (entry: StoredEntry): VaultEntrySummary => {
  const { cipher: _cipher, ...rest } = entry;
  return { ...rest, envName: envNameFor(entry.tag) };
};

export interface VaultStatus {
  enabled: boolean;
  /** False when no OS keyring is present; the Vault then cannot be turned on. */
  sealingAvailable: boolean;
  entries: VaultEntrySummary[];
  path: string;
}

export const status = (): VaultStatus => {
  const current = read();
  return {
    // A vault whose keyring vanished reports itself off rather than offering tools it cannot
    // unseal: the stored blobs are intact and come back when the keyring does.
    enabled: current.enabled && sealingAvailable(),
    sealingAvailable: sealingAvailable(),
    entries: current.entries.map(summary),
    path: file(),
  };
};

/**
 * Read on every tool-list build, so it reads the flag rather than assembling every summary.
 * A keyring that has gone away means off, exactly as `status` reports it.
 */
export const enabled = (): boolean => read().enabled && sealingAvailable();

export const setEnabled = (next: boolean): VaultStatus => {
  if (next) requireSealing();
  write({ ...read(), enabled: next === true });
  return status();
};

export interface VaultEntryInput {
  tag: string;
  label?: string;
  kind?: VaultSecretKind;
  username?: string;
  notes?: string;
  /** Required when creating; omitted on an edit that keeps the stored secret. */
  secret?: string;
}

/** Adds a credential, or updates the one with the same tag in place. */
export function save(input: VaultEntryInput): VaultStatus {
  requireSealing();
  const tag = normalizeTag(input.tag);
  if (!tag) throw new Error('A credential needs a tag: one word, like "sudo" or "github".');

  const current = read();
  const index = current.entries.findIndex((entry) => entry.tag === tag);
  const existing = index === -1 ? null : current.entries[index];
  const secret = typeof input.secret === 'string' ? input.secret : '';
  if (!existing && !secret) throw new Error('A new credential needs a secret.');
  if (secret.length > 4096) throw new Error('That secret is longer than the Vault stores (4096 characters).');

  const entry: StoredEntry = {
    id: existing?.id ?? randomUUID(),
    tag,
    label: text(input.label, 120) ?? existing?.label ?? tag,
    kind: KINDS.includes(input.kind as VaultSecretKind) ? (input.kind as VaultSecretKind) : existing?.kind ?? 'password',
    ...(text(input.username, 200) ? { username: text(input.username, 200)! } : {}),
    ...(text(input.notes, 500) ? { notes: text(input.notes, 500)! } : {}),
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    ...(existing?.usedAt ? { usedAt: existing.usedAt } : {}),
    useCount: existing?.useCount ?? 0,
    cipher: secret ? safeStorage.encryptString(secret).toString('base64') : existing!.cipher,
  };

  const entries =
    index === -1
      ? [...current.entries, entry]
      : [...current.entries.slice(0, index), entry, ...current.entries.slice(index + 1)];
  write({ ...current, entries });
  return status();
}

export function remove(tag: string): VaultStatus {
  const current = read();
  write({ ...current, entries: current.entries.filter((entry) => entry.tag !== normalizeTag(tag)) });
  return status();
}

export const find = (tag: string): VaultEntrySummary | null => {
  const entry = read().entries.find((candidate) => candidate.tag === normalizeTag(tag));
  return entry ? summary(entry) : null;
};

/**
 * Unseals one secret. **Main process only** — the one function in this module that returns
 * plaintext, called only by ./grants when arming a grant the user has just approved.
 */
export function unseal(tag: string): string {
  requireSealing();
  const entry = read().entries.find((candidate) => candidate.tag === normalizeTag(tag));
  if (!entry) throw new Error(`No credential in the Vault is tagged "${normalizeTag(tag)}".`);
  try {
    return safeStorage.decryptString(Buffer.from(entry.cipher, 'base64'));
  } catch (error) {
    console.error(`[vault] could not unseal ${entry.tag}:`, error);
    throw new Error(
      `The stored secret for "${entry.tag}" could not be unsealed. It was sealed by a keyring this session cannot reach; re-enter it in Settings.`
    );
  }
}

/** Records that a grant handed this secret to a command. The count is shown in Settings. */
export function recordUse(tag: string): void {
  const current = read();
  const index = current.entries.findIndex((entry) => entry.tag === normalizeTag(tag));
  if (index === -1) return;
  const entry = current.entries[index];
  const updated: StoredEntry = { ...entry, usedAt: Date.now(), useCount: entry.useCount + 1 };
  write({
    ...current,
    entries: [...current.entries.slice(0, index), updated, ...current.entries.slice(index + 1)],
  });
}

/** Drops the in-memory copy so the next read comes from disk. */
export const forget = (): void => {
  cache = null;
};
