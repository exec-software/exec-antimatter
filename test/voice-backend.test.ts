import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderConfig } from '../src/api/types';
import { discoverLocalSpeechSource, isLocalVoiceSource, MAX_VOICE_AUDIO_BYTES, probeVoiceBackend, synthesizeVoice,
  transcribeVoice, validateVoiceWav, VoiceBackendError } from '../src/main/voice/backend';

const source: ProviderConfig = { id: 'local', name: 'Local audio', baseUrl: 'http://127.0.0.1:6767/v1', apiKey: 'secret-voice-key', models: [], supportsStreaming: true };
const wav = (samples = 160): Uint8Array => {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const transcript = (content: unknown = 'Hello world.') => ({ model: 'qwen-engine-alias', choices: [{ finish_reason: 'stop', message: { content } }] });
async function withFetch<T>(mock: typeof fetch, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch; globalThis.fetch = mock;
  try { return await body(); } finally { globalThis.fetch = original; }
}

test('Qwen chat input_audio is one bounded transcription request with no tools/history and main-only credentials', async () => {
  await withFetch(async (url, init) => {
    assert.equal(String(url), `${source.baseUrl}/chat/completions`);
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret-voice-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'qwen3-omni-30b'); assert.equal(body.stream, false); assert.equal(body.tools, undefined);
    assert.equal(body.messages.length, 2); assert.equal(body.max_tokens, 4096);
    assert.equal(body.chat_template_kwargs.enable_thinking, false); assert.equal(body.reasoning_effort, 'none');
    assert.deepEqual(body.messages[1].content[1], { type: 'input_audio', input_audio: { data: Buffer.from(wav()).toString('base64'), format: 'wav' } });
    return json(transcript());
  }, async () => assert.deepEqual(await transcribeVoice(source, 'qwen3-omni-30b', wav(), { mode: 'chat-audio' }), { text: 'Hello world.', model: 'qwen-engine-alias' }));
});

test('multipart transcription uses the explicitly selected source/model without a second fallback request', async () => {
  let calls = 0;
  await withFetch(async (url, init) => {
    calls++; assert.equal(String(url), `${source.baseUrl}/audio/transcriptions`);
    assert.equal(new Headers(init?.headers).get('content-type'), null, 'fetch must supply the multipart boundary');
    const form = init?.body as FormData;
    assert.equal(form.get('model'), 'whisper-local'); assert.equal(form.get('response_format'), 'json');
    const file = form.get('file') as File;
    assert.equal(file.type, 'audio/wav'); assert.equal(file.name, 'recording.wav');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(wav()));
    return json({ text: 'Good morning.' });
  }, async () => assert.deepEqual(await transcribeVoice(source, 'whisper-local', wav(), { mode: 'transcriptions' }), { text: 'Good morning.', model: 'whisper-local' }));
  assert.equal(calls, 1);
});

test('invalid, huge, long, stereo, compressed, or malformed WAV input never reaches fetch', async () => {
  const stereo = Buffer.from(wav()); stereo.writeUInt16LE(2, 22); stereo.writeUInt32LE(64000, 28); stereo.writeUInt16LE(4, 32);
  const malformed = Buffer.from(wav()); malformed.writeUInt32LE(0xffff, 40);
  const compressed = Buffer.from(wav()); compressed.writeUInt16LE(6, 20);
  const badRate = Buffer.from(wav()); badRate.writeUInt32LE(1, 24); badRate.writeUInt32LE(2, 28);
  await withFetch(async () => { throw new Error('must not send'); }, async () => {
    for (const audio of [new Uint8Array(), new Uint8Array(MAX_VOICE_AUDIO_BYTES + 1), wav(16000 * 121), stereo, malformed, compressed, badRate]) {
      await assert.rejects(transcribeVoice(source, 'qwen', audio, { mode: 'chat-audio' }), (error: unknown) => error instanceof VoiceBackendError && error.code === 'audio');
    }
  });
  assert.doesNotThrow(() => validateVoiceWav(wav()));
});

test('cloud destinations require explicit consent, HTTPS, compatible source, and redirect rejection', async () => {
  let calls = 0;
  await withFetch(async (_url, init) => { calls++; assert.equal(init?.redirect, 'error'); return json(transcript()); }, async () => {
    for (const baseUrl of ['http://example.com/v1', 'https://example.com/v1', 'file:///tmp/audio', 'http://key@localhost/v1', 'http://localhost/v1#token']) {
      await assert.rejects(transcribeVoice({ ...source, baseUrl }, 'qwen', wav(), { mode: 'chat-audio' }), /source|permission|credentials/);
    }
    await assert.rejects(transcribeVoice({ ...source, baseUrl: 'http://example.com/v1' }, 'qwen', wav(), { mode: 'chat-audio', allowRemote: true }), /HTTPS/);
    await assert.rejects(transcribeVoice({ ...source, protocol: 'anthropic-messages' }, 'qwen', wav(), { mode: 'chat-audio' }), /compatible/);
    assert.equal(calls, 0);
    await transcribeVoice({ ...source, baseUrl: 'https://example.com/v1' }, 'qwen', wav(), { mode: 'chat-audio', allowRemote: true });
    assert.equal(calls, 1);
  });
  for (const baseUrl of ['http://127.0.0.2/v1', 'http://[::1]/v1', 'https://localhost/v1']) assert.equal(isLocalVoiceSource({ baseUrl }), true);
  assert.equal(isLocalVoiceSource({ baseUrl: 'https://localhost.evil.example/v1' }), false);
});

