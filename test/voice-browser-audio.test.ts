import assert from 'node:assert/strict';
import test from 'node:test';
import { browserVoiceAudio } from '../renderer/src/voice/browserAudio';

test('browser audio uses explicit local capture, disables tracks on mute, and releases nodes/tracks/context', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const previousWorklet = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode');
  let acquisitions = 0; let stopped = 0; let closed = 0; let frames = 0; let disconnects = 0;
  const track = { enabled: true, stop: () => { stopped += 1; }, addEventListener: () => undefined };
  const node = () => ({ connect: () => undefined, disconnect: () => { disconnects += 1; } });
  let processor: { onaudioprocess: ((event: unknown) => void) | null } | undefined;
  class FakeAudioContext {
    state = 'running'; sampleRate = 48000; destination = {};
    resume = async () => undefined;
    close = async () => { closed += 1; this.state = 'closed'; };
    createMediaStreamSource = () => node();
    createGain = () => ({ ...node(), gain: { value: 1 } });
    createScriptProcessor = () => { const result = { ...node(), onaudioprocess: null }; processor = result; return result; };
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async (constraints: MediaStreamConstraints) => {
    acquisitions += 1; assert.equal(constraints.video, false);
    assert.equal((constraints.audio as MediaTrackConstraints).echoCancellation, true);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  } } } });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: undefined });
  try {
    const backend = browserVoiceAudio(); assert.equal(acquisitions, 0);
    await backend.unlock!(); assert.equal(acquisitions, 0, 'playback unlocking never acquires a microphone');
    const microphone = await backend.capture((samples, rate) => { frames += 1; assert.equal(samples.length, 2048); assert.equal(rate, 48000); }, (error) => { throw error; });
    assert.equal(acquisitions, 1);
    const output = new Float32Array(2048).fill(1);
    processor!.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.1) }, outputBuffer: { getChannelData: () => output } });
    assert.equal(frames, 1); assert.ok(output.every((sample) => sample === 0), 'capture is never fed back into the speakers');
    microphone.setMuted(true); assert.equal(track.enabled, false);
    microphone.setMuted(false); assert.equal(track.enabled, true);
    microphone.stop(); assert.equal(stopped, 1); assert.equal(processor!.onaudioprocess, null);
    await backend.close(); assert.equal(closed, 1); assert.ok(disconnects >= 3); assert.equal(stopped, 1);
  } finally {
    for (const [key, descriptor] of [['navigator', previousNavigator], ['AudioContext', previousContext], ['AudioWorkletNode', previousWorklet]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('PCM playback starts with the first chunk, schedules contiguous audio, and bounds synthesis lookahead', async () => {
  const previousContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let context!: FakeAudioContext; let pulls = 0; let stopped = 0;
  const starts: number[] = []; const values: number[] = [];
  class FakeAudioContext {
    state = 'running'; currentTime = 0; destination = {};
    constructor() { context = this; }
    resume = async () => {};
    close = async () => { this.state = 'closed'; };
    createAnalyser = () => ({ fftSize: 256, connect() {}, disconnect() {}, getFloatTimeDomainData(data: Float32Array) { data.fill(0); } });
    createBuffer = (_channels: number, frames: number, rate: number) => { const samples = new Float32Array(frames); return { duration: frames / rate, getChannelData: () => samples }; };
    createBufferSource = () => ({ buffer: null as { duration: number; getChannelData(): Float32Array } | null,
      onended: null as (() => void) | null, connect() {}, disconnect() {}, stop() { stopped++; },
      start(at: number) { starts.push(at); values.push(this.buffer!.getChannelData()[0]); },
    });
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout, setInterval, clearInterval } });
  try {
    const audio = browserVoiceAudio(); const abort = new AbortController();
    const chunks = async function* () {
      for (let index = 0; index < 8; index++) { pulls++; yield { audioBase64: btoa('\x00\x10'.repeat(8000)), sampleRate: 8000, channels: 1 as const, format: 'pcm16le' as const }; }
    };
    const playing = audio.playStream!(chunks(), abort.signal, () => {});
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(starts, [0.025, 1.025]); assert.equal(pulls, 2, 'the HTTP producer is held once scheduled audio reaches two seconds');
    assert.deepEqual(values, [0.125, 0.125], 'little-endian PCM is decoded without waiting for a WAV container');
    context.currentTime = 0.1;
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(starts[2], 2.025, 'chunks use one contiguous AudioContext timeline');
    assert.equal(pulls, 3);
    abort.abort(); await playing; assert.equal(stopped, 3); await audio.close();
  } finally {
    if (previousContext) Object.defineProperty(globalThis, 'AudioContext', previousContext); else Reflect.deleteProperty(globalThis, 'AudioContext');
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});
