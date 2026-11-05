import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FeedArtifact } from './feed';

/**
 * Copying a published artifact off the releases share, onto local disk, verified.
 *
 * Installers are never run from the share: it is mounted noexec, and a network file can change
 * between being checked and being run. So everything an update needs is copied first. A copy goes
 * to `<file>.part` and becomes `<file>` only after all of it hashes to the SHA-256 buildd published,
 * so a Wi-Fi drop halfway through a 130 MB archive resumes from where it stopped rather than starting
 * over, and never leaves a plausible-looking truncated file behind.
 */

export interface CopyOptions {
  signal?: AbortSignal;
  /** Bytes of this file known good or copied so far. */
  onBytes?(bytes: number): void;
}

const sizeOf = async (path: string): Promise<number | null> => {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

async function hashFile(path: string, length: number, onBytes?: (bytes: number) => void, signal?: AbortSignal) {
  const hash = createHash('sha256');
  if (length === 0) return hash;
  let seen = 0;
  await pipeline(
    createReadStream(path, { start: 0, end: length - 1, highWaterMark: 1 << 20 }),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        seen += chunk.length;
        onBytes?.(seen);
        callback();
      },
    }),
    { signal }
  );
  return hash;
}

export async function copyVerified(artifact: FeedArtifact, destination: string, options: CopyOptions = {}): Promise<{ reused: boolean }> {
  const mode = artifact.executable ? 0o755 : 0o644;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });

  // Already staged by an earlier attempt: keep it only if it is still exactly right.
  if ((await sizeOf(destination)) === artifact.size) {
    const hash = await hashFile(destination, artifact.size, undefined, options.signal);
    if (hash.digest('hex') === artifact.sha256) {
      options.onBytes?.(artifact.size);
      return { reused: true };
    }
  }
  await rm(destination, { force: true });

  const sourceSize = await sizeOf(artifact.path);
  if (sourceSize === null) throw new Error(`${artifact.name} is missing from the releases share (${artifact.path}).`);
  if (sourceSize !== artifact.size) {
    throw new Error(`${artifact.name} on the releases share is ${sourceSize} bytes, but buildd published ${artifact.size}.`);
  }

  const partial = `${destination}.part`;
  let offset = (await sizeOf(partial)) ?? 0;
  if (offset > artifact.size) {
    await rm(partial, { force: true });
    offset = 0;
  }
  const hash = await hashFile(partial, offset, options.onBytes, options.signal);

  if (offset < artifact.size) {
    let copied = offset;
    await pipeline(
      createReadStream(artifact.path, { start: offset, highWaterMark: 1 << 20 }),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          copied += chunk.length;
          if (copied > artifact.size) {
            callback(new Error(`${artifact.name} grew while it was being copied.`));
            return;
          }
          hash.update(chunk);
          options.onBytes?.(copied);
          callback(null, chunk);
        },
      }),
      createWriteStream(partial, { flags: offset > 0 ? 'a' : 'w', mode: 0o600 }),
      { signal: options.signal }
    );
  }

  if ((await sizeOf(partial)) !== artifact.size) {
    throw new Error(`${artifact.name} stopped copying before it was complete; it will resume on the next attempt.`);
  }
  if (hash.digest('hex') !== artifact.sha256) {
    await rm(partial, { force: true });
    throw new Error(`${artifact.name} did not match the SHA-256 buildd published for it, so it was discarded.`);
  }
  await chmod(partial, mode);
  await rename(partial, destination);
  return { reused: false };
}
