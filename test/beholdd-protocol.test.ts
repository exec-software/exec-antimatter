import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { parseNativeBeholddInfo, probeNativeBeholdd } from '../src/main/beholddProtocol';

const native = {
  schema_version: 1, service: 'beholdd', generation: 2, runtime: 'native',
  execution_backends: ['cpu'], architectures: ['qwen3', 'qwen3moe'], model_formats: ['gguf'],
  operations: { unload: true },
};
const unknown = {
  ...native, runtime: 'unknown', execution_backends: [], architectures: [], model_formats: [],
  operations: { unload: false },
};

async function endpoint(t: { after(fn: () => Promise<void>): void }, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

test('native runtime support is explicit and copied, never inferred from the catalog or port', () => {
  const result = parseNativeBeholddInfo(native);
  assert.deepEqual(result, native);
  result!.execution_backends.push('vulkan');
  assert.deepEqual(native.execution_backends, ['cpu']);
  assert.equal(parseNativeBeholddInfo({ object: 'list', data: [] }), null);
  assert.equal(parseNativeBeholddInfo(unknown), null);
  assert.equal(parseNativeBeholddInfo({ ...native, runtime: 'llama.cpp' }), null);
  assert.equal(parseNativeBeholddInfo({ ...native, service: 'other' }), null);
  assert.equal(parseNativeBeholddInfo({ ...native, generation: 1 }), null);
  assert.equal(parseNativeBeholddInfo({ ...native, schema_version: 2 }), null);
});

test('descriptor validation rejects malformed or overlarge capability claims', () => {
  for (const change of [
    { execution_backends: [] }, { execution_backends: ['cpu', 'cpu'] },
    { architectures: 'qwen3' }, { architectures: ['<bad>'] }, { model_formats: [1] },
    { architectures: Array.from({ length: 33 }, (_, i) => `arch${i}`) },
    { operations: { unload: 'true' } }, { operations: null },
  ]) {
    assert.equal(parseNativeBeholddInfo({ ...native, ...change }), null);
  }
  assert.deepEqual(parseNativeBeholddInfo({ ...native, operations: { unload: false } })?.operations, { unload: false });
});

test('native probe is read-only, authenticated, and accepts an empty model-independent runtime', async (t) => {
  const seen: string[] = [];
  const url = await endpoint(t, (request, response) => {
    seen.push(`${request.method} ${request.url}`);
    assert.equal(request.headers.authorization, 'Bearer fixture-secret');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(native));
  });
  assert.deepEqual(await probeNativeBeholdd(`${url}/`, { apiKey: 'fixture-secret' }), native);
  assert.deepEqual(seen, ['GET /v1/beholdd/info']);
});

test('only missing endpoints permit legacy discovery; explicitly unknown runtimes fail closed', async (t) => {
  let status = 404;
  const url = await endpoint(t, (_request, response) => {
    response.statusCode = status;
    response.end(JSON.stringify(unknown));
  });
  assert.equal(await probeNativeBeholdd(url), null);
  status = 501;
  assert.equal(await probeNativeBeholdd(url), null);
  status = 200;
  await assert.rejects(probeNativeBeholdd(url), /has not declared a native runtime/);
  status = 401;
  await assert.rejects(probeNativeBeholdd(url), /HTTP 401/);
  status = 503;
  await assert.rejects(probeNativeBeholdd(url), /HTTP 503/);
});

test('malformed successful descriptors fail closed and never echo response secrets', async (t) => {
  let body = 'fixture-secret';
  const url = await endpoint(t, (_request, response) => response.end(body));
  await assert.rejects(probeNativeBeholdd(url), /not valid JSON/);
  body = JSON.stringify({ object: 'list', data: [] });
  await assert.rejects(probeNativeBeholdd(url), /supported native Beholdd/);
  body = JSON.stringify({ ...unknown, operations: { unload: true } });
  await assert.rejects(probeNativeBeholdd(url), /supported native Beholdd/);
});

test('native probe rejects redirects and oversized bodies even without a content length', async (t) => {
  let mode = 'redirect';
  let destinationCalls = 0;
  const url = await endpoint(t, (request, response) => {
    if (request.url === '/target') { destinationCalls++; response.end('{}'); return; }
    if (mode === 'redirect') {
      response.writeHead(302, { location: '/target' }); response.end();
    } else if (mode === 'declared') {
      response.writeHead(200, { 'content-length': 100_000 }); response.end('x');
    } else {
      response.writeHead(200); response.write('x'.repeat(40_000)); response.end('x'.repeat(40_000));
    }
  });
  await assert.rejects(probeNativeBeholdd(url));
  assert.equal(destinationCalls, 0);
  mode = 'declared';
  await assert.rejects(probeNativeBeholdd(url), /64 KiB/);
  mode = 'chunked';
  await assert.rejects(probeNativeBeholdd(url), /64 KiB/);
});

test('probe deadline covers a stalled response body, not only headers', { timeout: 2_000 }, async (t) => {
  const url = await endpoint(t, (_request, response) => {
    response.writeHead(200); response.write('{');
  });
  await assert.rejects(probeNativeBeholdd(url, { timeoutMs: 50 }), /did not answer in time/);
});

test('probe deadline directly cancels a body even when fetch ignores abort and cleanup never settles', { timeout: 2_000 }, async (t) => {
  let cancelled = false;
  let requestSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    requestSignal = options.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }));
  });
  await assert.rejects(probeNativeBeholdd('http://127.0.0.1/v1', { timeoutMs: 25 }), /did not answer in time/);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(cancelled, true);
});

test('rejected bodies do not wait for transport cancellation to settle', { timeout: 2_000 }, async (t) => {
  let response: Response;
  const stalled = (status: number, headers: Record<string, string> = {}) => new Response(new ReadableStream({
    cancel() { return new Promise<void>(() => {}); },
  }), { status, headers });
  t.mock.method(globalThis, 'fetch', async () => response);
  response = stalled(404);
  assert.equal(await probeNativeBeholdd('http://127.0.0.1/v1'), null);
  response = stalled(503);
  await assert.rejects(probeNativeBeholdd('http://127.0.0.1/v1'), /HTTP 503/);
  response = stalled(200, { 'content-length': '100000' });
  await assert.rejects(probeNativeBeholdd('http://127.0.0.1/v1'), /64 KiB/);
});
