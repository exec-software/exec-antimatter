import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { classifyHealth, healthDetail, readSourceReadiness, readSourceWithStartup } from '../src/main/sourceReadiness';

const LOADING_BODY = JSON.stringify({
  error: { message: 'Loading model', type: 'unavailable_error', code: 503 },
});

test('only llama.cpp\'s own loading phrasing closes the composer', () => {
  assert.deepEqual(classifyHealth(503, LOADING_BODY), { state: 'loading', detail: 'Loading model' });
});

test('a bare 503 is not treated as loading', () => {
  // A crashed worker, a proxy with no upstream and a rate limiter all answer 503. Blocking on
  // those would trap someone inside the app they opened to go and fix the thing that is down.
  assert.equal(classifyHealth(503, JSON.stringify({ error: { message: 'no healthy upstream' } })).state, 'unknown');
  assert.equal(classifyHealth(503, '').state, 'unknown');
});

test('a source that serves no /health never blocks', () => {
  // OpenAI, Anthropic and beholdd have no such endpoint. `unknown` is what keeps the gate open.
  for (const status of [404, 405, 501]) {
    assert.equal(classifyHealth(status, 'Not Found').state, 'unknown', `status ${status}`);
  }
});

test('a healthy server is ready and an erroring one is merely unknown', () => {
  assert.deepEqual(classifyHealth(200, JSON.stringify({ status: 'ok' })), { state: 'ready' });
  assert.equal(classifyHealth(500, 'boom').state, 'unknown');
  assert.equal(classifyHealth(401, JSON.stringify({ error: { message: 'bad key' } })).state, 'unknown');
});

test('the detail is the server\'s own words, from either envelope shape', () => {
  assert.equal(healthDetail(LOADING_BODY), 'Loading model');
  assert.equal(healthDetail(JSON.stringify({ message: 'Loading model' })), 'Loading model');
  assert.equal(healthDetail('Loading model'), 'Loading model');
  assert.equal(healthDetail('   '), undefined);
});

test('reads a live server, including the /v1 to root rewrite', async () => {
  const seen: string[] = [];
  const server = await listen((url, res) => {
    seen.push(url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  try {
    const port = (server.address() as { port: number }).port;
    // Sources are configured with the /v1 base the chat API uses; /health is at the root.
    const readiness = await readSourceReadiness({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '' });
    assert.deepEqual(readiness, { state: 'ready' });
    assert.deepEqual(seen, ['/health']);
  } finally {
    server.close();
  }
});

test('reads a loading server as loading', async () => {
  const server = await listen((_url, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(LOADING_BODY);
  });
  try {
    const port = (server.address() as { port: number }).port;
    const readiness = await readSourceReadiness({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '' });
    assert.equal(readiness.state, 'loading');
    assert.equal(readiness.detail, 'Loading model');
  } finally {
    server.close();
  }
});

test('a refused connection is unreachable, not loading', async () => {
  // Bind to get a port the kernel says is free, then release it, so the connection is refused
  // rather than hanging. A low reserved port would not do: fetch rejects those as "bad port"
  // before it ever opens a socket, which is not the failure being tested.
  const server = await listen((_url, res) => res.end());
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const readiness = await readSourceReadiness({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '' }, 2_000);
  assert.equal(readiness.state, 'unreachable');
});

test('an unparseable base URL does not block', async () => {
  const readiness = await readSourceReadiness({ baseUrl: 'not a url', apiKey: '' });
  assert.equal(readiness.state, 'unknown');
});

test('only an unreachable source consults its authoritative startup owner; loading remains protected', async () => {
  const source = { baseUrl: 'http://127.0.0.1:8086/v1', apiKey: '' };
  for (const state of ['ready', 'loading', 'unknown'] as const) {
    assert.equal((await readSourceWithStartup(source, () => { throw new Error('must not override live status'); }, async () => ({ state }))).state, state);
  }
  assert.equal((await readSourceWithStartup(source, () => ({ state: 'startable' }), async () => ({ state: 'unreachable' }))).state, 'startable');
  assert.deepEqual(await readSourceWithStartup(source, () => { throw new Error('Runtime is not installed.'); }, async () => ({ state: 'unreachable' })),
    { state: 'unreachable', detail: 'Runtime is not installed.' });
});

test('a health body that stalls after headers cannot leave a readiness poll pending', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { status: 200 });
  const result = await Promise.race([
    readSourceReadiness({ baseUrl: 'http://127.0.0.1:8086/v1', apiKey: '' }, 15),
    new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Readiness poll stalled')), 1000); timer.unref(); }),
  ]);
  assert.equal(result.state, 'unknown'); assert.equal(cancelled, true);
});

function listen(handler: (url: string, res: import('node:http').ServerResponse) => void): Promise<Server> {
  const server = createServer((req, res) => handler(req.url ?? '', res));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
