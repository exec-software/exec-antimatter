import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceController, voiceError } from '../renderer/src/voice/controller';
import { encodeMonoWav, PcmSegmenter, resampleMono } from '../renderer/src/voice/pcm';
import type { VoiceAdapter, VoiceAudioBackend, VoiceMicrophone } from '../renderer/src/voice/types';

const deferred = <T>() => {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let index = 0; index < 64; index++) await Promise.resolve(); };

function fakeAudio() {
  let frame: ((samples: Float32Array, rate: number) => void) | null = null;
  const state = { captures: 0, closes: 0, muted: false, stopped: 0, playbackStops: 0, plays: 0 };
  let finish: (() => void) | null = null;
  const microphone: VoiceMicrophone = { setMuted: (muted) => { state.muted = muted; }, stop: () => { state.stopped += 1; } };
  const backend: VoiceAudioBackend = {
    unlock: async () => undefined,
    capture: async (onFrame) => { state.captures += 1; frame = onFrame; return microphone; },
    play: async (_payload, signal, onLevel) => {
      state.plays += 1; onLevel(0.1);
      await new Promise<void>((resolve) => { finish = resolve; signal.addEventListener('abort', resolve.bind(null), { once: true }); });
      onLevel(0);
    },
    stopPlayback: () => { state.playbackStops += 1; finish?.(); finish = null; },
    close: async () => { state.closes += 1; },
  };
  return { backend, state, microphone, emit: (value = 0.12, count = 1) => { for (let index = 0; index < count; index++) frame?.(new Float32Array(800).fill(value), 16000); } };
}

function manualUtterance(controller: VoiceController, audio: ReturnType<typeof fakeAudio>) {
  controller.beginPushToTalk(); audio.emit(0.12, 5); controller.endPushToTalk();
}

test('WAV output is bounded mono PCM16 at 16 kHz and resampling averages source frames', () => {
  const samples = resampleMono(new Float32Array([1, 1, 1, -1, -1, -1]), 48000);
  assert.deepEqual([...samples], [1, -1]);
  const wav = encodeMonoWav(samples);
  const view = new DataView(wav.buffer);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
  assert.throws(() => resampleMono(new Float32Array(16000 * 21), 16000), /recording limit/);
  assert.throws(() => resampleMono(samples, NaN), /sample rate/);
});

test('VAD ignores silence/clicks, includes onset, and ends on silence without unbounded buffers', () => {
  const utterances: Float32Array[] = [];
  let starts = 0;
  const detector = new PcmSegmenter({ onSpeechStart: () => { starts += 1; }, onSpeechEnd: () => undefined, onUtterance: (samples) => utterances.push(samples) });
  for (let index = 0; index < 30; index++) detector.feed(new Float32Array(800), 16000);
  detector.feed(new Float32Array(800).fill(0.8), 16000);
  detector.feed(new Float32Array(800), 16000);
  assert.equal(starts, 0, 'one loud frame is not an utterance');
  for (let index = 0; index < 8; index++) detector.feed(new Float32Array(800).fill(0.12), 16000);
  for (let index = 0; index < 14; index++) detector.feed(new Float32Array(800), 16000);
  assert.equal(starts, 1); assert.equal(utterances.length, 1);
  assert.ok(utterances[0].length >= 16000 * 0.4);
  for (let index = 0; index < 500; index++) detector.feed(new Float32Array(800).fill(0.12), 16000);
  assert.ok(utterances.length >= 2);
  assert.ok(utterances.every((samples) => samples.length <= 16000 * 20));
});

test('microphone acquisition only follows Start and mute/stop reach the hardware-track seam', async () => {
  const audio = fakeAudio(); const accepted: string[] = [];
  const controller = new VoiceController({ audio: audio.backend, adapter: { transcribe: async () => 'Please run the tests' }, onTranscript: (text) => { accepted.push(text); return true; } });
  assert.equal(audio.state.captures, 0);
  controller.setMode('push-to-talk'); controller.beginPushToTalk();
  assert.equal(audio.state.captures, 0);
  await controller.start(); assert.equal(audio.state.captures, 1);
  controller.setAgentWorking(true);
  manualUtterance(controller, audio); await settle();
  assert.deepEqual(accepted, ['Please run the tests'], 'working speech is guidance through the normal callback, never approval');
  controller.setMuted(true); assert.equal(audio.state.muted, true);
  audio.emit(0.5, 100); await settle(); assert.equal(accepted.length, 1);
  controller.stop(); await settle();
  assert.ok(audio.state.stopped > 0); assert.ok(audio.state.closes > 0);
  assert.equal(controller.getState().active, false);
});

