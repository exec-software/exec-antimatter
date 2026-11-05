import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { CHARS_PER_TOKEN } from '../context';
import { repositoryTop } from './store';

/**
 * A project's own instructions: the AGENTS.md (or CLAUDE.md) its people wrote for anyone working
 * in it.
 *
 * These are not notes Antimatter keeps. They are checked in, they are the same for every tool and
 * every person, and several of the repositories Antimatter works in already have one — saying
 * which machine a benchmark runs on, which version scheme a commit follows, which service must
 * never be stopped. A model that never reads them breaks those rules on its first turn.
 *
 * AGENTS.md is the shared convention and wins. CLAUDE.md is read only in a directory without one,
 * because where both exist the CLAUDE.md is usually a single line pointing at the AGENTS.md.
 *
 * Read from the top of the repository down to the workspace, each directory's file after its
 * parent's, so the most specific instructions come last. Outside a repository only the workspace
 * itself is read: a directory above it is not something anyone chose to work in.
 */

export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

/** Codex stops at 32 KiB of project instructions by default; this matches it. */
export const MAX_INSTRUCTION_CHARS = 32 * 1024;
/** Enough for the rules at the top of a file, however small the window. */
const MIN_INSTRUCTION_CHARS = 2 * 1024;

/**
 * How much of a prompt the instructions may take: a quarter of what it has room for, up to the
 * 32 KiB above. A 17 KB AGENTS.md is nothing to a 262k window, and a third of a 32k one's prompt.
 *
 * In whole KiB, because a conversation keeps its context only while this stays the same (see
 * context.ts), and the budget it comes from moves a little whenever the offered tools do.
 */
export const instructionAllowance = (budgetTokens: number): number => {
  const quarter = Math.floor((budgetTokens * 0.25 * CHARS_PER_TOKEN) / 1024) * 1024;
  return Math.min(MAX_INSTRUCTION_CHARS, Math.max(MIN_INSTRUCTION_CHARS, quarter));
};
/** Read no more of any one file than could possibly be kept. */
const READ_LIMIT_BYTES = MAX_INSTRUCTION_CHARS * 4;

export interface InstructionFile {
  /** Absolute path. */
  path: string;
  /** Relative to the top of the repository, or the file name outside one. */
  label: string;
  /** What is read into the prompt: the whole file, unless the allowance ran out part way. */
  content: string;
  /** The whole file's length in characters (in bytes, for one too big to read at all). */
  length: number;
}

const canonical = (path: string): string => {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
};

/** A regular file's text, up to `limit` bytes, or null when there is no such file. */
function readText(path: string, limit: number): { text: string; size: number; complete: boolean } | null {
  let size: number;
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return null;
    size = stats.size;
  } catch {
    return null;
  }
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, limit));
    const read = readSync(descriptor, buffer, 0, buffer.length, 0);
    // A cut can land inside a multi-byte character; decoding replaces the stray bytes, harmlessly.
    const text = buffer.subarray(0, read).toString('utf8').replace(/^﻿/, '');
    return { text, size, complete: size <= limit };
  } finally {
    closeSync(descriptor);
  }
}

/** The directories whose instructions apply to a workspace, outermost first. */
function directoriesFrom(start: string, top: string | null): string[] {
  if (!top) return [start];
  const chain: string[] = [];
  for (let cursor = start; ; cursor = dirname(cursor)) {
    chain.unshift(cursor);
    if (cursor === top || dirname(cursor) === cursor) break;
  }
  return chain;
}

/**
 * The instruction files for a workspace, fitted to `allowance` characters between them.
 *
 * The allowance is spent outermost first, as Codex spends it. The file that crosses it is cut,
 * and any after that are still listed with nothing read, so the model can be told they exist.
 */
export function instructionFiles(workspace: string, allowance = MAX_INSTRUCTION_CHARS): InstructionFile[] {
  const start = canonical(workspace);
  const top = repositoryTop(start);
  const files: InstructionFile[] = [];
  let remaining = allowance;

  for (const directory of directoriesFrom(start, top)) {
    for (const name of INSTRUCTION_FILES) {
      const path = join(directory, name);
      const read = readText(path, READ_LIMIT_BYTES);
      const text = read?.text.replace(/\r\n/g, '\n').trim();
      // An empty file says nothing, so a CLAUDE.md beside an empty AGENTS.md still gets its turn.
      if (!read || !text) continue;
      const content = text.slice(0, Math.max(0, remaining));
      remaining -= content.length;
      files.push({
        path,
        label: relative(top ?? start, path) || name,
        content,
        length: read.complete ? text.length : read.size,
      });
      break;
    }
  }
  return files;
}
