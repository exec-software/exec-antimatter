import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderConfig } from '../src/api/types';
import { synthesizeVoiceStream, VoiceBackendError } from '../src/main/voice/backend';
import { MAX_STREAM_SPEECH_BYTES, SpeechDecodeError, SpeechStreamDecoder, type SpeechPcmChunk } from '../src/main/voice/speechStream';

const source: ProviderConfig = { id: 'speech', name: 'Speech', baseUrl: 'http://127.0.0.1:13305/api/v1', models: [], supportsStreaming: false };
const wav = (samples: number[], floating = false, streaming = false): Buffer => {
  const width = floating ? 4 : 2; const result = Buffer.alloc(44 + samples.length * width);
  result.write('RIFF'); result.writeUInt32LE(streaming ? 0xffffffff : result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(floating ? 3 : 1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(24000, 24); result.writeUInt32LE(24000 * width, 28); result.writeUInt16LE(width, 32); result.writeUInt16LE(width * 8, 34);
  result.write('data', 36); result.writeUInt32LE(streaming ? 0xffffffff : samples.length * width, 40);
  samples.forEach((sample, i) => floating ? result.writeFloatLE(sample, 44 + i * width) : result.writeInt16LE(sample, 44 + i * width));
  return result;
};
const samples = (chunks: SpeechPcmChunk[]): number[] => {
  const b = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.audioBase64, 'base64')));
  return Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));
};
const rawHeaders = () => new Headers({ 'content-type': 'audio/l16;rate=24000;endianness=little-endian' });
async function withFetch<T>(mock: typeof fetch, body: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch; globalThis.fetch = mock;
  try { return await body(); } finally { globalThis.fetch = previous; }
}

test('incremental PCM preserves fragmented frames and network byte order', () => {
  for (const bigEndian of [false, true]) {
    const decoder = new SpeechStreamDecoder(bigEndian ? new Headers({ 'content-type': 'audio/L16;rate=24000' }) : rawHeaders());
    const bytes = Buffer.alloc(6); [123, -456, 32767].forEach((n, i) => bigEndian ? bytes.writeInt16BE(n, i * 2) : bytes.writeInt16LE(n, i * 2));
    const chunks = [...decoder.push(bytes.subarray(0, 1)), ...decoder.push(bytes.subarray(1, 5)), ...decoder.push(bytes.subarray(5))];
    assert.deepEqual(samples(chunks), [123, -456, 32767]);
    assert.deepEqual(decoder.finish(), { sampleRate: 24000, channels: 1, frames: 3 });
  }
});

test('stereo sources downmix complete frames to the mono renderer contract', () => {
  for (const raw of [false, true]) {
    const decoder = new SpeechStreamDecoder(raw
      ? new Headers({ 'content-type': 'audio/l16;rate=24000;channels=2;endianness=little-endian' }) : new Headers());
    const bytes = wav([100, 300, -200, 200]);
    bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(4, 32);
    const payload = raw ? bytes.subarray(44) : bytes;
    const chunks = [...decoder.push(payload.subarray(0, payload.length - 3)), ...decoder.push(payload.subarray(payload.length - 3))];
    assert.deepEqual(samples(chunks), [200, 0]); assert.ok(chunks.every((chunk) => chunk.channels === 1));
    assert.deepEqual(decoder.finish(), { sampleRate: 24000, channels: 1, frames: 2 });
  }
});

test('WAV headers split at every byte decode before EOF, including Kokoro unknown sizes', () => {
  for (const floating of [false, true]) for (const streaming of [false, true]) {
    const decoder = new SpeechStreamDecoder(new Headers({ 'content-type': 'audio/wav' }));
    const bytes = wav(floating ? [0.5, -1, 0] : [123, -456, 0], floating, streaming); const chunks: SpeechPcmChunk[] = [];
    for (const byte of bytes) chunks.push(...decoder.push(new Uint8Array([byte])));
    assert.deepEqual(samples(chunks), floating ? [16384, -32768, 0] : [123, -456, 0]);
    assert.equal(decoder.finish().frames, 3);
  }
});

test('speech decoder skips split WAV metadata and emits bounded sample chunks', () => {
  const original = wav(Array(20000).fill(23)); const junk = Buffer.alloc(12); junk.write('JUNK'); junk.writeUInt32LE(3, 4);
  const bytes = Buffer.concat([original.subarray(0, 36), junk, original.subarray(36)]); bytes.writeUInt32LE(bytes.length - 8, 4);
  const decoder = new SpeechStreamDecoder(new Headers()); const chunks: SpeechPcmChunk[] = [];
  for (let start = 0; start < bytes.length; start += 719) chunks.push(...decoder.push(bytes.subarray(start, start + 719)));
  assert.equal(samples(chunks).length, 20000); assert.equal(decoder.finish().frames, 20000);
  assert.ok(chunks.every((chunk) => Buffer.from(chunk.audioBase64, 'base64').length <= 8192 * 2));
});

