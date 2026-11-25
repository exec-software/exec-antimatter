import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, opendirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFileAtomic } from './privateState';
import {
  emptyLayout,
  isUniverseId,
  normalizeLayout,
  normalizeManifest,
  type UniverseLayout,
  type UniverseManifest,
} from '../api/universes';
import { BUILT_IN_UNIVERSES, GENERATOR_SPECS } from '../api/universeCatalog';
import {
  canonicalGrant,
  normalizeGrant,
  resolveEntitlement,
  type Entitlement,
  type LicenceGrant,
} from '../api/universeLicences';
import { bindingProblem, emptyBinding, normalizeBinding, type GeneratorBinding } from '../api/generators';

/**
 * The universe registry: which workbenches exist on this machine, and whether they open.
 *
 * Three kinds of state, kept apart on purpose:
 *
 * - **Manifests** describe a universe. Built-ins are compiled in; expansions are read from their
 *   own directory. Replacing an expansion replaces its manifest and nothing else.
 * - **Layouts** are how the person arranged that workbench. They survive an expansion update,
 *   which is why they are not in the manifest's directory.
 * - **Grants** are licences. Separate again, because reinstalling an expansion must not lose the
 *   licence for it and removing a licence must not touch the work.
 *
 * Everything lives outside any project workspace. A universe is not a project artefact: nothing
 * here should turn up in a diff.
 */

let root = join(homedir(), '.antimatter', 'universes');

export const useRoot = (path: string): void => {
  root = path;
};

export const location = (): string => root;

const layoutsDir = () => join(root, 'layouts');
const licencesDir = () => join(root, 'licences');
const expansionsDir = () => join(root, 'expansions');
const bindingsPath = () => join(root, 'generators.json');

/** A universe id reaches a file name, so anything that could walk out of the directory is refused. */
export function assertUniverseId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!isUniverseId(id)) throw new Error('Invalid universe id.');
  return id;
}

/**
 * The public keys expansion licences are signed against.
 *
 * Compiled in, never fetched, never read from a file beside the grant: a key that travels with
 * the thing it authorises is not a check. The table is empty while every universe ships
 * included — there is nothing to verify yet, and a key published before it is needed is a key
 * that has to be rotated before it is used. Adding the first paid expansion means adding its
 * key here and shipping a release, which is the intended ceremony.
 */
const SIGNING_KEYS: Record<string, string> = {};

let signingKeys: Record<string, string> = SIGNING_KEYS;

/** Test seam. Production never calls this; the keys it ships with are the keys it trusts. */
export const useSigningKeys = (keys: Record<string, string>): void => {
  signingKeys = keys;
  keyCache.clear();
};

const keyCache = new Map<string, KeyObject | null>();

function publicKey(keyId: string): KeyObject | null {
  if (keyCache.has(keyId)) return keyCache.get(keyId) ?? null;
  const encoded = signingKeys[keyId];
  let key: KeyObject | null = null;
  if (encoded) {
    try {
      key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
    } catch (error) {
      // A key we cannot parse is a build mistake, not a licence problem; it must never be
      // reported as the person's licence being invalid, so it is logged here and once.
      console.error(`[universes] signing key ${keyId} could not be parsed:`, error);
      key = null;
    }
  }
  keyCache.set(keyId, key);
  return key;
}

/**
 * Check a grant's signature.
 *
 * Ed25519 over the canonical payload. An unknown key id fails closed: an expansion signed by
 * something this release has never heard of is not something this release can vouch for.
 */
