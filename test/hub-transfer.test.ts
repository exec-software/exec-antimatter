import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HubError } from '../src/main/hub/api';
import * as cache from '../src/main/hub/cache';
import { DownloadManager, modelIdFor } from '../src/main/hub/downloads';
import { transferFile, type TransferPhase } from '../src/main/hub/transfer';
import type { DownloadRecord, HubVariant } from '../src/main/hub/types';

const REPO = 'acme/Tiny-Model-GGUF';
const REVISION = 'c'.repeat(40);

interface Behaviour {
  /** Answer 200 with the whole body even when a Range was asked for. */
  ignoreRange?: boolean;
  /** Destroy the connection after sending this many body bytes, once. */
  dropAfter?: number;
  /** Flip a byte in what is served. */
  corrupt?: boolean;
  /** Bytes per tick, to leave time to pause. */
  throttle?: number;
  /** What the hub hop claims about the file. */
  linkedSize?: number;
}

interface Fixture {
  hub: string;
  cdnRequests: { range: string | null; auth: string | null }[];
  hubRequests: { auth: string | null }[];
  behaviour: Behaviour;
  close(): Promise<void>;
}

const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

/**
 * Two origins, like the real thing: the "Hub" answers resolve URLs with a redirect, and a "CDN" on
 * a different origin (localhost vs 127.0.0.1) serves the bytes with Range support.
 */