test('transcriptions serialize, bound backlog, and preserve failed audio for explicit retry', async () => {
  const audio = fakeAudio(); const first = deferred<string>();
  let calls = 0; let active = 0; let maximum = 0; const accepted: string[] = [];
  const adapter: VoiceAdapter = { transcribe: async () => {
    const id = ++calls; active += 1; maximum = Math.max(maximum, active);
    try { return id === 1 ? await first.promise : `utterance ${id}`; } finally { active -= 1; }
  } };
  const controller = new VoiceController({ audio: audio.backend, adapter, onTranscript: (text) => { accepted.push(text); return true; } });
  await controller.start(); controller.setMode('push-to-talk');
  manualUtterance(controller, audio); manualUtterance(controller, audio); manualUtterance(controller, audio);
  assert.equal(calls, 1); assert.equal(controller.getState().pendingUtterances, 3); assert.equal(audio.state.muted, true);
  first.reject(new Error('offline')); await settle();
  assert.equal(controller.getState().failedUtterance, true);
  controller.retryFailedUtterance(); await settle();
  assert.equal(maximum, 1); assert.equal(accepted.length, 3);
  assert.equal(controller.getState().pendingUtterances, 0);
  assert.equal(controller.getState().muted, true, 'catch-up never silently reopens the microphone');
  controller.stop();
});

test('rejected transcript delivery is visible and recoverable with a stable id across retries', async () => {
  const audio = fakeAudio(); let accept = false; const delivered: string[] = []; const ids: string[] = [];
  const controller = new VoiceController({ audio: audio.backend, adapter: { transcribe: async () => 'Keep my words' }, onTranscript: (text, id) => { delivered.push(text); ids.push(id); return accept; } });
  await controller.start(); controller.setMode('push-to-talk'); manualUtterance(controller, audio); await settle();
  assert.equal(controller.getState().recoveredTranscript, 'Keep my words');
  assert.equal(controller.getState().muted, true);
  controller.setMuted(false); assert.equal(controller.getState().muted, true);
  accept = true; await controller.retryTranscript();
  assert.equal(controller.getState().recoveredTranscript, null); assert.deepEqual(delivered, ['Keep my words', 'Keep my words']);
  assert.equal(ids[0], ids[1], 'an uncertain receipt retry must use the original utterance id');
  controller.stop();
});

test('thread retirement preserves unsent words once and does not duplicate delivered words', async () => {
  const audio = fakeAudio(); const retired: string[] = [];
  const receipt = deferred<boolean>();
  const controller = new VoiceController({ audio: audio.backend, adapter: { transcribe: async () => 'Keep this in my old draft' }, onTranscript: () => receipt.promise, onRetireTranscript: (text) => retired.push(text) });
  await controller.start(); controller.setMode('push-to-talk'); manualUtterance(controller, audio); await settle();
  controller.retire(); receipt.resolve(false); await settle();
  assert.deepEqual(retired, ['Keep this in my old draft']);
  controller.retire(); assert.equal(retired.length, 1);

  const secondAudio = fakeAudio(); const secondReceipt = deferred<boolean>();
  const second = new VoiceController({ audio: secondAudio.backend, adapter: { transcribe: async () => 'Already delivered' }, onTranscript: () => secondReceipt.promise, onRetireTranscript: (text) => retired.push(text) });
  await second.start(); second.setMode('push-to-talk'); manualUtterance(second, secondAudio); await settle();
  second.retire(); secondReceipt.resolve(true); await settle();
  assert.equal(retired.length, 1, 'an accepted late receipt is not also appended to the draft');
});

