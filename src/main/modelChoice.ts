import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from './privateState';

/**
 * The model chat opens on: the one last picked, which is what a new conversation starts with and
 * what an unpinned agent answers on before anyone has sent a message.
 *
 * It used to live in the renderer's localStorage. Chromium keys that by origin, so `npm run dev`
 * on :5173, a second dev server that landed on :5174 and the built app on file:// each remembered
 * a different model, and the main process, which runs scheduled agents with no window open,
 * remembered none. Kept here, it is one choice per install, readable before any window exists.
 */

export interface ModelChoice {
  providerId: string;
  /** Empty when the source was picked before it listed any model. */
  modelId: string;
  /**
   * Which of the model's workloads this choice runs under, when one was picked deliberately.
   *
   * Absent means "whatever the model's default workload is", which is every choice made before
   * ADR 0001 and every choice made by picking a bare model. It is part of the selection rather
   * than a stored property of the model because launching a workload is a choice, not a setting:
   * the same model can be running `coding 32k` in one conversation's history and `image` in the
   * next, and neither should overwrite the other.
   */
  workloadId?: string;
}

interface StoreFile extends ModelChoice {
  version: 1;
}

/** Electron owns the real userData path; main sets it once at startup. */
let configPath = join(homedir(), '.antimatter', 'model.json');
/** Undefined until the file has been read; null once it is known there is no choice. */
let cache: ModelChoice | null | undefined;

export const useConfigPath = (path: string): void => {
  configPath = path;
  cache = undefined;
};

/** A choice with no source is no choice at all. */
const isChoice = (value: Partial<ModelChoice> | null | undefined): value is ModelChoice =>
  !!value && typeof value.providerId === 'string' && !!value.providerId && typeof value.modelId === 'string';

export function read(): ModelChoice | null {
  if (cache !== undefined) return cache;
  const ownsDirectory = migratePrivateDirectory(dirname(configPath));
  if (!existsSync(configPath)) return (cache = null);
  if (ownsDirectory) migratePrivateFile(configPath);
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<StoreFile> | null;
    cache = parsed?.version === 1 && isChoice(parsed) ? choice(parsed) : null;
  } catch (error) {
    console.error('[model] unreadable choice, starting without one:', error);
    cache = null;
  }
  return cache;
}

/** A workload id that survived validation, or nothing. Garbage degrades to the default. */
const workloadOf = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : undefined;

const choice = (value: ModelChoice): ModelChoice => {
  const workloadId = workloadOf(value.workloadId);
  return { providerId: value.providerId, modelId: value.modelId, ...(workloadId ? { workloadId } : {}) };
};

export function save(value: ModelChoice): ModelChoice {
  if (!isChoice(value)) throw new Error('A model choice needs the source it is on.');
  const next: StoreFile = { version: 1, ...choice(value) };
  writePrivateFileAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  cache = choice(next);
  return cache;
}

/** Forget a choice whose app-managed source can no longer be offered. */
export function clear(): void {
  rmSync(configPath, { force: true });
  cache = null;
}
