import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OpenAICompatibleProvider } from '../src/api/providers/openai';
import type { ChatRequest, ProviderConfig } from '../src/api/types';
import * as profiles from '../src/main/modelProfiles';
import * as transcripts from '../src/main/transcripts';
import { createLiveProviderHost, hasVisibleCount, validateLiveBaseUrl, type LiveFixture, type LiveMode } from './fixtures/hag-conversation-live-host';
import fixture from './fixtures/hag-generated-history.json';
import stopFixture from './fixtures/hag-stop-reuse.json';

// Only this test's ephemeral loopback server is contacted. It returns captured bytes and
// never starts Beholdd, a model, Electron, or any native inference backend.
type Wire = { method: string | undefined; url: string | undefined; body: Record<string, unknown> };
type Reply = (response: ServerResponse, turn: number) => void | Promise<void>;

async function setup(t: TestContext, reply: Reply, onEvent?: (channel: string, payload: any) => void,
  liveFixture: LiveFixture = fixture, mode: LiveMode = 'history') {
  const directory = mkdtempSync(join(tmpdir(), 'hag-live-host-test-'));
  const oldProfiles = profiles.storeLocation(), oldTranscripts = transcripts.location();
  const requests: Wire[] = [], serverErrors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const turn = requests.length;
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: request.method, url: request.url,
        body: body ? JSON.parse(body) : {} });
      await reply(response, turn);
    })().catch((error) => { serverErrors.push(error); response.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const source: ProviderConfig = {
    id: 'hag-live-test', name: 'HAG loopback fixture', kind: 'beholdd', protocol: 'openai-chat',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: '',
    supportsStreaming: true,
    models: [{ id: fixture.turns[0].request.model, name: 'Captured Qwen3 reply' }],
  };
  const events: Array<{ channel: string; payload: any }> = [];
  let host: ReturnType<typeof createLiveProviderHost> | undefined;
  t.after(async () => {
    host?.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    profiles.useConfigPath(oldProfiles);
    transcripts.useRoot(oldTranscripts);
    rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(serverErrors, [], 'the fake server must not fail independently of the client');
  });
  host = createLiveProviderHost(directory, source, liveFixture, (channel, payload) => {
    events.push({ channel, payload });
    onEvent?.(channel, payload);
  }, mode);
  const request = (turn: number, rawParent = fixture.turns[0].response.choices[0].message.content): ChatRequest => ({
    providerId: source.id, model: source.models[0].id, threadId: mode === 'stop-reuse' ? `fresh-thread-${turn}` : 'live-editor-thread',
    requestId: `answer-${turn}`, responseMessageId: `answer-${turn}`, accessMode: 'read', useTools: true,
    messages: mode === 'stop-reuse' ? [{ id: `user-${turn}`, role: 'user',
      content: liveFixture.turns[turn].request.messages.at(-1)!.content }] : [
      { id: 'user-0', role: 'user', content: fixture.turns[0].request.messages.at(-1)!.content },
      ...(turn === 1 ? [
        { id: 'answer-0', role: 'assistant' as const, content: rawParent },
        { id: 'user-1', role: 'user' as const, content: fixture.turns[1].request.messages.at(-1)!.content },
      ] : []),
    ],
  });
  return { host, source, events, requests, request };
}

function jsonReply(response: ServerResponse, turn: number) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(fixture.turns[turn].response));
}

