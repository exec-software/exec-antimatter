import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamingPcmResampler } from '../renderer/src/voice/streamingPcm';

test('continuous resampling preserves timing and waveform across Worklet boundaries', () => {
  for (const rate of [8000, 16000, 44100, 48000, 96000]) {
    const samples = Float32Array.from({ length: rate }, (_, i) => Math.sin(i * 0.13) * 0.3);
    const small = new StreamingPcmResampler(); const large = new StreamingPcmResampler();
    const fragmented: number[] = []; const reference: number[] = [];
    for (let at = 0; at < samples.length; at += 128) fragmented.push(...small.push(samples.subarray(at, at + 128), rate));
    for (let at = 0; at < samples.length; at += rate / 2) reference.push(...large.push(samples.subarray(at, at + rate / 2), rate));
    assert.equal(fragmented.length, 16000, `${rate} Hz microphone must retain one second`);
    assert.deepEqual(fragmented, reference, `${rate} Hz frame splitting must not affect audio`);
  }
});
test('reset discards fractional old audio and rate changes cannot blend separate recordings', () => {
  const resampler = new StreamingPcmResampler();
  assert.equal(resampler.push(Float32Array.of(1, 1), 48000).length, 0);
  resampler.reset();
  assert.deepEqual([...resampler.push(Float32Array.of(0, 0, 0), 48000)], [0]);
  resampler.push(Float32Array.of(1, 1), 48000);
  assert.deepEqual([...resampler.push(Float32Array.of(0, NaN, Infinity), 16000)], [0, 0, 0]);
  assert.throws(() => resampler.push(Float32Array.of(1), 0), /Unsupported/);
});
