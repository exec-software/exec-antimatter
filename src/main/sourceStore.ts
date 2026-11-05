import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, unwatchFile, watchFile, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Model, ProviderConfig, ProviderKind } from '../api/types';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from './privateState';
import { secureRemoteStorageAvailable } from './remote/safeStorageProtector';
import { modelDeployment } from '../api/modelDeployment';
import * as recipes from './recipes';

/**
 * Product/connector identity. The actual request schema is `protocol`, not this label.
 *
 * A stored source always has one; `ProviderConfig` leaves it optional because a config can also
 * be assembled in-process, and the request path must not assume a kind it was never given.
 */
export type SourceKind = ProviderKind;

export interface InferenceSource extends ProviderConfig {
  kind: SourceKind;
  createdAt: number;
}

/** Safe to cross IPC. The stored/decrypted credential itself never leaves the main process. */
export interface PublicInferenceSource extends Omit<InferenceSource, 'apiKey'> {
  credentialConfigured: boolean;
}

interface StoredSource extends Omit<InferenceSource, 'apiKey'> {
  /** base64 safeStorage blob, used only when the OS provides a real keyring backend. */
  apiKeyCipher?: string;
  /** Plain fallback for machines with no keyring; recorded so the UI can warn. */
  apiKeyPlain?: string;
}

interface StoreFile {
  version: 1;
  sources: StoredSource[];
}

const EMPTY: StoreFile = { version: 1, sources: [] };
let cache: StoreFile | null = null;

const storePath = () => join(app.getPath('userData'), 'sources.json');

const encryptKey = (apiKey: string): Pick<StoredSource, 'apiKeyCipher' | 'apiKeyPlain'> => {
  if (!apiKey) return {};
  if (secureRemoteStorageAvailable(safeStorage)) {
    return { apiKeyCipher: safeStorage.encryptString(apiKey).toString('base64') };
  }
  return { apiKeyPlain: apiKey };
};

const decryptKey = (stored: StoredSource): string => {
  if (stored.apiKeyCipher) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.apiKeyCipher, 'base64'));
    } catch (error) {
      console.error('[sources] could not decrypt a stored API key:', error);
      return '';
    }
  }
  return stored.apiKeyPlain ?? '';
};

const read = (): StoreFile => {
  if (cache) return cache;
  const file = storePath();
  const ownsDirectory = migratePrivateDirectory(dirname(file));
  if (!existsSync(file)) {
    cache = { ...EMPTY, sources: [] };
    return cache;
  }
  if (ownsDirectory) migratePrivateFile(file);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoreFile;
    cache = parsed?.version === 1 && Array.isArray(parsed.sources) ? parsed : { ...EMPTY, sources: [] };
  } catch (error) {
    console.error('[sources] unreadable store, starting empty:', error);
    cache = { ...EMPTY, sources: [] };
  }
  return cache;
};

const write = (next: StoreFile) => {
  const file = storePath();
  writePrivateFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
};

const toSource = (stored: StoredSource): InferenceSource => {
  const { apiKeyCipher: _cipher, apiKeyPlain: _plain, ...rest } = stored;
  return { ...rest, apiKey: decryptKey(stored) };
};

const publicModel = (model: Model): Model => ({
  id: model.id,
  name: model.name,
  ...(model.architecture !== undefined ? { architecture: model.architecture } : {}),
  ...(model.quantization !== undefined ? { quantization: model.quantization } : {}),
  ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
  ...(model.maxEvaluatedTokens !== undefined ? { maxEvaluatedTokens: model.maxEvaluatedTokens } : {}),
  ...(model.vision !== undefined ? { vision: model.vision } : {}),
  ...(model.manuallyDeclared !== undefined ? { manuallyDeclared: model.manuallyDeclared } : {}),
  ...(model.deployment !== undefined ? { deployment: model.deployment } : {}),
  ...(model.hidden !== undefined ? { hidden: model.hidden } : {}),
});

/**
 * Legacy stores accepted arbitrary endpoint strings. Keep the main-process endpoint intact for
 * compatibility, but never let credentials smuggled through URL userinfo, query, or fragment
 * fields cross IPC into the renderer.
 */
const publicEndpoint = (baseUrl: string): string => {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
};

/** Allowlist fields rather than deleting known secrets: malformed/legacy extras cannot cross IPC. */
const publicFields = (
  source: Omit<InferenceSource, 'apiKey'>,
  credentialConfigured: boolean
): PublicInferenceSource => {
  const configuredRecipes = recipes.list();
  return {
    id: source.id,
    name: source.name,
    baseUrl: publicEndpoint(source.baseUrl),
    models: source.models.map((model) => ({
      ...publicModel(model),
      deployment: modelDeployment(source, model, !!recipes.forModel(model.id, configuredRecipes)),
    })),
    supportsStreaming: source.supportsStreaming,
    ...(source.protocol !== undefined ? { protocol: source.protocol } : {}),
    kind: source.kind,
    createdAt: source.createdAt,
    credentialConfigured,
  };
};

