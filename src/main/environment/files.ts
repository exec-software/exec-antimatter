import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { nyModulePath } from './nyInspector';

/**
 * File access for the editor.
 *
 * Deliberately separate from the MCP file tools. Those are the model's, and they are gated by
 * the permission mode and the write guard, which is right: a model editing a directory nobody
 * chose is the accident those exist to prevent. This is the person's own editor, where opening
 * a file and saving it is the entire point and asking permission for it would be absurd.
 *
 * What it keeps from the tools is the one rule that is not about trust: nothing outside the root.
 * A path that escapes is a bug or a traversal attempt, and neither should be served.
 */

const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export interface Entry {
  name: string;
  /** Path relative to the root, with forward slashes — what the UI keys and sorts on. */
  path: string;
  kind: 'file' | 'directory';
  size: number;
  modified: number;
}

export interface FileContent {
  path: string;
  text: string;
  size: number;
  modified: number;
  /** True when the bytes are not text; the editor shows a notice rather than mojibake. */
  binary: boolean;
}

let root = '';

export const useRoot = (path: string): string => {
  root = resolve(path);
  return root;
};

export const location = (): string => root;

/** Resolves a workspace-relative path, refusing anything that climbs out of the root. */
export function within(candidate: string): string {
  if (!root) throw new Error('No environment directory is open.');
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Refused: "${candidate}" is outside ${root}.`);
  }
  return target;
}

/** The path the UI uses: relative to the root, forward slashes, '' for the root itself. */
const asRelative = (absolute: string): string => relative(root, absolute).split(sep).join('/');

/** Text files never contain NUL; binary files almost always do. */
const looksBinary = (text: string): boolean => text.includes(String.fromCharCode(0));

/**
 * One directory's children. The tree is loaded a level at a time rather than walked up front,
 * so a repository with a node_modules in it costs nothing until someone actually opens it.
 */
export function list(directory = ''): Entry[] {
  const target = within(directory);
  const entries = readdirSync(target, { withFileTypes: true });

  return entries
    .flatMap((entry) => {
      const full = join(target, entry.name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        return []; // a broken symlink, or something that vanished mid-listing
      }
      const kind = entry.isDirectory() ? ('directory' as const) : ('file' as const);
      if (!entry.isDirectory() && !entry.isFile()) return [];
      return [{ name: entry.name, path: asRelative(full), kind, size: stats.size, modified: stats.mtimeMs }];
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      // Dotfiles after their ordinary neighbours, then plain alphabetical.
      const dotted = Number(a.name.startsWith('.')) - Number(b.name.startsWith('.'));
      return dotted || a.name.localeCompare(b.name, undefined, { numeric: true });
    });
}

export function read(path: string): FileContent {
  if (/\.nil$/i.test(path)) {
    const module = nyModulePath(root, path);
    const stats = statSync(module);
    // NIL has a dedicated read-only inspector, including legacy textual artifacts.
    return { path: relative(realpathSync(root), module).split(sep).join('/'), text: '', size: stats.size, modified: stats.mtimeMs, binary: true };
  }
  const target = within(path);
  const stats = statSync(target);
  if (stats.size > MAX_TEXT_BYTES) {
    throw new Error(`${path} is ${(stats.size / 1024 / 1024).toFixed(1)} MB — too large to open.`);
  }

  const text = readFileSync(target, 'utf8');
  const binary = looksBinary(text);
  return {
    path: asRelative(target),
    text: binary ? '' : text,
    size: stats.size,
    modified: stats.mtimeMs,
    binary,
  };
}

export function write(path: string, text: string): FileContent {
  const target = within(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf8');
  const stats = statSync(target);
  return { path: asRelative(target), text, size: stats.size, modified: stats.mtimeMs, binary: false };
}

export function create(path: string, kind: 'file' | 'directory'): Entry {
  const target = within(path);
  if (existsSync(target)) throw new Error(`${path} already exists.`);

  if (kind === 'directory') {
    mkdirSync(target, { recursive: true });
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '', { flag: 'wx' });
  }

  const stats = statSync(target);
  return { name: target.split(sep).pop()!, path: asRelative(target), kind, size: stats.size, modified: stats.mtimeMs };
}

export function rename(from: string, to: string): Entry {
  const source = within(from);
  const destination = within(to);
  if (existsSync(destination)) throw new Error(`${to} already exists.`);
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(source, destination);

  const stats = statSync(destination);
  return {
    name: destination.split(sep).pop()!,
    path: asRelative(destination),
    kind: stats.isDirectory() ? 'directory' : 'file',
    size: stats.size,
    modified: stats.mtimeMs,
  };
}

/** Permanent. The UI confirms first; this does not second-guess a decision already taken. */
export function remove(path: string): void {
  const target = within(path);
  if (target === root) throw new Error('Refused: that is the environment directory itself.');
  rmSync(target, { recursive: true, force: true });
}

/** Whether a file on disk still matches what the editor last read, for save-over detection. */
export function unchangedSince(path: string, modified: number): boolean {
  try {
    return Math.abs(statSync(within(path)).mtimeMs - modified) < 1;
  } catch {
    return false;
  }
}