function sseReply(turn: number) {
  const captured = fixture.turns[turn].response;
  const raw = captured.choices[0].message.content;
  const frame = (delta: Record<string, unknown>, finish: string | null = null, usage?: typeof captured.usage) =>
    `data: ${JSON.stringify({ id: captured.id, object: 'chat.completion.chunk', model: captured.model,
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  return frame({ role: 'assistant' }) + frame({ content: raw.slice(0, 3) })
    + frame({ content: raw.slice(3, 14) }) + frame({ content: raw.slice(14) })
    + frame({}, 'stop', captured.usage) + 'data: [DONE]\n\n';
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function stalledSse(t: TestContext) {
  const content = deferred(), closed = deferred();
  const context = await setup(t, (response) => {
    response.once('close', closed.resolve);
    response.setHeader('Content-Type', 'text/event-stream');
    response.flushHeaders();
    // Headers and one usable content delta arrive; the body deliberately never ends.
    // Waiting for the provider callback distinguishes body cancellation from a fetch
    // cancelled before the server answered.
    response.write(sseReply(0).split('\n\n').slice(0, 2).join('\n\n') + '\n\n');
  }, (channel, payload) => {
    if (channel === 'chat:stream-data' && payload.content) content.resolve();
  });
  return { ...context, contentReceived: content.promise, responseClosed: closed.promise };
}

for (const transport of ['json', 'sse'] as const) {
  test(`live host carries two real HTTP ${transport} replies through the production provider and history`,
    { timeout: 10_000 }, async (t) => {
      const context = await setup(t, async (response, turn) => {
        if (transport === 'json') return jsonReply(response, turn);
        response.setHeader('Content-Type', 'text/event-stream');
        response.flushHeaders();
        const bytes = Buffer.from(sseReply(turn));
        // Split both the SSE prefix and JSON across separate socket writes, rather than
        // relying on one complete event per transport chunk.
        for (let start = 0; start < bytes.length; start += 31) {
          response.write(bytes.subarray(start, start + 31));
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        response.end();
      });
      const { host, requests, request, events } = context;
      await host.stream(request(0), 0);
      const firstContent = events.filter((event) => event.channel === 'chat:stream-data'
        && event.payload.id === 'answer-0').map((event) => event.payload.content).join('');
      assert.equal(firstContent, fixture.turns[0].response.choices[0].message.content);
      await host.stream(request(1, firstContent), 1);
      assert.equal(host.idle(), true);
      assert.equal(requests.length, 2);
      assert.equal(host.records.length, 2);
      for (let turn = 0; turn < 2; turn++) {
        const { temperature: _temperature, ...expected } = fixture.turns[turn].request;
        assert.deepEqual(requests[turn], {
          method: 'POST', url: '/v1/chat/completions', body: { ...expected, stream: true },
        });
        const record = host.records[turn];
        assert.equal(record.completed, true);
        assert.equal(record.settled, true);
        assert.equal(record.resumed, turn === 1);
        assert.equal(record.attemptCount, 1);
        assert.equal(record.finishReason, 'stop');
        assert.equal(record.maxTokens, 128);
        assert.deepEqual(record.usage, fixture.turns[turn].response.usage);
        assert.equal(record.contentChunks.join(''), fixture.turns[turn].response.choices[0].message.content);
        assert.equal(record.responseStatus, 200);
        assert.ok(record.contentType);
        assert.match(record.contentType, transport === 'json' ? /application\/json/ : /text\/event-stream/);
        if (transport === 'sse') assert.ok(record.transportFragments > 1, 'the actual response was fragmented');
      }
    });
}

for (const corruption of ['reply', 'usage', 'finish'] as const) {
  test(`live host rejects changed first-turn ${corruption} and prevents a second HTTP request`,
    { timeout: 5_000 }, async (t) => {
      const { host, requests, request } = await setup(t, (response) => {
        const invalid = structuredClone(fixture.turns[0].response);
        if (corruption === 'reply') invalid.choices[0].message.content = 'wrong.';
        if (corruption === 'usage') invalid.usage.prompt_tokens++;
        if (corruption === 'finish') invalid.choices[0].finish_reason = 'length';
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(invalid));
      });
      await assert.rejects(host.stream(request(0), 0));
      assert.equal(host.records[0].completed, false);
      assert.equal(host.idle(), true);
      await assert.rejects(host.stream(request(1), 1));
      assert.equal(requests.length, 1, 'failed parity must close admission before turn two');
    });
}

test('live host rejects a changed outbound prompt before contacting the server', { timeout: 5_000 }, async (t) => {
  const { host, requests, request } = await setup(t, jsonReply);
  const changed = request(0);
  changed.messages[0].content = 'This prompt was never admitted.';
  await assert.rejects(host.stream(changed, 0));
  assert.equal(requests.length, 0);
});

test('live host rejects an output budget changed during provider serialization before fetch delegation',
  { timeout: 5_000 }, async (t) => {
    const original = OpenAICompatibleProvider.prototype.stream;
    t.mock.method(OpenAICompatibleProvider.prototype, 'stream', function (
      this: OpenAICompatibleProvider, ...args: Parameters<typeof original>
    ) {
      const [request, ...rest] = args;
      return original.call(this, { ...request, maxTokens: 129 }, ...rest);
    });
    const { host, requests, request } = await setup(t, jsonReply);
    await assert.rejects(host.stream(request(0), 0));
    assert.equal(requests.length, 0);
    assert.equal(host.records[0].completed, false);
    await assert.rejects(host.stream(request(1), 1));
    assert.equal(requests.length, 0);
  });

test('live host binds the follow-up to the first visible assistant identity', { timeout: 5_000 }, async (t) => {
  const { host, requests, request } = await setup(t, jsonReply);
  await host.stream(request(0), 0);
  const changed = request(1);
  changed.messages[1].id = 'unrelated-answer';
  await assert.rejects(host.stream(changed, 1));
  assert.equal(requests.length, 1);
});

test('live host does not delegate the provider cold-loading retry', { timeout: 5_000 }, async (t) => {
  const { host, requests, request } = await setup(t, (response) => {
    response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' });
    response.end(JSON.stringify({ error: { type: 'model_loading', message: 'Still loading' } }));
  });
  await assert.rejects(host.stream(request(0), 0));
  assert.equal(requests.length, 1, 'the provider may not turn one admitted request into retry traffic');
  await assert.rejects(host.stream(request(1), 1));
  assert.equal(requests.length, 1);
});

for (const status of [302, 307]) {
  test(`live host refuses HTTP ${status} without contacting the redirect target`, { timeout: 5_000 }, async (t) => {
    const { host, requests, request } = await setup(t, (response, turn) => {
      if (turn > 0) return jsonReply(response, 0);
      response.writeHead(status, { Location: '/v1/redirect-target' });
      response.end();
    });
    await assert.rejects(host.stream(request(0), 0));
    assert.equal(host.records[0].completed, false);
    assert.equal(host.records[0].settled, true);
    assert.equal(host.idle(), true);
    await assert.rejects(host.stream(request(1), 1));
    assert.deepEqual(requests.map(({ method, url }) => ({ method, url })),
      [{ method: 'POST', url: '/v1/chat/completions' }]);
  });
}

test('cancelling after live SSE content closes the stalled body and forbids another request',
  { timeout: 5_000 }, async (t) => {
    const { host, requests, request, contentReceived, responseClosed } = await stalledSse(t);
    const rejected = assert.rejects(host.stream(request(0), 0));
    await contentReceived;
    assert.equal(host.records[0].settled, false);
    assert.equal(host.records[0].responseStatus, 200);
    assert.equal(host.cancel('unrelated-turn'), false);
    assert.equal(host.cancel('answer-0'), true);
    await rejected;
    await responseClosed;
    const record = host.records[0];
    assert.equal(record.completed, false);
    assert.equal(record.settled, true);
    assert.equal(record.outcome, 'cancelled');
    assert.equal(record.cancelRequests, 1);
    assert.equal(record.timedOut, false);
    assert.equal(record.transportClosed, true);
    assert.equal(record.attemptCount, 1);
    assert.equal(host.idle(), true);
    assert.equal(host.cancel('answer-0'), false);
    await assert.rejects(host.stream(request(1), 1));
    assert.equal(requests.length, 1);
  });

test('the 240-second live deadline covers a stalled response body after headers and content',
  { timeout: 5_000 }, async (t) => {
    const { host, requests, request, contentReceived, responseClosed } = await stalledSse(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const rejected = assert.rejects(host.stream(request(0), 0));
    await contentReceived;
    const record = host.records[0];
    assert.equal(record.deadlineMs, 240_000);
    assert.equal(record.responseStatus, 200);
    assert.equal(record.settled, false);
    t.mock.timers.tick(239_999);
    assert.equal(record.timedOut, false);
    assert.equal(record.settled, false);
    t.mock.timers.tick(1);
    assert.equal(record.timedOut, true);
    await rejected;
    await responseClosed;
    t.mock.timers.reset();
    assert.equal(record.completed, false);
    assert.equal(record.settled, true);
    assert.equal(record.outcome, 'error');
    assert.equal(record.cancelRequests, 0);
    assert.equal(record.transportClosed, true);
    assert.equal(record.attemptCount, 1);
    assert.equal(host.idle(), true);
    await assert.rejects(host.stream(request(1), 1));
    assert.equal(requests.length, 1);
  });

test('live host bounds raw HTTP evidence before accepting or persisting a reply', { timeout: 5_000 }, async (t) => {
  const { host, requests, request } = await setup(t, (response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ...fixture.turns[0].response, padding: ' '.repeat(1024 * 1024) }));
  });
  await assert.rejects(host.stream(request(0), 0), /bound|limit|bytes|large|exceed/i);
  assert.equal(host.records[0].completed, false);
  assert.equal(host.idle(), true);
  await assert.rejects(host.stream(request(1), 1));
  assert.equal(requests.length, 1);
});

test('live host admits only the exact explicit loopback endpoint shape', () => {
  assert.equal(validateLiveBaseUrl('http://127.0.0.1:31877/v1'), 'http://127.0.0.1:31877/v1');
  for (const invalid of [
    'http://127.0.0.1/v1', 'http://127.0.0.1:0/v1', 'http://127.0.0.1:65536/v1',
    'http://localhost:31877/v1', 'http://[::1]:31877/v1', 'http://127.1:31877/v1',
    'https://127.0.0.1:31877/v1', 'http://192.0.2.189:31877/v1',
    'http://user:secret@127.0.0.1:31877/v1', 'http://127.0.0.1:31877/v1/',
    'http://127.0.0.1:31877/v1?extra=1', 'http://127.0.0.1:31877/v1#fragment',
  ]) assert.throws(() => validateLiveBaseUrl(invalid), undefined, invalid);
});


function stopPrefix(content = '<think>\n\n</think>\n\n1 2') {
  const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'stopped-reply', object: 'chat.completion.chunk',
      model: stopFixture.turns[0].request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return frame({ role: 'assistant' }) + frame({ content });
}

async function stopContext(t: TestContext, prefix = stopPrefix()) {
  const content = deferred(), closed = deferred();
  const context = await setup(t, (response, turn) => {
    response.setHeader('Content-Type', 'text/event-stream');
    if (turn === 1) { response.end(sseReply(0)); return; }
    response.once('close', closed.resolve);
    response.flushHeaders();
    response.write(prefix);
  }, (channel, payload) => {
    if (channel === 'chat:stream-data' && hasVisibleCount(payload.content)) content.resolve();
  }, stopFixture, 'stop-reuse');
  return { ...context, contentReceived: content.promise, responseClosed: closed.promise };
}

test('explicit live Stop/reuse closes a real socket after numeric content then admits a fresh conversation',
  { timeout: 5_000 }, async (t) => {
    const { host, request, requests, events, contentReceived, responseClosed } = await stopContext(t);
    const stopped = host.stream(request(0), 0);
    await contentReceived;
    assert.equal(host.cancel('unrelated'), false);
    assert.equal(host.records[0].settled, false);
    assert.equal(host.cancel('answer-0'), true);
    assert.equal(host.cancel('answer-0'), false, 'a repeated Stop must not count twice');
    await stopped;
    await responseClosed;
    const first = host.records[0];
    assert.equal(first.completed, false);
    assert.equal(first.outcome, 'cancelled');
    assert.equal(first.cancelRequests, 1);
    assert.equal(first.abortObserved, true);
    assert.equal(first.abortListenerRemoved, true);
    assert.equal(first.transportClosed, true);
    assert.equal(first.responseEof, false);
    assert.equal(first.timedOut, false);
    assert.ok(first.checkpointed > 0);
    assert.equal(first.result, null);
    assert.ok(first.firstContentAt! <= first.cancelRequestedAt!);
    assert.ok(first.cancelRequestedAt! <= first.abortObservedAt!);
    assert.ok(first.abortObservedAt! <= first.transportClosedAt!);
    assert.ok(first.transportClosedAt! <= first.settledAt!);
    assert.equal(events.filter((event) => event.channel === 'chat:stream-data').at(-1)!.payload.content, '\n\n_Stopped._');
    assert.equal(host.idle(), true);
    await host.stream(request(1), 1);
    assert.equal(host.records[1].resumed, false);
    assert.equal(host.records[1].completed, true);
    assert.equal(host.records[1].outcome, 'finished');
    assert.equal(host.records[1].result!.content, stopFixture.turns[1].response!.choices[0].message.content);
    assert.deepEqual(requests.map((wire) => wire.body), stopFixture.turns.map((turn) => turn.request));
    assert.deepEqual(host.records.map((record) => [record.maxTokens, record.attemptCount, record.providerCalls]),
      [[64, 1, 1], [16, 1, 1]]);
    await assert.rejects(host.stream(request(1), 2));
    assert.equal(requests.length, 2);
  });

for (const corruption of ['thread', 'history', 'user-id'] as const) {
  test(`live Stop/reuse rejects reuse with cancelled ${corruption} before another socket opens`,
    { timeout: 5_000 }, async (t) => {
      const { host, request, requests, contentReceived, responseClosed } = await stopContext(t);
      const stopped = host.stream(request(0), 0);
      await contentReceived;
      assert.equal(host.cancel('answer-0'), true);
      await stopped; await responseClosed;
      const changed = request(1);
      if (corruption === 'thread') changed.threadId = request(0).threadId;
      if (corruption === 'history') changed.messages.unshift(...request(0).messages,
        { id: 'answer-0', role: 'assistant', content: '1 2\n\n_Stopped._' });
      if (corruption === 'user-id') changed.messages[0].id = request(0).messages[0].id;
      await assert.rejects(host.stream(changed, 1));
      assert.equal(requests.length, 1);
    });
}

test('live Stop/reuse rejects natural first completion instead of calling it cancellation',
  { timeout: 5_000 }, async (t) => {
    const { host, request, requests } = await setup(t, (response) => {
      response.setHeader('Content-Type', 'text/event-stream'); response.end(sseReply(0));
    }, undefined, stopFixture, 'stop-reuse');
    await assert.rejects(host.stream(request(0), 0), /must not finish normally/);
    assert.equal(host.records[0].outcome, 'error');
    assert.equal(host.cancel('answer-0'), false);
    await assert.rejects(host.stream(request(1), 1));
    assert.equal(requests.length, 1);
  });

test('live Stop/reuse refuses Stop before real numeric answer content', { timeout: 5_000 }, async (t) => {
  const hidden = deferred(), closed = deferred();
  let reply: ServerResponse | undefined;
  const { host, request } = await setup(t, (response) => {
    reply = response; response.once('close', closed.resolve);
    response.setHeader('Content-Type', 'text/event-stream'); response.flushHeaders();
    response.write(stopPrefix('<think>123</think>'));
  }, (channel) => { if (channel === 'chat:stream-data') hidden.resolve(); }, stopFixture, 'stop-reuse');
  const stopped = host.stream(request(0), 0);
  await hidden.promise;
  assert.equal(host.cancel('answer-0'), false);
  assert.equal(host.records[0].cancelRequests, 0);
  // A separate socket write supplies the actual answer; wait for its provider callback.
  reply!.write(stopPrefix('1 2'));
  const end = Date.now() + 1_000;
  while (!hasVisibleCount(host.records[0].contentChunks.join('')) && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(hasVisibleCount(host.records[0].contentChunks.join('')));
  assert.equal(host.cancel('answer-0'), true);
  await stopped; await closed.promise;
});

test('live Stop/reuse rejects a terminal frame in the cancelled prefix', { timeout: 5_000 }, async (t) => {
  const terminal = `data: ${JSON.stringify({ model: stopFixture.turns[0].request.model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
  const { host, request, requests, contentReceived } = await stopContext(t, stopPrefix() + terminal);
  const rejected = assert.rejects(host.stream(request(0), 0), /terminal/);
  await contentReceived;
  assert.equal(host.cancel('answer-0'), true);
  await rejected;
  await assert.rejects(host.stream(request(1), 1));
  assert.equal(requests.length, 1);
});

test('visible Stop admission ignores hidden and unterminated thinking content', () => {
  assert.equal(hasVisibleCount('<think>1 2'), false);
  assert.equal(hasVisibleCount('<think>123</think>'), false);
  assert.equal(hasVisibleCount('<think>123</think>1'), true);
  assert.equal(hasVisibleCount('1 2 3'), true);
});