export function verifyGrant(payload: string, signature: string, keyId: string): boolean {
  const key = publicKey(keyId);
  if (!key) return false;
  try {
    return verifySignature(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Installed expansions, read from disk.
 *
 * One directory per expansion holding a `universe.json`. A directory whose manifest does not
 * parse is skipped with a log rather than failing the list: one broken expansion must not cost
 * someone their other universes, and the built-ins must survive anything in here.
 */
function installed(): UniverseManifest[] {
  const directory = expansionsDir();
  if (!existsSync(directory)) return [];
  const manifests: UniverseManifest[] = [];
  let handle;
  try {
    handle = opendirSync(directory);
  } catch {
    return [];
  }
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      if (!isUniverseId(entry.name)) continue;
      const file = join(directory, entry.name, 'universe.json');
      if (!existsSync(file)) continue;
      try {
        const manifest = normalizeManifest(JSON.parse(readFileSync(file, 'utf8')));
        // An expansion whose manifest claims a different id than its directory could shadow
        // another universe, so the directory wins and a mismatch is refused outright.
        if (manifest && manifest.id === entry.name) manifests.push(manifest);
        else console.error(`[universes] ${entry.name} has a manifest that does not match its directory; skipped.`);
      } catch (error) {
        console.error(`[universes] could not read the manifest for ${entry.name}:`, error);
      }
      if (manifests.length >= 64) break;
    }
  } finally {
    handle.closeSync();
  }
  return manifests;
}

/** Every universe this machine has, built-ins first. A built-in can never be shadowed. */
export function manifests(): UniverseManifest[] {
  const seen = new Set(BUILT_IN_UNIVERSES.map((manifest) => manifest.id));
  return [...BUILT_IN_UNIVERSES, ...installed().filter((manifest) => !seen.has(manifest.id))];
}

export function manifest(universeId: string): UniverseManifest | null {
  const id = assertUniverseId(universeId);
  return manifests().find((entry) => entry.id === id) ?? null;
}

export const expansionRoot = (universeId: string): string | null => {
  const id = assertUniverseId(universeId);
  if (BUILT_IN_UNIVERSES.some((entry) => entry.id === id)) return null;
  const directory = join(expansionsDir(), id);
  return existsSync(directory) ? directory : null;
};

// ---------------------------------------------------------------------------- layouts

export function readLayout(universeId: string): UniverseLayout {
  const id = assertUniverseId(universeId);
  const file = join(layoutsDir(), `${id}.json`);
  if (!existsSync(file)) return emptyLayout(id);
  try {
    return normalizeLayout(JSON.parse(readFileSync(file, 'utf8')), id);
  } catch (error) {
    // An unreadable layout is the default layout, not a broken page. The file is left alone.
    console.error(`[universes] unreadable layout for ${id}, using the default:`, error);
    return emptyLayout(id);
  }
}

export function saveLayout(universeId: string, layout: unknown): UniverseLayout {
  const id = assertUniverseId(universeId);
  const settled = { ...normalizeLayout(layout, id), updatedAt: new Date().toISOString() };
  mkdirSync(layoutsDir(), { recursive: true });
  writePrivateFileAtomic(join(layoutsDir(), `${id}.json`), `${JSON.stringify(settled, null, 2)}\n`);
  return settled;
}

/**
 * Merge a patch into the stored layout.
 *
 * Read, merge, write, in main: the workbench sends a region change while a drag is settling a
 * size, and two renderer-side whole-layout writes would each lose the other's.
 */
export function patchLayout(universeId: string, patch: unknown): UniverseLayout {
  const id = assertUniverseId(universeId);
  const current = readLayout(id);
  const incoming = normalizeLayout(patch, id);
  const source = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  return saveLayout(id, {
    ...current,
    // Each field is merged only when the patch actually carried it: `normalizeLayout` fills in
    // empty objects for everything, so merging unconditionally would clear the rest on any patch.
    regions: 'regions' in source ? { ...current.regions, ...incoming.regions } : current.regions,
    open: 'open' in source ? { ...current.open, ...incoming.open } : current.open,
    sizes: 'sizes' in source ? { ...current.sizes, ...incoming.sizes } : current.sizes,
    stageId: 'stageId' in source ? incoming.stageId : current.stageId,
    documentId: 'documentId' in source ? incoming.documentId : current.documentId,
    atoma: 'atoma' in source ? incoming.atoma : current.atoma,
  });
}

// ---------------------------------------------------------------------------- licences

export function readGrant(universeId: string): LicenceGrant | null {
  const id = assertUniverseId(universeId);
  const file = join(licencesDir(), `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return normalizeGrant(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Install a licence from the text the person was sent.
 *
 * Verified before it is stored, and the verdict is returned either way. Storing an invalid grant
 * would turn one bad paste into a universe that stays shut with no way to tell why from the
 * file name — and an invalid grant on disk is indistinguishable from a tampered one.
 */
export function installGrant(text: unknown): Entitlement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof text === 'string' ? text : '');
  } catch {
    throw new Error('That does not look like a licence file. Paste the whole thing, including the braces.');
  }
  const grant = normalizeGrant(parsed);
  if (!grant) throw new Error('That licence is missing fields Antimatter needs. Ask whoever issued it for a fresh copy.');
  const target = manifest(grant.universeId);
  if (!target) throw new Error(`This licence is for "${grant.universeId}", which is not installed.`);
  const entitlement = resolveEntitlement(
    target.id,
    // Checked as `licensed` whatever the manifest says: a grant for an included universe should
    // still be told it is invalid rather than quietly accepted because the universe was free.
    'licensed',
    grant,
    verifyGrant,
    Date.now(),
    target.release
  );
  if (entitlement.state === 'invalid') throw new Error(entitlement.reason);
  mkdirSync(licencesDir(), { recursive: true });
  writePrivateFileAtomic(join(licencesDir(), `${target.id}.json`), `${JSON.stringify(grant, null, 2)}\n`);
  return entitlementFor(target);
}

export function removeGrant(universeId: string): Entitlement {
  const id = assertUniverseId(universeId);
  rmSync(join(licencesDir(), `${id}.json`), { force: true });
  const target = manifest(id);
  if (!target) throw new Error('That universe is not installed.');
  return entitlementFor(target);
}

export function entitlementFor(target: UniverseManifest): Entitlement {
  return resolveEntitlement(
    target.id,
    target.entitlement,
    target.entitlement === 'licensed' ? readGrant(target.id) : null,
    verifyGrant,
    Date.now(),
    target.release
  );
}

/** Every universe's entitlement, for the licence manager. */
export const entitlements = (): Entitlement[] => manifests().map(entitlementFor);

/**
 * Whether a universe may be worked in, as a throw.
 *
 * The one place entitlement is enforced. Every IPC handler that touches a universe's documents
 * calls this first, so there is no state in which a panel is open against a universe whose
 * licence has lapsed.
 */
export function assertOpen(universeId: string): UniverseManifest {
  const target = manifest(assertUniverseId(universeId));
  if (!target) throw new Error('That universe is not installed.');
  const entitlement = entitlementFor(target);
  if (entitlement.state !== 'granted') throw new Error(entitlement.reason);
  return target;
}

// ---------------------------------------------------------------------------- generators

interface BindingStore {
  version: 1;
  bindings: Record<string, GeneratorBinding>;
}

function readBindings(): BindingStore {
  const file = bindingsPath();
  if (!existsSync(file)) return { version: 1, bindings: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const source = (parsed && typeof parsed === 'object' ? parsed : {}) as { bindings?: unknown };
    const stored = (source.bindings && typeof source.bindings === 'object' ? source.bindings : {}) as Record<string, unknown>;
    const bindings: Record<string, GeneratorBinding> = {};
    for (const spec of GENERATOR_SPECS) {
      if (spec.id in stored) bindings[spec.id] = normalizeBinding(stored[spec.id], spec.id);
    }
    return { version: 1, bindings };
  } catch (error) {
    console.error('[universes] unreadable generator bindings, treating them as unset:', error);
    return { version: 1, bindings: {} };
  }
}

export interface GeneratorView {
  spec: typeof GENERATOR_SPECS[number];
  binding: GeneratorBinding;
  /** Why it cannot be used right now, or null. */
  problem: string | null;
}

export function generators(): GeneratorView[] {
  const store = readBindings();
  return GENERATOR_SPECS.map((spec) => {
    const binding = store.bindings[spec.id] ?? emptyBinding(spec.id);
    return { spec, binding, problem: bindingProblem(spec, binding) };
  });
}

export function bindGenerator(generatorId: unknown, patch: unknown): GeneratorView[] {
  const id = typeof generatorId === 'string' ? generatorId : '';
  const spec = GENERATOR_SPECS.find((entry) => entry.id === id);
  if (!spec) throw new Error('That generator is not one this release knows about.');
  const store = readBindings();
  const current = store.bindings[spec.id] ?? emptyBinding(spec.id);
  const source = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  store.bindings[spec.id] = normalizeBinding({ ...current, ...source }, spec.id);
  mkdirSync(root, { recursive: true });
  writePrivateFileAtomic(bindingsPath(), `${JSON.stringify(store, null, 2)}\n`);
  return generators();
}

/** The binding for one generator, for the job runner. */
export function binding(generatorId: string): GeneratorBinding | undefined {
  return readBindings().bindings[generatorId];
}

export { canonicalGrant };
