import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertRepoId } from './api';

/**
 * The Hugging Face cache layout, so that a model Antimatter downloads is one `hf` already knows
 * about, and one `hf download` already fetched is one Antimatter does not fetch again:
 *
 *   <root>/models--<owner>--<name>/
 *     blobs/<sha256>                     the bytes, named by content
 *     blobs/<sha256>.incomplete          a download in progress; `hf` resumes these too
 *     snapshots/<commit>/<path>          a relative symlink into blobs/
 *     refs/main                          the commit `main` pointed at when it was fetched
 *
 * Layout reference: https://huggingface.co/docs/huggingface_hub/guides/manage-cache
 */

/** Where the Hub cache is, by the same rules huggingface_hub uses to find it. */
export function defaultHubCache(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const explicit = env.HF_HUB_CACHE?.trim() || env.HUGGINGFACE_HUB_CACHE?.trim();
  if (explicit) return resolve(explicit);
  return join(hubHome(env, home), 'hub');
}

export function hubHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const explicit = env.HF_HOME?.trim();
  if (explicit) return resolve(explicit);
  const xdg = env.XDG_CACHE_HOME?.trim();
  return join(xdg ? resolve(xdg) : join(home, '.cache'), 'huggingface');
}

/** Where `hf auth login` leaves its token. */
export const cachedTokenPath = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string =>
  env.HF_TOKEN_PATH?.trim() ? resolve(env.HF_TOKEN_PATH.trim()) : join(hubHome(env, home), 'token');

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const assertCommit = (revision: string) => {
  if (!COMMIT.test(revision)) throw new Error(`"${revision}" is not a commit hash.`);
  return revision;
};

const assertSha = (sha256: string) => {
  if (!SHA256.test(sha256)) throw new Error(`"${sha256}" is not a SHA-256 digest.`);
  return sha256;
};

export const repoDirectory = (root: string, repoId: string): string =>
  join(root, `models--${assertRepoId(repoId).replace(/\//g, '--')}`);

export const blobPath = (root: string, repoId: string, sha256: string): string =>
  join(repoDirectory(root, repoId), 'blobs', assertSha(sha256));

export const incompletePath = (root: string, repoId: string, sha256: string): string =>
  `${blobPath(root, repoId, sha256)}.incomplete`;

/**
 * Where a repository file appears under a snapshot. The path came from the network, so it is
 * resolved and required to stay inside the snapshot rather than trusted to.
 */
export function snapshotPath(root: string, repoId: string, revision: string, file: string): string {
  const snapshot = join(repoDirectory(root, repoId), 'snapshots', assertCommit(revision));
  const target = resolve(snapshot, file);
  if (!target.startsWith(snapshot + sep)) throw new Error(`"${file}" would land outside the snapshot.`);
  return target;
}

/** Points a snapshot entry at its blob, replacing whatever was there in one rename. */
export function linkSnapshot(root: string, repoId: string, revision: string, file: string, sha256: string): string {
  const link = snapshotPath(root, repoId, revision, file);
  const target = relative(dirname(link), blobPath(root, repoId, sha256));
  mkdirSync(dirname(link), { recursive: true });

  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) return link;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporary = join(dirname(link), `.${randomUUID()}.link`);
  symlinkSync(target, temporary);
  try {
    renameSync(temporary, link);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return link;
}

export function writeRef(root: string, repoId: string, ref: string, revision: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(ref)) throw new Error(`"${ref}" is not a usable ref name.`);
  const path = join(repoDirectory(root, repoId), 'refs', ref);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, assertCommit(revision));
}

/** True when the snapshot already holds this file at its full size — fetched by us or by `hf`. */
export function hasFile(root: string, repoId: string, revision: string, file: string, size: number): boolean {
  try {
    return statSync(snapshotPath(root, repoId, revision, file)).size === size;
  } catch {
    return false;
  }
}

/** Bytes already on disk toward this file: the finished blob, or a partial one. */
export function bytesOnDisk(root: string, repoId: string, sha256: string): number {
  for (const candidate of [blobPath(root, repoId, sha256), incompletePath(root, repoId, sha256)]) {
    try {
      return statSync(candidate).size;
    } catch {
      // Not this one.
    }
  }
  return 0;
}

/**
 * Removes the snapshot entries for these files, then any blob no remaining snapshot points at.
 * A blob another revision still links to stays: it is the same bytes, and that revision needs them.
 */
export function removeFiles(root: string, repoId: string, revision: string, files: { path: string; sha256: string | null }[]): void {
  const repo = repoDirectory(root, repoId);
  for (const file of files) {
    rmSync(snapshotPath(root, repoId, revision, file.path), { force: true });
    if (file.sha256) rmSync(incompletePath(root, repoId, file.sha256), { force: true });
  }

  const referenced = new Set<string>();
  const walk = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink()) referenced.add(resolve(dirname(full), readlinkSync(full)));
    }
  };
  walk(join(repo, 'snapshots'));

  for (const file of files) {
    if (!file.sha256) continue;
    const blob = blobPath(root, repoId, file.sha256);
    if (!referenced.has(blob)) rmSync(blob, { force: true });
  }

  // With no bytes and no snapshot left, the repository folder is only a ref pointing at nothing.
  const isEmpty = (directory: string): boolean =>
    !existsSync(directory) ||
    readdirSync(directory, { withFileTypes: true }).every((entry) => entry.isDirectory() && isEmpty(join(directory, entry.name)));
  if (existsSync(repo) && isEmpty(join(repo, 'blobs')) && isEmpty(join(repo, 'snapshots'))) {
    rmSync(repo, { recursive: true, force: true });
  }
}
