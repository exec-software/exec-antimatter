import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, open, readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseVersion } from './version';

/**
 * Reading immutable Antimatter releases from a local or mounted update feed.
 *
 * buildd is the only writer: it assembles a release under a hidden staging directory, verifies
 * every artifact, renames the finished build folder into `builds/`, and only then rewrites
 * `latest.json` (see releases/README.md). A published build folder never changes afterwards,
 * so the SHA-256 values in `latest.json` are the identities every copied file is checked against.
 *
 *   /mnt/releases/antimatter/
 *     latest.json                      execute.buildd/latest-v2 — the machine-readable pointer
 *     builds/<stamp>__<version>__<id>/
 *       build.json, build.log
 *       artifacts/install.sh, Antimatter-<version>-linux-x86_64.tar.gz, …
 */

export const LATEST_SCHEMA = 'execute.buildd/latest-v2';
export const PROJECT = 'antimatter';

/**
 * Conventional mount for a read-only release feed. Users can select a different
 * local or mounted feed in Settings → Updates; no particular server is required.
 */
export const DEFAULT_FEED = '/mnt/releases/antimatter';

/** The original writable `builds` share remains a supported mount for existing installations. */
export const LEGACY_FEED = '/mnt/builds/managed/antimatter';

export interface FeedArtifact {
  name: string;
  /** Absolute path on the share. */
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
}

export interface FeedBuild {
  buildId: string;
  version: string;
  gitRef: string | null;
  commit: string | null;
  publishedAt: string | null;
  /** Absolute path of the immutable build folder. */
  directory: string;
  artifacts: Map<string, FeedArtifact>;
}

const MAX_LATEST_BYTES = 1 << 20;
const MAX_NOTES_BYTES = 256 << 10;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9._+-]{1,200}$/;

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} is not an object.`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} is missing.`);
  return value;
};

/** A path from the share's metadata becomes a path on disk, so it must stay inside where it claims to be. */
function inside(root: string, relativePath: unknown, what: string): string {
  const value = text(relativePath, what);
  if (isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error(`${what} is not a relative path inside the feed.`);
  const target = resolve(root, value);
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`${what} leaves the feed.`);
  return target;
}