const storedPublicSource = (stored: StoredSource): PublicInferenceSource =>
  publicFields(stored, !!(stored.apiKeyCipher || stored.apiKeyPlain));

export const publicSource = (source: InferenceSource): PublicInferenceSource =>
  publicFields(source, !!source.apiKey);

const toStored = (source: InferenceSource): StoredSource => {
  const { apiKey, ...rest } = source;
  return { ...rest, ...encryptKey(apiKey ?? '') };
};

export const list = (): InferenceSource[] => read().sources.map(toSource);

/** Lists sources without decrypting or serializing their credentials. */
export const listPublic = (): PublicInferenceSource[] => read().sources.map(storedPublicSource);

/** Main-process-only lookup for operations that need the stored credential. */
export const find = (id: string): InferenceSource | null => {
  const stored = read().sources.find((source) => source.id === id);
  return stored ? toSource(stored) : null;
};

/**
 * Adds a source, or replaces the one with the same id in place.
 *
 * Replacing in place matters beyond cosmetics: filtering and appending moved a source to the
 * end of the list every time its models were refreshed, and anything treating the first source
 * as the default — the orchestrator's provider fallback — silently changed which one that was.
 */
export const save = (source: InferenceSource): InferenceSource => {
  const current = read();
  const stored = toStored(source);
  const index = current.sources.findIndex((entry) => entry.id === source.id);
  const sources =
    index === -1
      ? [...current.sources, stored]
      : [...current.sources.slice(0, index), stored, ...current.sources.slice(index + 1)];

  write({ ...current, sources });
  return source;
};

/** Replaces only a source's credential, preserving its identity, catalog, and profile bindings. */
export const replaceCredential = (id: string, apiKey: string): InferenceSource | null => {
  const current = read();
  const index = current.sources.findIndex((entry) => entry.id === id);
  if (index === -1) return null;

  const existing = current.sources[index];
  const { apiKeyCipher: _cipher, apiKeyPlain: _plain, ...rest } = existing;
  const replacement: StoredSource = { ...rest, ...encryptKey(apiKey) };
  const sources = [
    ...current.sources.slice(0, index),
    replacement,
    ...current.sources.slice(index + 1),
  ];
  write({ ...current, sources });
  // The validated plaintext is still available in main. Decrypting the blob we just wrote adds
  // a needless keyring failure point that can leave disk updated while the live provider receives
  // an empty credential; the normal read path will verify decryption on the next process start.
  return { ...rest, apiKey };
};

export const remove = (id: string) => {
  const current = read();
  write({ ...current, sources: current.sources.filter((entry) => entry.id !== id) });
};

export const storeLocation = () => storePath();

/** Drops the in-memory copy so the next read comes from disk. */
export const forget = (): void => {
  cache = null;
};

/**
 * How often to look for a store somebody else wrote.
 *
 * `watchFile` polls a path rather than subscribing to an inode. The store is written atomically
 * through a rename, so the inode is replaced on every write; `fs.watch` was measured to survive
 * that on Linux, but its behaviour across platforms and editors is notoriously uneven and it
 * reports nothing at all about what changed. Polling is dull and identical everywhere, and the
 * cost is one `stat` of a small file. Two seconds is far below the rate anyone edits sources.
 */
const WATCH_INTERVAL_MS = 2_000;

/**
 * Notices a store written by something other than this process, and returns a stop function.
 *
 * Until this existed, the store was read exactly once per launch and cached forever, so a source
 * added by anything but the Settings page — a provisioning script, a stack installed from the hub,
 * an edit by hand — stayed invisible until the app was restarted, with no indication that the file
 * and the picker disagreed.
 *
 * Only additions and edits propagate. The provider manager is told about the sources now on disk;
 * it is not told to forget one that vanished, because a half-written or briefly-truncated file
 * would then silently disconnect a working source. Removal stays a deliberate act in Settings.
 */
export function watchStore(onChanged: () => void, intervalMs = WATCH_INTERVAL_MS): () => void {
  const file = storePath();
  const listener = (current: Stats, previous: Stats) => {
    // watchFile fires on every poll; only a real change is worth a reload. A file that does not
    // exist reports mtimeMs 0, so creating one later still registers as a change.
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
    cache = null;
    onChanged();
  };
  watchFile(file, { interval: intervalMs }, listener);
  return () => unwatchFile(file, listener);
}

/**
 * Whether every configured key is currently stored with keyring-grade encryption.
 * Linux basic_text deliberately reports false, and a plaintext fallback remains visible as such
 * even if a secure keyring becomes available later.
 */
export const keysAreEncrypted = () =>
  secureRemoteStorageAvailable(safeStorage) &&
  read().sources.every((source) => source.apiKeyPlain === undefined);