test('retiring an in-flight text retry waits for its receipt before preserving a draft', async () => {
  for (const accepted of [true, false]) {
    const audio = fakeAudio(); const receipt = deferred<boolean>(); const retired: string[] = [];
    let attempts = 0;
    const controller = new VoiceController({ audio: audio.backend,
      adapter: { transcribe: async () => 'Original thread words' },
      onTranscript: () => ++attempts === 1 ? false : receipt.promise,
      onRetireTranscript: (text) => retired.push(text),
    });
    await controller.start(); controller.setMode('push-to-talk'); manualUtterance(controller, audio); await settle();
    const retry = controller.retryTranscript(); controller.retire();
    assert.equal(controller.getState().active, false, 'retirement still closes capture immediately');
    assert.deepEqual(retired, [], 'uncertain receipts are not prematurely duplicated into drafts');
    receipt.resolve(accepted); await retry; await settle(); controller.retire();
    assert.deepEqual(retired, accepted ? [] : ['Original thread words']);
  }
});

test('waveform publication is bounded while mute status updates remain immediate', async () => {
  const audio = fakeAudio(); let notifications = 0;
  const controller = new VoiceController({ audio: audio.backend, adapter: { transcribe: async () => '' }, onTranscript: () => true });
  await controller.start(); controller.subscribe(() => { notifications += 1; });
  audio.emit(0, 100); assert.ok(notifications <= 1, 'a frame burst does not rerender the app for every audio frame');
  controller.setMuted(true); assert.equal(controller.getState().phase, 'muted');
  assert.ok(notifications >= 1); controller.stop();
});

test('hold-to-talk half-duplex suppresses assistant echo and explicit interruption restores listening', async () => {
  const audio = fakeAudio(); const synthesized = deferred<{ audioBase64: string; mimeType: string }>(); let transcriptions = 0;
  const controller = new VoiceController({ audio: audio.backend, adapter: { transcribe: async () => { transcriptions += 1; return 'echo'; }, synthesize: () => synthesized.promise }, onTranscript: () => true });
  await controller.start(); controller.setMode('push-to-talk'); controller.speak('Here is the result', 'response-1');
  assert.equal(controller.getState().speaking, true); assert.equal(audio.state.muted, true);
  audio.emit(0.5, 100); await settle(); assert.equal(transcriptions, 0);
  synthesized.resolve({ audioBase64: 'fixture', mimeType: 'audio/wav' }); await settle();
  assert.equal(audio.state.plays, 1);
  controller.interruptPlayback(); await settle();
  assert.equal(controller.getState().speaking, false); assert.equal(audio.state.muted, false);
  controller.speak('Here is the result', 'response-1'); await settle(); assert.equal(audio.state.plays, 1, 'narration ids do not replay');
  controller.stop();
});

test('a stopped session drops late microphone/transcription results and closes backend auth once', async () => {
  const audio = fakeAudio(); const capture = deferred<VoiceMicrophone>(); let ended = 0; let accepted = 0;
  audio.backend.capture = () => capture.promise;
  const controller = new VoiceController({ audio: audio.backend, adapter: { begin: async () => undefined, end: () => { ended += 1; }, transcribe: async () => 'late' }, onTranscript: () => { accepted += 1; return true; } });
  const opening = controller.start(); await settle(); controller.stop(); capture.resolve(audio.microphone);
  await opening; await settle();
  assert.ok(audio.state.stopped > 0); assert.equal(ended, 1); assert.equal(accepted, 0); assert.equal(controller.getState().active, false);

  const secondAudio = fakeAudio(); const transcription = deferred<string>();
  const second = new VoiceController({ audio: secondAudio.backend, adapter: { transcribe: () => transcription.promise }, onTranscript: () => { accepted += 1; return true; } });
  await second.start(); second.setMode('push-to-talk'); manualUtterance(second, secondAudio);
  second.stop(); transcription.resolve('late words'); await settle(); assert.equal(accepted, 0);
});

