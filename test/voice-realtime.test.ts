import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ProviderConfig } from '../src/api/types';
import { discoverLocalTranscriptionSource, MAX_REALTIME_PCM_BYTES, RealtimeTranscription, realtimeVoiceUrl,
  type RealtimeTranscriptionEvent } from '../src/main/voice/realtime';

const source: ProviderConfig = { id: 'asr', name: 'ASR', baseUrl: 'http://127.0.0.1:13305/api/v1', apiKey: '', models: [], supportsStreaming: true };
const pcm = Buffer.alloc(3200).toString('base64');
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const message = (socket: WebSocket, payload: unknown) => socket.send(JSON.stringify(payload));
async function server<T>(work: (config: ProviderConfig, service: WebSocketServer) => Promise<T>): Promise<T> {
  const service = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(service, 'listening');
  const address = service.address(); assert.ok(typeof address === 'object');
  try { return await work({ ...source, baseUrl: `http://127.0.0.1:${address.port}/api/v1` }, service); }
  finally { for (const socket of service.clients) socket.terminate(); await new Promise<void>((resolve) => service.close(() => resolve())); }
}

test('realtime URL protects credentials and requires explicit remote TLS consent', () => {
  const url = realtimeVoiceUrl({ ...source, apiKey: 'key & secret' }, 'Moonshine Small');
  assert.equal(url.pathname, '/api/v1/realtime'); assert.equal(url.protocol, 'ws:');
  assert.equal(url.searchParams.get('model'), 'Moonshine Small'); assert.equal(url.searchParams.get('api_key'), 'key & secret');
  for (const baseUrl of ['http://remote.test/v1', 'https://remote.test/v1', 'http://key@localhost/v1', 'file:///tmp', 'http://localhost/v1?q=1', 'http://localhost/v1#fragment']) {
    assert.throws(() => realtimeVoiceUrl({ ...source, baseUrl }, 'moonshine'));
  }
  assert.throws(() => realtimeVoiceUrl({ ...source, baseUrl: 'http://remote.test/v1' }, 'moonshine', true), /HTTPS/);
  assert.equal(realtimeVoiceUrl({ ...source, baseUrl: 'https://remote.test/v1' }, 'moonshine', true).protocol, 'wss:');
  assert.throws(() => realtimeVoiceUrl(source, 'bad\nmodel'), /model/);
});

test('stream replaces interim hypotheses, gives id-less lines stable ids, and emits each final once', async () => server(async (config, service) => {
  const client = new RealtimeTranscription(); const events: RealtimeTranscriptionEvent[] = []; const received: Record<string, unknown>[] = [];
  let peer!: WebSocket;
  service.on('connection', (socket) => { peer = socket; socket.on('message', (raw) => {
    const payload = JSON.parse(raw.toString()); received.push(payload);
    if (payload.type === 'session.update') message(socket, { type: 'session.updated' });
  }); });
  try {
    await client.start('voice-1', config, 'Moonshine-Small-Streaming', { onEvent: (event) => events.push(event) });
    client.append('voice-1', pcm); await tick();
    assert.equal(received[0].type, 'session.update'); assert.equal(received[1].audio, pcm);
    message(peer, { type: 'input_audio_buffer.speech_started' });
    message(peer, { type: 'conversation.item.input_audio_transcription.delta', delta: 'Open set' });
    message(peer, { type: 'conversation.item.input_audio_transcription.delta', delta: 'Open settings' });
    message(peer, { type: 'input_audio_buffer.speech_stopped' });
    message(peer, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Open settings.' });
    message(peer, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Open settings.' });
    await tick();
    const parts = events.filter((event) => event.type === 'partial');
    assert.deepEqual(parts.map((event) => event.text), ['Open set', 'Open settings']);
    const finals = events.filter((event) => event.type === 'final'); assert.equal(finals.length, 1);
    assert.equal(parts[0].itemId, finals[0].itemId); assert.equal(finals[0].sessionId, 'voice-1');
    // Both lines can be decoded from audio already queued before the first final.
    // No new append is required to keep accepting a valid subsequent line.
    message(peer, { type: 'input_audio_buffer.speech_started', item_id: 'second' });
    message(peer, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'second', transcript: 'Now run tests.' });
    message(peer, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'second', transcript: 'Now run tests.' });
    await tick(); assert.equal(events.filter((event) => event.type === 'final').length, 2);
  } finally { client.stop(); await client.waitUntilClosed(); }
}));

test('backpressure rejects clear and commit promises without a synchronous orphan rejection', async () => server(async (config, service) => {
  service.on('connection', (socket) => socket.on('message', (raw) => {
    if (JSON.parse(raw.toString()).type === 'session.update') message(socket, { type: 'session.updated' });
  }));
  for (const operation of ['clear', 'commit'] as const) {
    const client = new RealtimeTranscription();
    await client.start(operation, config, 'moonshine', { onEvent() {} }); client.append(operation, pcm);
    const connection = (client as unknown as { connection: { socket: WebSocket } }).connection;
    Object.defineProperty(connection.socket, 'bufferedAmount', { value: 256 * 1024 + 1 });
    let pending!: Promise<void>;
    assert.doesNotThrow(() => { pending = client[operation](operation); });
    await assert.rejects(pending, /cancelled/);
    await client.waitUntilClosed();
  }
}));

