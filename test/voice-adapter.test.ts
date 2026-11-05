import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceAdapter } from '../renderer/src/lib/voiceAdapter';
import type { VoiceState } from '../src/api/voice';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const state = (id: string): VoiceState => ({ sessionId: id, threadId: 'thread', active: true,
  phase: 'starting', muted: false, speaking: false, error: null });

test('renderer adapter binds one conversation and rejects late transcription after stop', async () => {
  const pending = deferred<string>();
  const ended: string[] = [];
  const api = {
    begin: async (thread: string) => { assert.equal(thread, 'thread'); return state('session-a'); },
    end: async (id: string) => { ended.push(id); },
    transcribe: async (id: string, request: string) => { assert.equal(id, 'session-a'); assert.ok(request); return pending.promise; },
    cancel: async () => {},
  } as unknown as Window['electronAPI']['voice'];
  const adapter = createVoiceAdapter('thread', api);
  const signal = new AbortController().signal;
  await adapter.begin!(signal);
  const response = adapter.transcribe({ wavBase64: 'YQ==', sampleRate: 16000 }, signal);
  const rejected = assert.rejects(response, /cancelled/);
  await adapter.end!(); pending.resolve('Must not enter another chat'); await rejected;
  assert.equal(adapter.sessionId(), null); assert.deepEqual(ended, ['session-a']);
});

test('renderer adapter closes a main-process session that finishes starting after stop', async () => {
  const pending = deferred<VoiceState>(); const ended: string[] = [];
  const adapter = createVoiceAdapter('thread', {
    begin: () => pending.promise, end: async (id: string) => { ended.push(id); },
  } as unknown as Window['electronAPI']['voice']);
  const start = adapter.begin!(new AbortController().signal);
  const rejected = assert.rejects(start, /cancelled/);
  await adapter.end!(); pending.resolve(state('late-session')); await rejected;
  assert.equal(adapter.sessionId(), null); assert.deepEqual(ended, ['late-session']);
});

test('playback interruption cancels only its speech request, never chat execution or session', async () => {
  const pending = deferred<{ audioBase64: string; mimeType: string }>();
  const cancelled: string[] = []; let ended = 0;
  const adapter = createVoiceAdapter('thread', {
    begin: async () => state('session-a'), end: async () => { ended += 1; },
    synthesize: async () => pending.promise,
    cancel: async (id: string, request: string) => { assert.equal(id, 'session-a'); cancelled.push(request); },
  } as unknown as Window['electronAPI']['voice']);
  await adapter.begin!(new AbortController().signal);
  const abort = new AbortController();
  const response = adapter.synthesize!('Tests passed', abort.signal);
  const rejected = assert.rejects(response, /cancelled/);
  abort.abort(); pending.resolve({ audioBase64: 'YQ==', mimeType: 'audio/wav' }); await rejected;
  assert.equal(cancelled.length, 1); assert.equal(ended, 0); assert.equal(adapter.sessionId(), 'session-a');
});

test('PCM adapter subscribes before synthesis, yields immediately, and acknowledges only consumed chunks', async () => {
  const complete = deferred<void>(); const acknowledgements: number[] = [];
  let listener!: (event: import('../src/api/voice').VoiceSpeechChunkEvent) => void;
  let request = ''; let unsubscribed = 0;
  const emit = (sequence: number) => listener({ sessionId: 'session-a', requestId: request, sequence,
    chunk: { audioBase64: 'AQACAA==', sampleRate: 24000, channels: 1, format: 'pcm16le' } });
  const adapter = createVoiceAdapter('thread', {
    begin: async () => state('session-a'), end: async () => {}, cancel: async () => {},
    onSpeechChunk: (receive: typeof listener) => { listener = receive; return () => { unsubscribed++; }; },
    synthesizeStream: (_session: string, id: string) => { request = id; emit(0); return complete.promise; },
    acknowledgeSpeechChunk: async (_session: string, _request: string, sequence: number) => {
      acknowledgements.push(sequence); if (sequence === 0) emit(1); else complete.resolve();
    },
  } as unknown as Window['electronAPI']['voice']);
  await adapter.begin!(new AbortController().signal);
  const stream = adapter.synthesizeStream!('Two chunks', new AbortController().signal)[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value.audioBase64, 'AQACAA=='); assert.deepEqual(acknowledgements, []);
  assert.equal((await stream.next()).value.sampleRate, 24000); assert.deepEqual(acknowledgements, [0]);
  assert.equal((await stream.next()).done, true); assert.deepEqual(acknowledgements, [0, 1]); assert.equal(unsubscribed, 1);
});

test('PCM cancellation wakes a waiting consumer and removes its event subscription', async () => {
  let cancelled = 0; let removed = 0;
  const complete = deferred<void>();
  const adapter = createVoiceAdapter('thread', {
    begin: async () => state('session-a'), end: async () => {},
    onSpeechChunk: () => () => { removed++; }, synthesizeStream: () => complete.promise,
    acknowledgeSpeechChunk: async () => {}, cancel: async () => { cancelled++; complete.resolve(); },
  } as unknown as Window['electronAPI']['voice']);
  await adapter.begin!(new AbortController().signal);
  const abort = new AbortController(); const stream = adapter.synthesizeStream!('Waiting', abort.signal)[Symbol.asyncIterator]();
  const next = stream.next(); const rejected = assert.rejects(next, /cancelled/);
  abort.abort(); await rejected; assert.equal(cancelled, 1); assert.equal(removed, 1);
});

test('realtime transcription binds events to its session and request and closes the listener on end', async () => {
  let listener!: (event: import('../src/api/voice').VoiceTranscriptionEvent) => void;
  let request = ''; let removed = 0; let cancelled = 0; const text: string[] = [];
  const adapter = createVoiceAdapter('thread', {
    begin: async () => state('session-a'), end: async () => {}, cancel: async () => { cancelled++; },
    onTranscription: (receive: typeof listener) => { listener = receive; return () => { removed++; }; },
    beginTranscription: async (_session: string, id: string) => { request = id; return { active: true }; },
    appendTranscription: async () => {}, commitTranscription: async () => {}, clearTranscription: async () => {},
  } as unknown as Window['electronAPI']['voice']);
  await adapter.begin!(new AbortController().signal);
  const live = await adapter.beginTranscription!(new AbortController().signal, (event) => text.push(event.text ?? ''));
  assert.ok(live);
  listener({ sessionId: 'another-session', requestId: request, type: 'partial', text: 'Private other session' });
  listener({ sessionId: 'session-a', requestId: request, type: 'partial', text: 'Current words' });
  await adapter.end!(); listener({ sessionId: 'session-a', requestId: request, type: 'final', text: 'Late words' });
  assert.deepEqual(text, ['Current words']); assert.equal(removed, 1); assert.equal(cancelled, 1);
});