test('Auto rejects brief noise then interrupts on confirmed speech with its onset intact', async () => {
  const audio = fakeAudio(); const accepted: string[] = []; let capturedBytes = 0;
  const controller = new VoiceController({ audio: audio.backend, adapter: {
    transcribe: async (input) => { capturedBytes = atob(input.wavBase64).length; return 'Please stop speaking'; },
    synthesize: async () => ({ audioBase64: 'fixture', mimeType: 'audio/wav' }),
  }, onTranscript: (text) => { accepted.push(text); return true; } });
  await controller.start(); controller.speak('An answer', 'response:voice:commentary:0:10'); await settle();
  assert.equal(audio.state.muted, false, 'AEC capture stays available in Auto');
  audio.emit(0.5, 1); audio.emit(0.01, 8);
  assert.equal(controller.getState().speaking, true, 'clicks and low residual echo do not interrupt');
  audio.emit(0.12, 6);
  assert.equal(controller.getState().speaking, false);
  assert.equal(controller.getState().recording, true);
  audio.emit(0, 14); await settle();
  assert.deepEqual(accepted, ['Please stop speaking']);
  assert.ok(capturedBytes >= 44 + 16000 * 2 * 0.9, 'confirmed onset is included with the silence tail');
  controller.speak('The rest of the interrupted response', 'response:voice:commentary:10:20'); await settle();
  assert.equal(audio.state.plays, 1, 'later deltas of the interrupted response remain silent');
  controller.stop();
});

test('PCM speech plays before synthesis finishes and consecutive phrases share one playback timeline', async () => {
  const audio = fakeAudio(); const finish = deferred<void>(); const texts: string[] = []; const heard: number[] = [];
  let timelines = 0;
  audio.backend.playStream = async (chunks) => { timelines++; for await (const chunk of chunks) heard.push(atob(chunk.audioBase64).charCodeAt(0)); };
  const controller = new VoiceController({ audio: audio.backend, adapter: {
    transcribe: async () => '',
    async *synthesizeStream(text) {
      texts.push(text);
      yield { audioBase64: texts.length === 1 ? 'AQACAA==' : 'AwAEAA==', channels: 1, sampleRate: 24000, format: 'pcm16le' };
      if (texts.length === 1) await finish.promise;
    },
  }, onTranscript: () => true });
  await controller.start(); controller.speak('First sentence', 'one'); controller.speak('Second sentence', 'two'); await settle();
  assert.deepEqual(heard, [1], 'first PCM is consumed before the synthesis completes');
  assert.equal(controller.getState().speaking, true);
  finish.resolve(); await settle();
  assert.deepEqual(texts, ['First sentence', 'Second sentence']);
  assert.deepEqual(heard, [1, 3]); assert.equal(timelines, 1);
  controller.stop();
});

test('live transcription replaces captions, submits only unique finals, and orders push-to-talk clear/audio/commit', async () => {
  const audio = fakeAudio(); const accepted: string[] = []; const actions: string[] = [];
  let event!: (value: import('../src/api/voice').VoiceTranscriptionEvent) => void;
  const controller = new VoiceController({ audio: audio.backend, adapter: {
    transcribe: async () => { throw new Error('live input must not use buffered transcription'); },
    beginTranscription: async (_signal, receive) => {
      event = receive; actions.push('ready');
      return { append: async (pcm) => { assert.notEqual(atob(pcm).slice(0, 4), 'RIFF'); actions.push('audio'); },
        clear: async () => { actions.push('clear'); }, commit: async () => { actions.push('commit'); }, stop: async () => { actions.push('stop'); } };
    },
  }, onTranscript: (text) => { accepted.push(text); return true; } });
  await controller.start(); controller.setMode('push-to-talk'); controller.beginPushToTalk(); audio.emit(0.12, 5); await settle();
  assert.deepEqual(actions, ['ready', 'clear', 'clear', 'audio', 'audio', 'audio', 'audio', 'audio']);
  const base = { sessionId: 's', requestId: 'r', itemId: 'line-1' };
  event({ ...base, type: 'partial', text: 'Run' }); event({ ...base, type: 'partial', text: 'Run the tests' });
  assert.equal(controller.getState().interimTranscript, 'Run the tests'); assert.deepEqual(accepted, []);
  event({ ...base, type: 'final', text: 'Run the tests.' }); event({ ...base, type: 'final', text: 'Run the tests.' }); await settle();
  assert.deepEqual(accepted, [], 'native line finals do not split a local utterance into several turns');
  event({ ...base, itemId: 'line-2', type: 'partial', text: 'Then review' });
  assert.equal(controller.getState().interimTranscript, 'Run the tests. Then review');
  controller.endPushToTalk(); await settle(); assert.equal(actions.at(-1), 'commit');
  await new Promise((resolve) => setTimeout(resolve, 240));
  assert.deepEqual(accepted, [], 'a trailing partial is retained beyond the ordinary quiet window');
  assert.equal(controller.getState().interimTranscript, 'Run the tests. Then review');
  event({ ...base, itemId: 'line-2', type: 'final', text: 'Then review the code.' });
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.deepEqual(accepted, ['Run the tests. Then review the code.']); assert.equal(controller.getState().interimTranscript, '');
  controller.stop(); event({ ...base, itemId: 'late', type: 'final', text: 'Wrong session' }); await settle();
  assert.deepEqual(accepted, ['Run the tests. Then review the code.']); assert.equal(actions.at(-1), 'stop');
});