export function parseLatest(document: unknown, feedRoot: string): FeedBuild {
  const root = resolve(feedRoot);
  const latestFile = record(document, 'latest.json');
  if (latestFile.schema !== LATEST_SCHEMA) {
    throw new Error(`latest.json has schema ${JSON.stringify(latestFile.schema)}; this Antimatter reads ${LATEST_SCHEMA}.`);
  }
  if (latestFile.project !== PROJECT) throw new Error(`latest.json describes ${JSON.stringify(latestFile.project)}, not ${PROJECT}.`);

  const latest = record(latestFile.latest, 'latest.json latest');
  const buildId = text(latest.build_id, 'build_id');
  if (!SAFE_NAME.test(buildId)) throw new Error('build_id has unexpected characters.');
  const version = text(latest.version, 'version');
  if (!parseVersion(version)) throw new Error(`latest.json version ${JSON.stringify(version)} is not a semantic version.`);

  const directory = inside(root, latest.relative_path, 'relative_path');
  if (!relative(root, directory).startsWith(`builds${sep}`)) throw new Error('relative_path is not a published build folder.');

  if (!Array.isArray(latest.artifacts)) throw new Error('latest.json lists no artifacts.');
  const artifacts = new Map<string, FeedArtifact>();
  for (const entry of latest.artifacts) {
    const artifact = record(entry, 'artifact');
    const name = text(artifact.name, 'artifact name');
    if (!SAFE_NAME.test(name)) throw new Error(`artifact name ${JSON.stringify(name)} has unexpected characters.`);
    const path = inside(directory, artifact.relative_path, `${name} relative_path`);
    const size = artifact.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new Error(`${name} has no usable size.`);
    const sha256 = typeof artifact.sha256 === 'string' ? artifact.sha256.toLowerCase() : '';
    if (!SHA256.test(sha256)) throw new Error(`${name} has no SHA-256.`);
    if (artifacts.has(name)) throw new Error(`${name} is listed twice.`);
    artifacts.set(name, { name, path, size, sha256, executable: artifact.executable === true });
  }

  const optional = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  return {
    buildId,
    version,
    gitRef: optional(latest.git_ref),
    commit: optional(latest.commit),
    publishedAt: optional(latest.published_at),
    directory,
    artifacts,
  };
}

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size > limit) throw new Error(`${path} is ${size} bytes, more than the ${limit} expected.`);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function readLatest(feedRoot: string): Promise<FeedBuild> {
  const bytes = await readBounded(join(feedRoot, 'latest.json'), MAX_LATEST_BYTES);
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${join(feedRoot, 'latest.json')} is not valid JSON.`);
  }
  return parseLatest(document, feedRoot);
}

/** The published release notes, only when they hash to what buildd recorded. */
export async function readNotes(build: FeedBuild): Promise<string | null> {
  const notes = build.artifacts.get('RELEASE_NOTES.md');
  if (!notes || notes.size > MAX_NOTES_BYTES) return null;
  try {
    const bytes = await readBounded(notes.path, MAX_NOTES_BYTES);
    return createHash('sha256').update(bytes).digest('hex') === notes.sha256 ? bytes.toString('utf8') : null;
  } catch {
    return null;
  }
}

/**
 * Where the feed might be, most conventional first: the dedicated read-only `releases` mount,
 * the older `builds` mount, then either share opened through GNOME Files (GVFS mounts it under the
 * runtime directory). The `releases` share already starts at buildd's managed root, while the
 * legacy `builds` share starts two levels above the project.
 *
 * Everything that touches these paths is asynchronous. A synchronous stat of a network path that
 * has lost its server blocks the whole main process until the mount gives up.
 */
export async function feedCandidates(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 1000): Promise<string[]> {
  const candidates = [DEFAULT_FEED, LEGACY_FEED];
  const gvfs = join(env.XDG_RUNTIME_DIR || `/run/user/${uid}`, 'gvfs');
  try {
    for (const entry of await readdir(gvfs)) {
      if (/^smb-share:.*\bshare=releases\b/i.test(entry)) candidates.push(join(gvfs, entry, PROJECT));
      if (/^smb-share:.*\bshare=builds\b/i.test(entry)) candidates.push(join(gvfs, entry, 'managed', PROJECT));
    }
  } catch {
    // No GVFS mounts on this machine.
  }
  return [...new Set(candidates)];
}

interface MountEntry {
  source: string;
  target: string;
  type: string;
  options: string[];
}

/** /proc/mounts escapes spaces and other separators in paths as octal sequences. */
const unescapeMount = (value: string) => value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));

export function parseMounts(table: string): MountEntry[] {
  return table
    .split('\n')
    .map((line) => line.split(' '))
    .filter((fields) => fields.length >= 4)
    .map(([source, target, type, options]) => ({
      source: unescapeMount(source),
      target: unescapeMount(target),
      type,
      options: options.split(','),
    }));
}

/** The server and port behind a network mount holding `path`, or null for local and FUSE filesystems. */
export function networkEndpoint(path: string, mounts: MountEntry[]): { host: string; port: number } | null {
  const target = resolve(path);
  const mount = mounts
    .filter((entry) => target === entry.target || target.startsWith(entry.target === '/' ? '/' : `${entry.target}/`))
    .sort((a, b) => b.target.length - a.target.length)[0];
  if (!mount) return null;
  const option = (name: string) => mount.options.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (mount.type === 'cifs' || mount.type === 'smb3') {
    const host = option('addr') ?? /^\/\/([^/]+)\//.exec(mount.source)?.[1];
    return host ? { host, port: Number(option('port') ?? 445) } : null;
  }
  if (mount.type === 'nfs' || mount.type === 'nfs4') {
    const host = option('addr') ?? mount.source.split(':')[0];
    return host ? { host, port: 2049 } : null;
  }
  return null;
}

/**
 * Whether a feed on a network mount has a server to talk to, asked without touching the mount.
 * On a laptop that has left the LAN, reading a CIFS path waits out the mount's timeouts — minutes,
 * holding one of Node's filesystem threads — while a TCP connect to the server fails in a second.
 */
export async function feedReachable(
  path: string,
  options: { mounts?: string; timeoutMs?: number; probe?(host: string, port: number, timeoutMs: number): Promise<boolean> } = {}
): Promise<boolean> {
  let table = options.mounts;
  if (table === undefined) {
    try {
      table = readFileSync('/proc/mounts', 'utf8');
    } catch {
      return true;
    }
  }
  const endpoint = networkEndpoint(path, parseMounts(table));
  if (!endpoint) return true;
  return (options.probe ?? tcpProbe)(endpoint.host, endpoint.port, options.timeoutMs ?? 1500);
}

const tcpProbe = (host: string, port: number, timeoutMs: number): Promise<boolean> =>
  new Promise((resolveProbe) => {
    const socket = connect({ host, port });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolveProbe(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

export interface ResolvedFeed {
  /** The feed to read; when nothing answered, the first candidate whose server did not; null when none is mounted. */
  path: string | null;
  configured: boolean;
  /** Whether the server behind `path` answered. */
  reachable: boolean;
}

/**
 * A configured feed is used as given; otherwise the first candidate whose server answers and that
 * has a latest.json. The server is asked before the path is touched, for the reason above.
 */
export async function resolveFeed(
  configured: string | null,
  candidates: string[],
  reachable: (path: string) => Promise<boolean> = feedReachable
): Promise<ResolvedFeed> {
  if (configured) return { path: configured, configured: true, reachable: await reachable(configured) };
  let silent: string | null = null;
  for (const candidate of candidates) {
    if (!(await reachable(candidate))) {
      silent ??= candidate;
      continue;
    }
    try {
      await access(join(candidate, 'latest.json'));
      return { path: candidate, configured: false, reachable: true };
    } catch {
      // Not published here.
    }
  }
  return { path: silent, configured: false, reachable: false };
}
