import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errorFromResponse, HubError, type HubTransport } from './api';

/**
 * One file from the Hub to disk, resumable and verified.
 *
 * Bytes go to `<blob>.incomplete` and only become `<blob>` after the whole file has hashed to the
 * digest the Hub published for it, so a finished path is always a correct one. An interrupted
 * transfer keeps its partial file; the next attempt hashes what is already there and asks for the
 * rest with a Range request. That is the same `.incomplete` convention `hf` uses, so either tool
 * can finish a download the other started.
 *
 * Redirects are followed by hand. The Hub answers a resolve URL with a redirect to a signed CDN
 * URL, and the token must reach the Hub and nothing else — so it is attached per hop, only while
 * the hop is on the Hub's own origin.
 */

export type TransferPhase = 'checking' | 'transferring' | 'finishing';

export interface TransferRequest {
  /** The Hub's resolve URL for this file at a pinned commit. */
  url: string;
  /** Final blob path. */
  destination: string;
  size: number;
  sha256: string | null;
  token?: string | null;
  /** The only origin the token is ever sent to. */
  trustedOrigin: string;
  transport?: HubTransport;
  signal?: AbortSignal;
  userAgent?: string;
  /** Total bytes of this file known good or received so far. */
  onBytes(bytes: number): void;
  onPhase?(phase: TransferPhase): void;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 8;

const sizeOf = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
};

const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
};

/** `bytes 100-199/1000` → its parts; `*` totals come back as null. */
export function parseContentRange(value: string | null): { start: number; end: number; total: number | null } | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value?.trim() ?? '');
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) };
}

async function openStream(request: TransferRequest, offset: number): Promise<Response> {
  const transport = request.transport ?? fetch;
  let url = request.url;

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const current = new URL(url);
    const headers: Record<string, string> = {
      // A compressed response has no stable byte offsets to resume from.
      'Accept-Encoding': 'identity',
      ...(request.userAgent ? { 'User-Agent': request.userAgent } : {}),
      ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
      ...(request.token && current.origin === request.trustedOrigin ? { Authorization: `Bearer ${request.token}` } : {}),
    };

    let response: Response;
    try {
      response = await transport(url, { headers, redirect: 'manual', signal: request.signal });
    } catch (error) {
      aborted(request.signal);
      const cause = (error as Error & { cause?: Error }).cause?.message ?? (error as Error).message;
      throw new HubError('network', `Could not reach ${current.host} (${cause}).`);
    }

    if (!REDIRECTS.has(response.status)) return response;

    // The Hub states the file's real size and digest on the hop it redirects from. A listing that
    // disagrees with the file it points at would otherwise surface only as a failed checksum.
    const linkedSize = Number(response.headers.get('x-linked-size'));
    if (Number.isFinite(linkedSize) && linkedSize > 0 && linkedSize !== request.size) {
      throw new HubError('corrupt', `Hugging Face now reports ${linkedSize} bytes for this file, not the ${request.size} it listed.`);
    }
    const linkedEtag = response.headers.get('x-linked-etag')?.replace(/^W\//, '').replace(/"/g, '').toLowerCase();
    if (request.sha256 && linkedEtag && /^[0-9a-f]{64}$/.test(linkedEtag) && linkedEtag !== request.sha256) {
      throw new HubError('corrupt', 'The file on Hugging Face changed since it was listed; refresh the model and try again.');
    }

    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new HubError('server', `${current.host} redirected without saying where.`);
    const next = new URL(location, url);
    // Never step down from https. Plain http is only followed from plain http, which is a local test.
    if (next.protocol !== 'https:' && !(next.protocol === 'http:' && current.protocol === 'http:')) {
      throw new HubError('server', `Refused to follow a redirect to ${next.protocol}//${next.host}.`);
    }
    url = next.toString();
  }

  throw new HubError('server', 'Hugging Face redirected too many times.');
}

/** Hashes the bytes already on disk, so a resumed file is verified end to end like a fresh one. */
async function hashExisting(path: string, length: number, hash: ReturnType<typeof createHash>, request: TransferRequest) {
  let seen = 0;
  await pipeline(
    createReadStream(path, { start: 0, end: length - 1, highWaterMark: 4 << 20 }),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        seen += chunk.length;
        request.onBytes(seen);
        callback();
      },
    }),
    { signal: request.signal }
  );
}

export async function transferFile(request: TransferRequest): Promise<{ reused: boolean }> {
  const { destination, size, signal } = request;
  aborted(signal);

  const existing = await sizeOf(destination);
  if (existing === size && size > 0) {
    request.onBytes(size);
    return { reused: true };
  }
  // A blob is named by its digest, so one of the wrong size is damaged, not a different file.
  if (existing > 0) await rm(destination, { force: true });

  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.incomplete`;
  let offset = await sizeOf(partial);
  if (offset > size) {
    await rm(partial, { force: true });
    offset = 0;
  }

  let hash = request.sha256 ? createHash('sha256') : null;
  if (offset > 0 && hash) {
    request.onPhase?.('checking');
    await hashExisting(partial, offset, hash, request);
  }
  request.onBytes(offset);

  if (offset < size) {
    request.onPhase?.('transferring');
    const response = await openStream(request, offset);
    let start: number;

    if (response.status === 206) {
      const range = parseContentRange(response.headers.get('content-range'));
      if (!range || range.start !== offset) {
        await response.body?.cancel().catch(() => undefined);
        throw new HubError('server', 'The server resumed from the wrong place; retrying.');
      }
      if (range.total !== null && range.total !== size) {
        await response.body?.cancel().catch(() => undefined);
        throw new HubError('corrupt', `The server holds ${range.total} bytes for this file, not ${size}.`);
      }
      start = offset;
    } else if (response.status === 200) {
      // The server ignored the Range header and is sending the whole file. Start from zero.
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > 0 && length !== size) {
        await response.body?.cancel().catch(() => undefined);
        throw new HubError('corrupt', `The server is sending ${length} bytes for this file, not ${size}.`);
      }
      if (offset > 0 && request.sha256) hash = createHash('sha256');
      start = 0;
    } else if (response.status === 416) {
      // It will not serve from where the partial ends, so the partial is not a prefix of this file.
      await response.body?.cancel().catch(() => undefined);
      await rm(partial, { force: true });
      throw new HubError('server', 'The partial download did not match the file; starting it again.');
    } else {
      throw await errorFromResponse(response, 'the download');
    }

    if (!response.body) throw new HubError('server', 'The server sent no file.');
    let written = start;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        if (written > size) {
          callback(new HubError('corrupt', `The server sent more than the ${size} bytes this file should have.`));
          return;
        }
        hash?.update(chunk);
        request.onBytes(written);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
        counter,
        createWriteStream(partial, { flags: start > 0 ? 'a' : 'w' }),
        { signal }
      );
    } catch (error) {
      aborted(signal);
      if (error instanceof HubError) {
        if (error.code === 'corrupt') await rm(partial, { force: true });
        throw error;
      }
      throw new HubError('network', `The download was interrupted (${(error as Error).message}).`);
    }
  }

  request.onPhase?.('finishing');
  const received = await sizeOf(partial);
  if (received !== size) throw new HubError('network', `The download stopped at ${received} of ${size} bytes.`);

  if (hash && request.sha256) {
    const digest = hash.digest('hex');
    if (digest !== request.sha256) {
      await rm(partial, { force: true });
      throw new HubError('corrupt', `The downloaded file failed its SHA-256 check (expected ${request.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…).`);
    }
  }

  await rename(partial, destination);
  return { reused: false };
}
