import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from './privateState';
import { applyLibraryOrder, reorderLibrary } from '../api/libraryOrder';

/**
 * The order someone dragged their models into.
 *
 * One list rather than a number on each model, for two reasons. The library mixes models from
 * several sources in one tree, so a per-model rank would mean writing to every source's catalog
 * to move one row — and a rank is a renumbering problem, where a list is just a list. The other
 * is that this is a view preference and not something about the model: a source refresh has no
 * business touching it, and keeping it out of the catalog means it cannot.
 *
 * Keys are `sourceId:modelId`. Anything absent sorts after everything present, which is what
 * makes a newly connected source appear at the end instead of silently in the middle, and what
 * lets the list survive a model going away and coming back.
 */

export interface LibraryOrder {
  /** `sourceId:modelId`, in the order they should appear. */
  order: string[];
}

interface StoreFile extends LibraryOrder {
  version: 1;
}

export const DEFAULT_LIBRARY_ORDER: LibraryOrder = { order: [] };

/** Keys reach a JSON array and the renderer, never a path, but stay bounded regardless. */
const KEY_LIMIT = 512;
/** A list longer than any plausible catalog is a bug or a loop, not a preference. */
const ORDER_LIMIT = 2_000;

export function normalizeLibraryOrder(value: unknown): LibraryOrder {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<LibraryOrder>;
  if (!Array.isArray(source.order)) return DEFAULT_LIBRARY_ORDER;
  const seen = new Set<string>();
  const order: string[] = [];
  for (const entry of source.order) {
    if (typeof entry !== 'string') continue;
    const key = entry.trim();
    // A duplicate key would make the sort depend on which copy was found first, so the first
    // mention wins and the rest are dropped.
    if (!key || key.length > KEY_LIMIT || seen.has(key)) continue;
    seen.add(key);
    order.push(key);
    if (order.length >= ORDER_LIMIT) break;
  }
  return { order };
}

let configPath = join(homedir(), '.antimatter', 'library-order.json');
let cache: LibraryOrder | null = null;

export const useConfigPath = (path: string): void => {
  configPath = path;
  cache = null;
};

export const location = (): string => configPath;

export function read(): LibraryOrder {
  if (cache) return cache;
  const ownsDirectory = migratePrivateDirectory(dirname(configPath));
  if (!existsSync(configPath)) return (cache = DEFAULT_LIBRARY_ORDER);
  if (ownsDirectory) migratePrivateFile(configPath);
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<StoreFile> | null;
    cache = parsed?.version === 1 ? normalizeLibraryOrder(parsed) : DEFAULT_LIBRARY_ORDER;
  } catch (error) {
    // An unreadable preference is no preference. The library still sorts, just by its defaults.
    console.error('[library] unreadable model order, using the default sort:', error);
    cache = DEFAULT_LIBRARY_ORDER;
  }
  return cache;
}

export function save(next: unknown): LibraryOrder {
  const settled = normalizeLibraryOrder(next);
  const file: StoreFile = { version: 1, ...settled };
  writePrivateFileAtomic(configPath, `${JSON.stringify(file, null, 2)}\n`);
  cache = settled;
  return settled;
}

// One implementation of the ordering rules, used by the renderer through `api` and re-exported
// here so a main-process caller does not reach across for them.
export { applyLibraryOrder, reorderLibrary };