async function fixture(files: Map<string, Buffer>): Promise<Fixture> {
  const behaviour: Behaviour = {};
  const cdnRequests: Fixture['cdnRequests'] = [];
  const hubRequests: Fixture['hubRequests'] = [];
  let dropped = false;

  const cdn = createServer((request: IncomingMessage, response: ServerResponse) => {
    cdnRequests.push({ range: request.headers.range ?? null, auth: request.headers.authorization ?? null });
    const name = decodeURIComponent(new URL(request.url!, 'http://x').pathname.slice(1));
    let body = files.get(name);
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    if (behaviour.corrupt) {
      body = Buffer.from(body);
      body[body.length >> 1] ^= 0xff;
    }
    const range = /bytes=(\d+)-/.exec(request.headers.range ?? '');
    const start = range && !behaviour.ignoreRange ? Number(range[1]) : 0;
    if (start >= body.length && body.length > 0) {
      response.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
      return;
    }
    const slice = body.subarray(start);
    response.writeHead(start > 0 ? 206 : 200, {
      'Content-Length': String(slice.length),
      'Accept-Ranges': 'bytes',
      ...(start > 0 ? { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
    });

    const drop = behaviour.dropAfter !== undefined && !dropped ? behaviour.dropAfter : null;
    let offset = 0;
    const step = behaviour.throttle ?? 64 * 1024;
    const pump = () => {
      if (response.destroyed) return;
      if (drop !== null && offset >= drop) {
        dropped = true;
        response.destroy();
        return;
      }
      const end = Math.min(slice.length, offset + step, drop ?? Infinity);
      response.write(slice.subarray(offset, end));
      offset = end;
      if (offset >= slice.length) response.end();
      else setTimeout(pump, behaviour.throttle ? 5 : 0);
    };
    pump();
  });
  const cdnPort = await listen(cdn);

  const hub = createServer((request, response) => {
    hubRequests.push({ auth: request.headers.authorization ?? null });
    const match = new RegExp(`^/${REPO}/resolve/${REVISION}/(.+)$`).exec(new URL(request.url!, 'http://x').pathname);
    const name = match ? decodeURIComponent(match[1]) : '';
    const body = files.get(name);
    if (!body) {
      response.writeHead(404, { 'x-error-code': 'EntryNotFound', 'x-error-message': 'Entry not found' }).end();
      return;
    }
    response
      .writeHead(302, {
        Location: `http://localhost:${cdnPort}/${encodeURIComponent(name)}?signature=abc`,
        'x-linked-size': String(behaviour.linkedSize ?? body.length),
        'x-linked-etag': `"${createHash('sha256').update(body).digest('hex')}"`,
        'x-repo-commit': REVISION,
      })
      .end();
  });
  const hubPort = await listen(hub);

  return {
    hub: `http://127.0.0.1:${hubPort}`,
    cdnRequests,
    hubRequests,
    behaviour,
    close: async () => {
      await Promise.all([new Promise((resolve) => cdn.close(resolve)), new Promise((resolve) => hub.close(resolve))]);
    },
  };
}

const digest = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

function workspace(t: { after(fn: () => unknown): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-hub-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('downloads through the redirect, verifies the digest, and never sends the token to the CDN', async (t) => {
  const body = randomBytes(700_000);
  const server = await fixture(new Map([['model-Q4_K_M.gguf', body]]));
  t.after(() => server.close());
  const root = workspace(t);
  const destination = cache.blobPath(root, REPO, digest(body));
  const phases: TransferPhase[] = [];
  let lastBytes = 0;

  const result = await transferFile({
    url: `${server.hub}/${REPO}/resolve/${REVISION}/model-Q4_K_M.gguf`,
    destination,
    size: body.length,
    sha256: digest(body),
    token: 'hf_secret',
    trustedOrigin: server.hub,
    onBytes: (bytes) => (lastBytes = bytes),
    onPhase: (phase) => phases.push(phase),
  });

  assert.deepEqual(result, { reused: false });
  assert.deepEqual(readFileSync(destination), body);
  assert.equal(existsSync(`${destination}.incomplete`), false);
  assert.equal(lastBytes, body.length);
  assert.deepEqual(phases, ['transferring', 'finishing']);
  assert.equal(server.hubRequests[0].auth, 'Bearer hf_secret');
  assert.equal(server.cdnRequests[0].auth, null, 'the signed CDN URL must not receive the Hugging Face token');

  // A finished blob of the right size is reused without touching the network.
  const again = await transferFile({
    url: `${server.hub}/${REPO}/resolve/${REVISION}/model-Q4_K_M.gguf`,
    destination,
    size: body.length,
    sha256: digest(body),
    trustedOrigin: server.hub,
    onBytes: () => undefined,
  });
  assert.deepEqual(again, { reused: true });
  assert.equal(server.hubRequests.length, 1);
});

test('resumes from a partial file with a Range request and verifies the whole file', async (t) => {
  const body = randomBytes(900_000);
  const server = await fixture(new Map([['m.gguf', body]]));
  t.after(() => server.close());
  const root = workspace(t);
  const destination = cache.blobPath(root, REPO, digest(body));
  mkdirSync(join(destination, '..'), { recursive: true });
  writeFileSync(`${destination}.incomplete`, body.subarray(0, 400_000));
  const phases: TransferPhase[] = [];

  await transferFile({
    url: `${server.hub}/${REPO}/resolve/${REVISION}/m.gguf`,
    destination,
    size: body.length,
    sha256: digest(body),
    trustedOrigin: server.hub,
    onBytes: () => undefined,
    onPhase: (phase) => phases.push(phase),
  });

  assert.equal(server.cdnRequests[0].range, 'bytes=400000-');
  assert.deepEqual(readFileSync(destination), body);
  assert.deepEqual(phases, ['checking', 'transferring', 'finishing']);
});

test('a server that ignores Range restarts the file from zero instead of appending', async (t) => {
  const body = randomBytes(300_000);
  const server = await fixture(new Map([['m.gguf', body]]));
  t.after(() => server.close());
  server.behaviour.ignoreRange = true;
  const root = workspace(t);
  const destination = cache.blobPath(root, REPO, digest(body));
  mkdirSync(join(destination, '..'), { recursive: true });
  writeFileSync(`${destination}.incomplete`, body.subarray(0, 100_000));

  await transferFile({
    url: `${server.hub}/${REPO}/resolve/${REVISION}/m.gguf`,
    destination,
    size: body.length,
    sha256: digest(body),
    trustedOrigin: server.hub,
    onBytes: () => undefined,
  });
  assert.deepEqual(readFileSync(destination), body);
});

test('a dropped connection keeps the partial file, and the next attempt finishes it', async (t) => {
  const body = randomBytes(1_000_000);
  const server = await fixture(new Map([['m.gguf', body]]));
  t.after(() => server.close());
  server.behaviour.dropAfter = 256 * 1024;
  const root = workspace(t);
  const destination = cache.blobPath(root, REPO, digest(body));
  const request = {
    url: `${server.hub}/${REPO}/resolve/${REVISION}/m.gguf`,
    destination,
    size: body.length,
    sha256: digest(body),
    trustedOrigin: server.hub,
    onBytes: () => undefined,
  };

  await assert.rejects(transferFile(request), (error: unknown) => error instanceof HubError && error.retryable);
  const kept = statSync(`${destination}.incomplete`).size;
  assert.ok(kept > 0 && kept < body.length, `kept ${kept} bytes`);

  await transferFile(request);
  assert.equal(server.cdnRequests[1].range, `bytes=${kept}-`);
  assert.deepEqual(readFileSync(destination), body);
});

test('bytes that fail the digest are deleted rather than kept or renamed', async (t) => {
  const body = randomBytes(200_000);
  const server = await fixture(new Map([['m.gguf', body]]));
  t.after(() => server.close());
  server.behaviour.corrupt = true;
  const root = workspace(t);
  const destination = cache.blobPath(root, REPO, digest(body));

  await assert.rejects(
    transferFile({
      url: `${server.hub}/${REPO}/resolve/${REVISION}/m.gguf`,
      destination,
      size: body.length,
      sha256: digest(body),
      trustedOrigin: server.hub,
      onBytes: () => undefined,
    }),
    (error: unknown) => error instanceof HubError && error.code === 'corrupt' && /SHA-256/.test(error.message)
  );
  assert.equal(existsSync(destination), false);
  assert.equal(existsSync(`${destination}.incomplete`), false);
});

test('a listing that disagrees with the file it points at stops before any bytes move', async (t) => {
  const body = randomBytes(10_000);
  const server = await fixture(new Map([['m.gguf', body]]));
  t.after(() => server.close());
  server.behaviour.linkedSize = body.length + 1;
  const root = workspace(t);

  await assert.rejects(
    transferFile({
      url: `${server.hub}/${REPO}/resolve/${REVISION}/m.gguf`,
      destination: cache.blobPath(root, REPO, digest(body)),
      size: body.length,
      sha256: digest(body),
      trustedOrigin: server.hub,
      onBytes: () => undefined,
    }),
    /now reports/
  );
  assert.equal(server.cdnRequests.length, 0);
});

const variantOf = (files: Map<string, Buffer>, label = 'Q4_K_M'): HubVariant => {
  const entries = [...files.entries()].map(([path, body]) => ({ path, size: body.length, sha256: digest(body) }));
  return {
    key: entries[0].path,
    label,
    quant: label,
    files: entries,
    bytes: entries.reduce((total, file) => total + file.size, 0),
    shards: entries.length,
    role: 'model',
    complete: true,
  };
};

function manager(root: string, server: Fixture, overrides: Partial<ConstructorParameters<typeof DownloadManager>[0]> = {}) {
  const emitted: DownloadRecord[][] = [];
  const ready: DownloadRecord[] = [];
  const downloads = new DownloadManager({
    storePath: join(root, 'state', 'hub-downloads.json'),
    root: () => join(root, 'cache'),
    token: () => 'hf_secret',
    endpoint: () => server.hub,
    userAgent: 'antimatter-test',
    freeBytes: () => 1024 ** 4,
    emit: (records) => emitted.push(records),
    onReady: (record) => ready.push(record),
    inspect: async () => ({ architecture: 'qwen3moe', contextLength: 40960, fileType: 15 }),
    sleep: async () => undefined,
    ...overrides,
  });
  return { downloads, emitted, ready };
}

async function until(check: () => boolean, what: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('the queue downloads every shard into the Hugging Face cache layout and hands the model over', async (t) => {
  const files = new Map([
    ['Q8_0/tiny-Q8_0-00001-of-00002.gguf', randomBytes(300_000)],
    ['Q8_0/tiny-Q8_0-00002-of-00002.gguf', randomBytes(200_000)],
  ]);
  const server = await fixture(files);
  t.after(() => server.close());
  const root = workspace(t);
  const { downloads, ready } = manager(root, server);
  downloads.load();

  const record = downloads.enqueue({ repoId: REPO, revision: REVISION, variant: variantOf(files, 'Q8_0') });
  await until(() => ready.length === 1, 'the download to finish');

  const finished = downloads.find(record.id)!;
  const cacheRoot = join(root, 'cache');
  assert.equal(finished.state, 'ready');
  assert.equal(finished.bytesDone, 500_000);
  assert.equal(finished.architecture, 'qwen3moe');
  assert.equal(finished.contextLength, 40960);
  assert.equal(finished.phase, 'registering');
  assert.equal(finished.path, cache.snapshotPath(cacheRoot, REPO, REVISION, 'Q8_0/tiny-Q8_0-00001-of-00002.gguf'));

  for (const [path, body] of files) {
    const link = cache.snapshotPath(cacheRoot, REPO, REVISION, path);
    assert.ok(lstatSync(link).isSymbolicLink(), `${path} is a snapshot link`);
    assert.equal(readlinkSync(link), `../../../blobs/${digest(body)}`);
    assert.deepEqual(readFileSync(link), body);
  }
  assert.equal(readFileSync(join(cache.repoDirectory(cacheRoot, REPO), 'refs', 'main'), 'utf8'), REVISION);

  // Registration reports back without disturbing anything else about the record.
  downloads.setRegistrations(record.id, [
    { target: 'external', sourceId: 'gpu', sourceName: 'GPU', status: 'registered', modelId: finished.path, detail: null, at: 1 },
  ]);
  assert.equal(downloads.find(record.id)!.phase, null);
  const stored = JSON.parse(readFileSync(join(root, 'state', 'hub-downloads.json'), 'utf8'));
  assert.equal(stored.downloads[0].registrations[0].status, 'registered');
  assert.equal(statSync(join(root, 'state', 'hub-downloads.json')).mode & 0o777, 0o600);
});

test('pausing keeps the partial file, resuming continues from it, and a restart resumes what was running', async (t) => {
  const files = new Map([['tiny-Q4_K_M.gguf', randomBytes(2_000_000)]]);
  const server = await fixture(files);
  t.after(() => server.close());
  server.behaviour.throttle = 16 * 1024;
  const root = workspace(t);
  const first = manager(root, server);
  first.downloads.load();

  const record = first.downloads.enqueue({ repoId: REPO, revision: REVISION, variant: variantOf(files) });
  await until(() => (first.downloads.find(record.id)?.bytesDone ?? 0) > 100_000, 'bytes to arrive');
  first.downloads.pause(record.id);
  await until(() => first.emitted.at(-1)?.[0]?.state === 'paused', 'the pause to settle');
  const partial = cache.incompletePath(join(root, 'cache'), REPO, digest(files.get('tiny-Q4_K_M.gguf')!));
  await until(() => existsSync(partial) && statSync(partial).size > 0, 'the partial file to be flushed');

  // The app quits while it runs: the store says "downloading", and the next launch carries on.
  first.downloads.resume(record.id);
  await until(() => first.downloads.find(record.id)?.state === 'downloading', 'the resume');
  first.downloads.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 50));

  server.behaviour.throttle = undefined;
  const second = manager(root, server);
  second.downloads.load();
  await until(() => second.ready.length === 1, 'the restored download to finish');
  assert.deepEqual(readFileSync(second.downloads.find(record.id)!.path!), files.get('tiny-Q4_K_M.gguf'));
  assert.ok(
    server.cdnRequests.slice(1).every((request) => request.range !== null),
    'every request after the first resumed rather than starting over'
  );
});

test('the queue refuses a download that will not fit, and cancelling deletes what was written', async (t) => {
  const files = new Map([['big-Q4_K_M.gguf', randomBytes(1_500_000)]]);
  const server = await fixture(files);
  t.after(() => server.close());
  server.behaviour.throttle = 16 * 1024;
  const root = workspace(t);

  const cramped = manager(root, server, { freeBytes: () => 1024 });
  cramped.downloads.load();
  assert.throws(() => cramped.downloads.enqueue({ repoId: REPO, revision: REVISION, variant: variantOf(files) }), /needs/i);

  const roomy = manager(root, server);
  roomy.downloads.load();
  const record = roomy.downloads.enqueue({ repoId: REPO, revision: REVISION, variant: variantOf(files) });
  await until(() => (roomy.downloads.find(record.id)?.bytesDone ?? 0) > 50_000, 'bytes to arrive');
  roomy.downloads.cancel(record.id);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(roomy.downloads.find(record.id), null);
  assert.equal(existsSync(cache.incompletePath(join(root, 'cache'), REPO, digest(files.get('big-Q4_K_M.gguf')!))), false);
  assert.equal(existsSync(cache.repoDirectory(join(root, 'cache'), REPO)), false, 'nothing is left of the repository folder');
});

test('retries a dropped connection on its own and names models after the repository and quant', async (t) => {
  const files = new Map([['m-Q5_K_M.gguf', randomBytes(600_000)]]);
  const server = await fixture(files);
  t.after(() => server.close());
  server.behaviour.dropAfter = 100_000;
  const root = workspace(t);
  const { downloads, ready } = manager(root, server);
  downloads.load();

  downloads.enqueue({ repoId: REPO, revision: REVISION, variant: variantOf(files, 'Q5_K_M') });
  await until(() => ready.length === 1, 'the retried download to finish');
  assert.equal(server.cdnRequests.length, 2);
  assert.equal(ready[0].modelId, 'tiny-model-q5_k_m');

  assert.equal(modelIdFor('Qwen/Qwen3-0.6B-GGUF', { quant: 'Q8_0', label: 'Q8_0' }), 'qwen3-0.6b-q8_0');
  assert.equal(modelIdFor('unsloth/gpt-oss-20b-GGUF', { quant: null, label: 'gpt-oss-20b' }), 'gpt-oss-20b');
});

test('a download finished before the quantization was kept has its header read back exactly once', async (t) => {
  const server = await fixture(new Map([['m-Q4_K_M.gguf', randomBytes(1024)]]));
  t.after(() => server.close());
  const root = workspace(t);
  const modelPath = join(root, 'legacy.gguf');
  writeFileSync(modelPath, 'GGUF');

  // The store as an older build wrote it: architecture and context kept, no file type at all.
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(
    join(root, 'state', 'hub-downloads.json'),
    JSON.stringify({
      version: 1,
      downloads: [
        {
          id: 'legacy',
          repoId: REPO,
          revision: REVISION,
          variantKey: 'legacy.gguf',
          label: 'IQ3_K',
          role: 'model',
          files: [],
          bytesTotal: 1,
          bytesDone: 1,
          state: 'ready',
          phase: null,
          error: null,
          root: join(root, 'cache'),
          createdAt: 1,
          startedAt: 1,
          finishedAt: 2,
          path: modelPath,
          architecture: 'qwen2',
          contextLength: 131072,
          modelId: 'legacy',
          registrations: [],
        },
      ],
    })
  );

  let reads = 0;
  const first = manager(root, server, {
    inspect: async () => {
      reads += 1;
      return { architecture: 'qwen2', contextLength: 131072, fileType: 139 };
    },
  });
  first.downloads.load();
  assert.equal(first.downloads.find('legacy')!.fileType, undefined, 'nothing is known about it yet');

  await first.downloads.fillMissingFacts();
  assert.equal(first.downloads.find('legacy')!.fileType, 139);
  assert.equal(reads, 1);
  first.downloads.shutdown();

  // Settled and persisted: the next launch reads the store, not the file.
  const second = manager(root, server, {
    inspect: async () => {
      reads += 1;
      return { architecture: null, contextLength: null, fileType: null };
    },
  });
  second.downloads.load();
  await second.downloads.fillMissingFacts();
  assert.equal(reads, 1, 'the header is not re-read on every launch');
  assert.equal(second.downloads.find('legacy')!.fileType, 139);
  second.downloads.shutdown();
});

test('a ready download whose file has gone is no longer ready, and is taken out of the engines', async (t) => {
  const server = await fixture(new Map([['m-Q4_K_M.gguf', randomBytes(1024)]]));
  t.after(() => server.close());
  const root = workspace(t);
  const alive = join(root, 'alive.gguf');
  const gone = join(root, 'gone.gguf');
  writeFileSync(alive, 'GGUF');
  writeFileSync(gone, 'GGUF');

  const record = (id: string, path: string) => ({
    id, repoId: REPO, revision: REVISION, variantKey: `${id}.gguf`, label: 'Q4_K_M', role: 'model',
    files: [{ path: `${id}.gguf`, size: 4, sha256: 'x', done: true }],
    bytesTotal: 4, bytesDone: 4, state: 'ready', phase: null, error: null, root: join(root, 'cache'),
    createdAt: 1, startedAt: 1, finishedAt: 2, path, architecture: 'qwen3moe', contextLength: 4096,
    fileType: 15, modelId: id, registrations: [],
  });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(
    join(root, 'state', 'hub-downloads.json'),
    JSON.stringify({ version: 1, downloads: [record('alive', alive), record('gone', gone)] })
  );

  // The file disappears after the record said ready — a cleared cache, or a hand-deleted file.
  rmSync(gone);

  const removed: string[] = [];
  const { downloads } = manager(root, server, { onRemove: (r: DownloadRecord) => removed.push(r.id) });
  downloads.load();
  await downloads.fillMissingFacts();

  const dead = downloads.find('gone')!;
  assert.equal(dead.state, 'failed', 'a model whose weights are gone is not ready');
  assert.match(dead.error!, /no longer in the cache/);
  assert.deepEqual(removed, ['gone'], 'and it is pulled back out of every engine');

  // The one still on disk is untouched.
  assert.equal(downloads.find('alive')!.state, 'ready');
  downloads.shutdown();
});
