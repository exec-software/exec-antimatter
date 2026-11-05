import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_RESOURCE_BYTES = 256 * 1024;
export const MAX_RESOURCE_FILES = 256;
const MAX_WALK_ENTRIES = 1024;

export function canonicalDirectory(path: string): string {
  const root = realpathSync(path);
  const stats = lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('The selected extension folder is not a directory.');
  return root;
}

/** Reject symlink components as well as lexical traversal: declarations do not grant disk access. */
export function resourcePath(root: string, resource: string): string {
  if (!resource || resource.length > 2048 || isAbsolute(resource) || resource.includes('\\') || resource.split('/').some((part) => !part || part === '..' || part === '.')) {
    throw new Error('Use a relative resource path inside the skill or plugin folder.');
  }
  if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) throw new Error('The extension folder changed location. Review it again.');
  const target = resolve(root, resource);
  const rel = relative(root, target);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('The resource is outside its extension folder.');
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('Extension resources cannot follow symbolic links.');
  }
  return target;
}

export function readResource(root: string, resource: string): string {
  const path = resourcePath(root, resource);
  const expected = lstatSync(path);
  if (!expected.isFile() || expected.size > MAX_RESOURCE_BYTES) throw new Error(`Extension resources must be text files no larger than ${MAX_RESOURCE_BYTES / 1024} KB.`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.ino !== expected.ino || actual.dev !== expected.dev || actual.size > MAX_RESOURCE_BYTES) throw new Error('The extension resource changed while being opened. Try again.');
    const verified = lstatSync(resourcePath(root, resource));
    if (verified.ino !== actual.ino || verified.dev !== actual.dev || !verified.isFile()) {
      throw new Error('The extension resource changed while being opened. Try again.');
    }
    const bytes = Buffer.alloc(MAX_RESOURCE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_RESOURCE_BYTES) throw new Error('The extension resource exceeds the safe read limit.');
    if (bytes.subarray(0, length).includes(0)) throw new Error('Only text extension resources can be read.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).replace(/^\uFEFF/, '');
  } finally { closeSync(fd); }
}

export function resourceList(root: string): { resources: string[]; truncated: boolean } {
  const resources: string[] = [];
  let scanned = 0;
  let truncated = false;
  const walk = (directory: string, prefix: string, depth: number) => {
    if (depth > 8) { truncated = true; return; }
    const handle = opendirSync(directory);
    try {
      let entry;
      while ((entry = handle.readSync())) {
        if (++scanned > MAX_WALK_ENTRIES || resources.length >= MAX_RESOURCE_FILES) { truncated = true; break; }
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const resource = prefix ? `${prefix}/${entry.name}` : entry.name;
        try {
          const path = resourcePath(root, resource);
          if (entry.isDirectory()) walk(path, resource, depth + 1);
          else if (entry.isFile()) resources.push(resource);
        } catch { /* A changed/symlink entry is never read or advertised. */ }
        if (scanned > MAX_WALK_ENTRIES || resources.length >= MAX_RESOURCE_FILES) { truncated = true; break; }
      }
    } finally { handle.closeSync(); }
  };
  walk(root, '', 0);
  return { resources: resources.sort(), truncated };
}
