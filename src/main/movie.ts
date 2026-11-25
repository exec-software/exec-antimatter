import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFileAtomic } from './privateState';
import { location as universesRoot } from './universes';
import {
  applyProductionEdits,
  emptyProduction,
  normalizeProduction,
  summarizeProduction,
  type Production,
  type ProductionEdit,
  type ProductionSummary,
} from '../api/movie';

export type { ProductionSummary } from '../api/movie';

/**
 * Productions, one JSON document each.
 *
 * Under the Movie universe's own root rather than in a workspace, because a film is not a
 * project artefact and nothing here should turn up in a diff. Assets live beside the documents,
 * one directory per production, so deleting a production takes its renders with it — tens of
 * gigabytes of takes that outlive the thing they belonged to is the worst kind of litter.
 *
 * Read-modify-write in main for the same reason the whiteboard does it: a render finishing and a
 * person dragging a shot are two writers, and two renderer-side whole-document writes would each
 * lose the other's.
 */

const movieRoot = () => join(universesRoot(), 'movie');
const documentsDir = () => join(movieRoot(), 'productions');

/** Where a production's own media lives. Public, because the generator queue writes into it. */
export const assetsDir = (productionId: string): string => join(movieRoot(), 'assets', assertProductionId(productionId));

/** A production id reaches a file name and a directory name, so it is strict. */
export function assertProductionId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid production id.');
  return id;
}

const pathFor = (productionId: string): string => join(documentsDir(), `${productionId}.json`);

export function list(): ProductionSummary[] {
  const directory = documentsDir();
  if (!existsSync(directory)) return [];
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const summaries: ProductionSummary[] = [];
  for (const name of names.slice(0, 500)) {
    const id = name.slice(0, -'.json'.length);
    try {
      assertProductionId(id);
      summaries.push(summarizeProduction(read(id)));
    } catch {
      // A document nobody can read is left out of the list rather than breaking it.
    }
  }
  // Most recently worked on first: the list is how you get back to what you were doing.
  return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function read(productionId: string): Production {
  const id = assertProductionId(productionId);
  const file = pathFor(id);
  if (!existsSync(file)) return emptyProduction(id, '');
  try {
    return normalizeProduction(JSON.parse(readFileSync(file, 'utf8')), id);
  } catch (error) {
    // The file is left alone: overwriting it would destroy the only copy of whatever was
    // salvageable by hand, and a production is weeks of someone's work.
    console.error(`[movie] unreadable production ${id}, showing an empty one:`, error);
    return emptyProduction(id, '');
  }
}

export function save(productionId: string, production: unknown): Production {
  const id = assertProductionId(productionId);
  const settled = normalizeProduction(production, id);
  mkdirSync(documentsDir(), { recursive: true });
  writePrivateFileAtomic(pathFor(id), `${JSON.stringify(settled, null, 2)}\n`);
  return settled;
}

export function create(title: unknown): Production {
  const id = `prod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const production = emptyProduction(id, typeof title === 'string' ? title.trim() : '');
  mkdirSync(assetsDir(id), { recursive: true });
  return save(id, production);
}

export function edit(productionId: string, edits: readonly ProductionEdit[]): Production {
  const id = assertProductionId(productionId);
  const next = applyProductionEdits(read(id), edits);
  return save(id, next);
}

/**
 * Delete a production and everything it owns.
 *
 * Its assets go with it. That is the dangerous half of this function, and it is why the caller
 * is expected to have asked first: there is no second copy of a render.
 */
export function remove(productionId: string): void {
  const id = assertProductionId(productionId);
  rmSync(pathFor(id), { force: true });
  rmSync(assetsDir(id), { recursive: true, force: true });
}

/** Bytes a production's assets occupy, for the page that offers to delete it. */
export function assetBytes(productionId: string): number {
  const directory = assetsDir(productionId);
  if (!existsSync(directory)) return 0;
  let total = 0;
  const walk = (path: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Symbolic links are not followed: a production's size must not be another disk's size.
      if (entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child, depth + 1);
      else if (entry.isFile()) {
        try {
          total += statSync(child).size;
        } catch {
          // A file that vanished mid-walk contributes nothing rather than failing the total.
        }
      }
    }
  };
  walk(directory, 0);
  return total;
}