test('clear waits for acknowledgement and discards stale partial/final results', async () => server(async (config, service) => {
  const client = new RealtimeTranscription(); const events: RealtimeTranscriptionEvent[] = []; let peer!: WebSocket;
  service.on('connection', (socket) => { peer = socket; socket.on('message', (raw) => {
    if (JSON.parse(raw.toString()).type === 'session.update') message(socket, { type: 'session.updated' });
  }); });
  try {
    await client.start('voice-2', config, 'moonshine', { onEvent: (event) => events.push(event) });
    client.append('voice-2', pcm);
    message(peer, { type: 'input_audio_buffer.speech_started', item_id: 'discard' }); await tick();
    let cleared = false; const clearing = client.clear('voice-2').then(() => { cleared = true; });
    message(peer, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'discard', transcript: 'Do not send.' });
    await tick(); assert.equal(cleared, false); assert.equal(events.filter((event) => event.type === 'final').length, 0);
    message(peer, { type: 'input_audio_buffer.cleared' }); await clearing;
    client.append('voice-2', pcm);
    message(peer, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'discard', transcript: 'Still stale.' });
    message(peer, { type: 'input_audio_buffer.speech_started', item_id: 'fresh' });
    message(peer, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'fresh', transcript: 'Fresh words.' });
    await tick(); assert.deepEqual(events.filter((event) => event.type === 'final').map((event) => event.text), ['Fresh words.']);
  } finally { client.stop(); }
}));

test('commit acknowledgement never closes an utterance before its pending final arrives', async () => server(async (config, service) => {
  const client = new RealtimeTranscription(); const events: RealtimeTranscriptionEvent[] = []; let peer!: WebSocket;
  service.on('connection', (socket) => { peer = socket; socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'session.update') message(socket, { type: 'session.updated' });
    if (event.type === 'input_audio_buffer.commit') message(socket, { type: 'input_audio_buffer.committed' });
  }); });
  try {
    await client.start('flush', config, 'moonshine', { onEvent: (event) => events.push(event) });
    client.append('flush', pcm);
    message(peer, { type: 'input_audio_buffer.speech_started' });
    message(peer, { type: 'conversation.item.input_audio_transcription.delta', delta: 'Run four' }); await tick();
    let finished = false; const flushed = client.commit('flush').then(() => { finished = true; });
    await tick(); assert.equal(finished, false, 'ACK only is not a completed active transcript');
    message(peer, { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Run four agents.' });
    await flushed;
    assert.equal(events.at(-1)?.text, 'Run four agents.');
    assert.equal(events.at(-1)?.type, 'final', 'final callback precedes commit promise resolution');
    await client.commit('flush'); // already-finalized or silence-only buffer acknowledges without inventing words
  } finally { client.stop(); }
}));

test('stale sessions cannot send, clear, or stop a replacement and chunks remain bounded', async () => server(async (config, service) => {
  service.on('connection', (socket) => socket.on('message', (raw) => {
    if (JSON.parse(raw.toString()).type === 'session.update') message(socket, { type: 'session.updated' });
  }));
  const client = new RealtimeTranscription();
  try {
    await client.start('old', config, 'moonshine', { onEvent() {} });
    const oldDone = client.waitUntilClosed();
    await client.start('new', config, 'moonshine', { onEvent() {} }); await oldDone;
    client.stop('old'); assert.doesNotThrow(() => client.append('new', pcm));
    assert.throws(() => client.append('old', pcm), /not active/); assert.throws(() => client.clear('old'), /not active/);
    for (const invalid of ['', 'abc', 'A===', Buffer.alloc(3).toString('base64'), Buffer.alloc(MAX_REALTIME_PCM_BYTES + 2).toString('base64')]) {
      assert.throws(() => client.append('new', invalid), /audio/);
    }
    const done = client.waitUntilClosed(); client.stop('new'); await done;
    assert.throws(() => client.commit('new'), /not active/);
  } finally { client.stop(); }
}));

test('connection readiness has a deadline and server errors never echo credentials', async () => server(async (config, service) => {
  const client = new RealtimeTranscription(); const events: RealtimeTranscriptionEvent[] = [];
  await assert.rejects(client.start('timeout', config, 'moonshine', { timeoutMs: 30, onEvent: (event) => events.push(event) }), /ready in time/);
  service.on('connection', (socket) => socket.on('message', () => message(socket, { type: 'error', error: { message: 'secret-api-key and raw audio' } })));
  await assert.rejects(client.start('error', { ...config, apiKey: 'secret-api-key' }, 'moonshine', { onEvent: (event) => events.push(event) }), /reported an error/);
  assert.doesNotMatch(JSON.stringify(events), /secret-api-key|raw audio/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.start('aborted', config, 'moonshine', { signal: abort.signal, onEvent() {} }), /cancelled/);
  client.stop();
}));

test('live transcription discovery advertises only downloaded streaming models', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [
    { id: 'Moonshine-Small-Streaming', downloaded: true, labels: ['transcription', 'realtime-transcription'] },
    { id: 'Moonshine-Medium-Streaming', downloaded: false, labels: ['realtime-transcription'] },
    { id: 'qwen-omni', downloaded: true, labels: ['audio'] },
  ] }));
  try {
    const discovered = await discoverLocalTranscriptionSource();
    assert.equal(discovered?.id, 'antimatter.local-transcription');
    assert.deepEqual(discovered?.models.map((model) => model.id), ['Moonshine-Small-Streaming']);
    assert.equal(discovered?.apiKey, '');
  } finally { globalThis.fetch = original; }
});