test('reasoning, embedded thought, tool calls, truncated output and overlong transcripts are never treated as dictated commands', async () => {
  for (const message of [{ content: '', reasoning_content: 'Maybe user said delete files.' }, { content: '<think>private</think>Hello.' },
    { content: 'okay', tool_calls: [{ function: { name: 'bash' } }] }, { content: 'x'.repeat(16001) }]) {
    await withFetch(async () => json({ choices: [{ message }] }), async () => {
      await assert.rejects(transcribeVoice(source, 'qwen', wav(), { mode: 'chat-audio' }), VoiceBackendError);
    });
  }
  await withFetch(async () => json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }), async () => {
    await assert.rejects(transcribeVoice(source, 'qwen', wav(), { mode: 'chat-audio' }), /shorter clip/);
  });
  await withFetch(async () => json(transcript('')), async () => assert.equal((await transcribeVoice(source, 'qwen', wav(), { mode: 'chat-audio' })).text, ''));
  await withFetch(async () => json(transcript([{ type: 'text', text: 'Hello.' }])), async () => assert.equal((await transcribeVoice(source, 'qwen', wav(), { mode: 'chat-audio' })).text, 'Hello.'));
});

test('errors never echo recorded audio, server diagnostics, endpoint query tokens or credentials', async () => {
  const privateSource = { ...source, baseUrl: `${source.baseUrl}?token=private-query` };
  await withFetch(async () => json({ error: `secret-voice-key private-query ${Buffer.from(wav()).toString('base64')}` }, 500), async () => {
    await assert.rejects(transcribeVoice(privateSource, 'qwen', wav(), { mode: 'chat-audio' }), (error: unknown) => {
      assert.match(String(error), /HTTP 500/); assert.doesNotMatch(String(error), /private-query|secret-voice-key|UklG/); return true;
    });
  });
  await withFetch(async () => { throw new Error('secret-voice-key private-query'); }, async () => {
    await assert.rejects(transcribeVoice(privateSource, 'qwen', wav(), { mode: 'chat-audio' }), (error: unknown) => { assert.doesNotMatch(String(error), /private-query|secret-voice-key/); return true; });
  });
});

test('cancellation and timeout stop fetch and pre-aborted sessions send nothing', async () => {
  let calls = 0;
  const abortable: typeof fetch = async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  await withFetch(abortable, async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(transcribeVoice(source, 'qwen', wav(), { mode: 'chat-audio', signal: controller.signal }), /cancelled/);
    assert.equal(calls, 0);
    await assert.rejects(transcribeVoice(source, 'qwen', wav(), { mode: 'chat-audio', timeoutMs: 10 }), /timed out/);
    const active = new AbortController();
    const running = transcribeVoice(source, 'qwen', wav(), { mode: 'chat-audio', signal: active.signal });
    active.abort(); await assert.rejects(running, /cancelled/);
  });
});

test('response limits reject declared and streaming oversized JSON and cancel the response body', async () => {
  let cancelled = 0;
  for (const declared of [true, false]) {
    await withFetch(async () => new Response(new ReadableStream({ start(controller) { if (!declared) controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { cancelled++; } }),
      { headers: declared ? { 'content-length': String(2 * 1024 * 1024 + 1) } : {} }), async () => {
      await assert.rejects(transcribeVoice(source, 'qwen', wav(), { mode: 'chat-audio' }), /oversized JSON/);
    });
  }
  assert.equal(cancelled, 2);
});

test('TTS uses separate explicit model and voice; returns in-memory WAV without files or playback', async () => {
  await withFetch(async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:13305/api/v1/audio/speech');
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'kokoro-v1', voice: 'coral', input: 'Hello.', response_format: 'wav' });
    assert.equal(init?.redirect, 'error');
    return new Response(wav(), { headers: { 'content-type': 'audio/wav' } });
  }, async () => {
    const result = await synthesizeVoice({ ...source, baseUrl: 'http://127.0.0.1:13305/api/v1' }, 'kokoro-v1', 'coral', 'Hello.');
    assert.deepEqual(Buffer.from(result.audio), Buffer.from(wav())); assert.equal(result.mediaType, 'audio/wav');
  });
});

