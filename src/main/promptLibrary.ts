import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from './privateState';
import {
  EMPTY_PROMPT_LIBRARY,
  MAX_PROMPT_BODY_BYTES,
  MAX_PROMPT_ENTRIES,
  normalizePromptLibrary,
  removePromptEntry,
  upsertPromptEntry,
  type PromptEntryInput,
  type PromptLibrary,
} from '../api/promptLibrary';

/**
 * Where Prompt Studio keeps the prompts the person saved.
 *
 * One file per install, written whole and atomically. The validation, the ordering and the
 * revision all live in `src/api/promptLibrary.ts` so the renderer sees exactly what was stored;
 * everything here is the file.
 */

/** Electron owns the real userData path; main sets it once at startup. */
let configPath = join(homedir(), '.antimatter', 'prompt-library.json');
let cache: PromptLibrary | null = null;

export const useConfigPath = (path: string): void => {
  configPath = path;
  cache = null;
};

/** A file larger than the per-prompt ceiling allows is not one of ours; refuse to parse it. */
const MAX_FILE_BYTES = MAX_PROMPT_ENTRIES * (MAX_PROMPT_BODY_BYTES * 2 + 8192);

export function read(): PromptLibrary {
  if (cache) return cache;
  const ownsDirectory = migratePrivateDirectory(dirname(configPath));
  if (!existsSync(configPath)) return (cache = EMPTY_PROMPT_LIBRARY);
  if (ownsDirectory) migratePrivateFile(configPath);
  try {
    const contents = readFileSync(configPath, 'utf8');
    if (contents.length > MAX_FILE_BYTES) throw new Error('the saved prompt library is implausibly large');
    const parsed: unknown = JSON.parse(contents);
    const version = (parsed as { version?: unknown } | null)?.version;
    if (version !== 1) throw new Error(`unsupported prompt library version ${String(version)}`);
    cache = normalizePromptLibrary(parsed);
  } catch (error) {
    // Report rather than discard: the file is left alone, so a prompt lost to a bad read can
    // still be recovered by hand, and the next save is a conflict the renderer is told about.
    console.error('[prompt-library] unreadable library, starting empty:', error);
    cache = EMPTY_PROMPT_LIBRARY;
  }
  return cache;
}

function write(next: PromptLibrary): PromptLibrary {
  if (next === read()) return next;
  writePrivateFileAtomic(configPath, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`);
  cache = next;
  return next;
}

export const save = (entry: PromptEntryInput): PromptLibrary =>
  write(upsertPromptEntry(read(), entry, { now: Date.now, newId: randomUUID }));

export const remove = (id: unknown): PromptLibrary => write(removePromptEntry(read(), id));