test('speech decoder rejects truncated, empty, non-finite and oversized streams', () => {
  for (const bytes of [wav([1]).subarray(0, 43), wav([1]).subarray(0, 45), wav([]), wav([NaN], true), wav([Infinity], true)]) {
    const decoder = new SpeechStreamDecoder(new Headers());
    assert.throws(() => { decoder.push(bytes); decoder.finish(); }, SpeechDecodeError);
  }
  const raw = new SpeechStreamDecoder(rawHeaders()); raw.push(new Uint8Array([0])); assert.throws(() => raw.finish(), /truncated/);
  assert.throws(() => new SpeechStreamDecoder(new Headers({ 'content-type': 'application/json' })), /PCM or WAV/);
  assert.throws(() => new SpeechStreamDecoder(new Headers({ 'content-length': String(MAX_STREAM_SPEECH_BYTES + 1) })), /24 MiB/);
  assert.throws(() => new SpeechStreamDecoder(new Headers({ 'content-type': 'audio/l16;rate=abc' })), /unsupported/);
  assert.throws(() => new SpeechStreamDecoder(new Headers({ 'content-type': 'audio/l16;rate=96000' })), /unsupported/, 'main and renderer accept the same sample rates');
  const long = new SpeechStreamDecoder(rawHeaders()); assert.throws(() => long.push(new Uint8Array(MAX_STREAM_SPEECH_BYTES + 1)), /24 MiB/);
  const metadata = Buffer.alloc(65537); metadata.write('RIFF'); metadata.writeUInt32LE(0xffffffff, 4); metadata.write('WAVEJUNK', 8); metadata.writeUInt32LE(65517, 16);
  assert.throws(() => new SpeechStreamDecoder(new Headers()).push(metadata), /header exceeded/);
});

test('native Kokoro speech emits a playable chunk while response remains open', async () => {
  let finish!: () => void; let emitted!: () => void;
  const first = new Promise<void>((resolve) => { emitted = resolve; }); const chunks: SpeechPcmChunk[] = [];
  await withFetch(async (url, init) => {
    assert.equal(String(url), `${source.baseUrl}/audio/speech`);
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'kokoro-v1', voice: 'coral', input: 'Hello.', response_format: 'pcm', stream_format: 'audio' });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([10, 0, 20, 0])); finish = () => { controller.enqueue(new Uint8Array([30, 0])); controller.close(); }; } }), { headers: rawHeaders() });
  }, async () => {
    let completed = false;
    const pending = synthesizeVoiceStream(source, 'kokoro-v1', 'coral', 'Hello.', (chunk) => { chunks.push(chunk); emitted(); }).then((result) => { completed = true; return result; });
    await first; assert.equal(completed, false); assert.deepEqual(samples(chunks), [10, 20]);
    finish(); assert.deepEqual(await pending, { model: 'kokoro-v1', sampleRate: 24000, channels: 1, frames: 3 });
  });
});

test('other speech models retain WAV request and stream decoded audio without replay', async () => {
  let calls = 0; const chunks: SpeechPcmChunk[] = [];
  await withFetch(async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body)); assert.equal(body.response_format, 'wav'); assert.equal(body.stream_format, undefined);
    return new Response(wav([0.5, -0.5], true), { headers: { 'content-type': 'audio/wav' } });
  }, async () => { await synthesizeVoiceStream(source, 'other-tts', 'voice', 'Hello.', (chunk) => { chunks.push(chunk); }); });
  assert.equal(calls, 1); assert.deepEqual(samples(chunks), [16384, -16384]);
});

test('streaming speech cancellation stops pending read and prevents later chunks', async () => {
  let cancelCount = 0; const controller = new AbortController(); let received = 0;
  await withFetch(async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array([1, 0])); }, cancel() { cancelCount++; } }), { headers: rawHeaders() }), async () => {
    await assert.rejects(synthesizeVoiceStream(source, 'kokoro-v1', 'coral', 'Hello.', () => { received++; controller.abort(); }, { signal: controller.signal }), (error: unknown) => error instanceof VoiceBackendError && error.code === 'cancelled');
  });
  assert.equal(received, 1); assert.equal(cancelCount, 1);
});

test('streaming speech timeout cancels body and malformed audio fails without completion', async () => {
  let cancelled = 0;
  await withFetch(async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: rawHeaders() }), async () => {
    await assert.rejects(synthesizeVoiceStream(source, 'kokoro-v1', 'coral', 'Hello.', () => undefined, { timeoutMs: 10 }), (error: unknown) => error instanceof VoiceBackendError && error.code === 'timeout');
  });
  assert.equal(cancelled, 1);
  await withFetch(async () => new Response('secret backend text', { headers: { 'content-type': 'application/json' } }), async () => {
    await assert.rejects(synthesizeVoiceStream(source, 'kokoro-v1', 'coral', 'Hello.', () => assert.fail('no audio')), (error: unknown) => error instanceof VoiceBackendError && error.code === 'response' && !error.message.includes('secret'));
  });
});

test('streaming speech deadline also interrupts stalled renderer backpressure', async () => {
  let cancelled = 0; let chunks = 0;
  await withFetch(async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array([1, 0])); }, cancel() { cancelled++; } }), { headers: rawHeaders() }), async () => {
    await assert.rejects(synthesizeVoiceStream(source, 'kokoro-v1', 'coral', 'Hello.', () => { chunks++; return new Promise(() => undefined); }, { timeoutMs: 10 }), (error: unknown) => error instanceof VoiceBackendError && error.code === 'timeout');
  });
  assert.equal(chunks, 1); assert.equal(cancelled, 1);
});