test('TTS rejects empty/oversized text, nonaudio, invalid WAV, oversized data and missing endpoint', async () => {
  await withFetch(async () => { throw new Error('must not send'); }, async () => {
    for (const text of ['', ' '.repeat(4), 'x'.repeat(4001)]) await assert.rejects(synthesizeVoice(source, 'kokoro', 'coral', text), /characters/);
  });
  for (const response of [new Response('not audio', { headers: { 'content-type': 'application/json' } }),
    new Response('not audio', { headers: { 'content-type': 'audio/wav' } }),
    new Response(wav(), { headers: { 'content-length': String(25 * 1024 * 1024) } }), new Response('', { status: 404 })]) {
    await withFetch(async () => response, async () => await assert.rejects(synthesizeVoice(source, 'kokoro', 'coral', 'Hi.'), VoiceBackendError));
  }
});

test('installed Kokoro float32 streaming WAV is finalized for reliable browser decoding', async () => {
  const streaming = Buffer.from(wav());
  streaming.writeUInt32LE(0xffffffff, 4); streaming.writeUInt32LE(0xffffffff, 40);
  streaming.writeUInt16LE(3, 20); streaming.writeUInt32LE(24000, 24); streaming.writeUInt32LE(96000, 28);
  streaming.writeUInt16LE(4, 32); streaming.writeUInt16LE(32, 34);
  await withFetch(async () => new Response(streaming, { headers: { 'content-type': 'audio/wav' } }), async () => {
    const result = await synthesizeVoice(source, 'kokoro-v1', 'coral', 'Hi.');
    const output = Buffer.from(result.audio);
    assert.equal(output.readUInt32LE(4), output.length - 8); assert.equal(output.readUInt32LE(40), output.length - 44);
    assert.equal(output.readUInt16LE(20), 3); assert.equal(output.readUInt16LE(34), 32);
    assert.deepEqual(output.subarray(44), streaming.subarray(44), 'speech samples must not change');
  });
});

test('read-only capability probe is honest about unknown Qwen audio and missing speech; never loads model', async () => {
  const paths: string[] = [];
  await withFetch(async (url, init) => {
    assert.equal(init?.method ?? 'GET', 'GET'); assert.equal(init?.body, undefined); paths.push(String(url));
    return String(url).endsWith('/models') ? json({ data: [{ id: 'qwen3-omni-30b', loaded: false }] }) : new Response('', { status: 404 });
  }, async () => {
    const result = await probeVoiceBackend(source, 'qwen3-omni-30b', { inputMode: 'chat-audio' });
    assert.equal(result.modelAvailable, true); assert.equal(result.input, 'unknown'); assert.equal(result.speech, 'unsupported'); assert.equal(result.realtime, false);
  });
  assert.deepEqual(paths, [`${source.baseUrl}/models`, `${source.baseUrl}/audio/speech`]);
});

test('capability probe respects advertised input modalities and identifies POST-only speech without claiming generation verified', async () => {
  await withFetch(async (url) => String(url).endsWith('/models') ? json({ data: [{ id: 'omni', input_modalities: ['text', 'audio'] }] }) :
    new Response('', { status: 405, headers: { Allow: 'POST' } }), async () => {
    const result = await probeVoiceBackend(source, 'omni', { inputMode: 'chat-audio' });
    assert.equal(result.input, 'supported'); assert.equal(result.speech, 'available'); assert.match(result.notes.join(' '), /not been verified/);
  });
  await withFetch(async (url) => String(url).endsWith('/models') ? json({ data: [{ id: 'omni', modalities: { audio: true } }] }) :
    new Response('', { status: 404 }), async () => assert.equal((await probeVoiceBackend(source, 'omni', { inputMode: 'transcriptions' })).input, 'unsupported'));
});

test('local Kokoro discovery is fixed, read-only, ephemeral, and requires downloaded:true', async () => {
  for (const downloaded of [true, false, undefined]) {
    await withFetch(async (url, init) => {
      assert.equal(String(url), 'http://127.0.0.1:13305/api/v1/models'); assert.equal(init?.method ?? 'GET', 'GET'); assert.equal(init?.redirect, 'error');
      return json({ data: [{ id: 'kokoro-v1', downloaded }] });
    }, async () => {
      const discovered = await discoverLocalSpeechSource();
      assert.equal(discovered !== null, downloaded === true);
      if (discovered) { assert.equal(discovered.id, 'antimatter.local-speech'); assert.equal(discovered.apiKey, ''); assert.deepEqual(discovered.models.map((model) => model.id), ['kokoro-v1']); }
    });
  }
  await withFetch(async () => { throw new Error('ECONNREFUSED'); }, async () => assert.equal(await discoverLocalSpeechSource(), null));
});