test('mute and mode changes discard remote partials, while empty finals release the waiting state', async () => {
  const audio = fakeAudio(); const accepted: string[] = []; let cleared = 0;
  let event!: (value: import('../src/api/voice').VoiceTranscriptionEvent) => void;
  const controller = new VoiceController({ audio: audio.backend, adapter: {
    transcribe: async () => '', beginTranscription: async (_signal, receive) => { event = receive; return {
      append: async () => {}, clear: async () => { cleared++; }, commit: async () => {}, stop: async () => {},
    }; },
  }, onTranscript: (text) => { accepted.push(text); return true; } });
  await controller.start(); audio.emit(0.12, 5); await settle();
  const base = { sessionId: 's', requestId: 'r', itemId: 'discarded' };
  event({ ...base, type: 'partial', text: 'Unfinished words' });
  controller.setMuted(true); event({ ...base, type: 'final', text: 'Late discarded words' }); await settle();
  assert.equal(cleared, 1); assert.equal(controller.getState().interimTranscript, ''); assert.equal(controller.getState().phase, 'muted');
  controller.setMuted(false); audio.emit(0.12, 5); await settle();
  event({ ...base, itemId: 'empty', type: 'final', text: '' }); audio.emit(0, 14); await settle();
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(controller.getState().phase, 'listening', 'an empty completed utterance cannot leave transcription stuck');
  audio.emit(0.12, 5); controller.setMode('push-to-talk');
  event({ ...base, itemId: 'mode-change', type: 'final', text: 'Discarded on mode change' }); await settle();
  assert.equal(cleared, 2); assert.deepEqual(accepted, []); controller.stop();
});

test('a failed live commit preserves recognized final and partial words for explicit recovery', async () => {
  const audio = fakeAudio(); const accepted: string[] = [];
  let event!: (value: import('../src/api/voice').VoiceTranscriptionEvent) => void;
  const controller = new VoiceController({ audio: audio.backend, adapter: {
    transcribe: async () => '', beginTranscription: async (_signal, receive) => { event = receive; return {
      append: async () => {}, clear: async () => {}, commit: async () => { throw new Error('Live transcription timed out'); }, stop: async () => {},
    }; },
  }, onTranscript: (text) => { accepted.push(text); return true; } });
  await controller.start(); controller.setMode('push-to-talk'); controller.beginPushToTalk(); audio.emit(0.12, 5); await settle();
  const base = { sessionId: 's', requestId: 'r' };
  event({ ...base, type: 'final', itemId: 'part-1', text: 'Run tests.' });
  event({ ...base, type: 'partial', itemId: 'part-2', text: 'Then review' });
  controller.endPushToTalk(); await settle();
  assert.equal(controller.getState().recoveredTranscript, 'Run tests. Then review');
  assert.equal(controller.getState().muted, true); assert.deepEqual(accepted, []);
  controller.stop();
});

test('permission, no-device, and offline errors have actionable retry guidance', async () => {
  assert.match(voiceError({ name: 'NotAllowedError' }), /Allow microphone access/);
  assert.match(voiceError({ name: 'NotFoundError' }), /No microphone/);
  assert.match(voiceError(new Error('ECONNREFUSED')), /speech service is unavailable/);
  const audio = fakeAudio(); audio.backend.capture = async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
  const controller = new VoiceController({ audio: audio.backend, adapter: { transcribe: async () => '' }, onTranscript: () => true });
  await controller.start(); assert.equal(controller.getState().active, false); assert.match(controller.getState().error!, /microphone access/);
  assert.ok(audio.state.closes > 0);
});
