import type { VoiceMode } from './types';

export const VOICE_SAMPLE_RATE = 16000;
export const MAX_UTTERANCE_SECONDS = 20;

export const rms = (samples: Float32Array): number => {
  if (!samples.length) return 0;
  let total = 0;
  for (const sample of samples) total += Number.isFinite(sample) ? sample * sample : 0;
  return Math.min(1, Math.sqrt(total / samples.length));
};

/** Area averaging when downsampling avoids a naive decimator's worst aliasing for speech. */
export function resampleMono(samples: Float32Array, sourceRate: number, targetRate = VOICE_SAMPLE_RATE): Float32Array {
  if (!Number.isFinite(sourceRate) || sourceRate < 8000 || sourceRate > 192000 || !Number.isFinite(targetRate) || targetRate < 8000 || targetRate > 192000) throw new Error('Unsupported microphone sample rate.');
  if (samples.length > sourceRate * MAX_UTTERANCE_SECONDS) throw new Error('The voice utterance exceeds the recording limit.');
  if (sourceRate === targetRate) return samples.slice();
  const length = Math.floor(samples.length * targetRate / sourceRate);
  const result = new Float32Array(length);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < length; index++) {
    const start = index * ratio;
    if (ratio < 1) {
      const left = Math.floor(start);
      const fraction = start - left;
      result[index] = (samples[left] || 0) * (1 - fraction) + (samples[Math.min(left + 1, samples.length - 1)] || 0) * fraction;
    } else {
      const end = Math.min(samples.length, start + ratio);
      let sum = 0;
      for (let source = Math.floor(start); source < Math.ceil(end); source++) {
        sum += (samples[source] || 0) * (Math.min(end, source + 1) - Math.max(start, source));
      }
      result[index] = sum / (end - start);
    }
  }
  return result;
}

export function encodeMonoWav(samples: Float32Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  if (samples.length > sampleRate * MAX_UTTERANCE_SECONDS) throw new Error('The voice utterance exceeds the recording limit.');
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, Number.isFinite(samples[index]) ? samples[index] : 0));
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

interface SegmentOptions {
  onSpeechStart(): void;
  onUtterance(samples: Float32Array, sampleRate: number): void;
  onSpeechEnd(): void;
}

/** Bounded RMS VAD with onset confirmation, pre-roll, a silence tail, and a manual fallback. */
export class PcmSegmenter {
  private rate = 0;
  private chunks: Float32Array[] = [];
  private count = 0;
  private preRoll: Float32Array[] = [];
  private preCount = 0;
  private voiceMs = 0;
  private silenceMs = 0;
  private active = false;
  private held = false;
  private noise = 0.003;
  mode: VoiceMode = 'auto';

  constructor(private readonly options: SegmentOptions) {}
  get recording(): boolean { return this.active; }

  reset(): void {
    this.chunks = []; this.count = 0; this.preRoll = []; this.preCount = 0;
    this.voiceMs = 0; this.silenceMs = 0; this.active = false; this.held = false; this.rate = 0; this.noise = 0.003;
  }

  beginPushToTalk(): void { this.held = true; }
  endPushToTalk(): void { this.held = false; this.finish(); }

  feed(input: Float32Array, sampleRate: number): number {
    if (!input.length || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return 0;
    // Bound both untrusted/faulty worklet messages and the number of retained frame objects.
    if (input.length > sampleRate / 2) return 0;
    if (this.rate && this.rate !== sampleRate) this.reset();
    this.rate = sampleRate;
    const samples = input.slice();
    const level = rms(samples);
    const duration = samples.length * 1000 / sampleRate;
    const voiced = level >= Math.max(0.009, Math.min(0.06, this.noise * 3));
    if (this.mode === 'push-to-talk') {
      if (!this.held) return level;
      if (!this.active) { this.active = true; this.options.onSpeechStart(); }
      this.append(samples);
      return level;
    }
    if (this.active) {
      this.silenceMs = voiced ? 0 : this.silenceMs + duration;
      this.append(samples);
      if (this.active && this.silenceMs >= 650) this.finish();
      return level;
    }
    if (!voiced) this.noise = this.noise * 0.97 + Math.min(level, 0.03) * 0.03;
    this.preRoll.push(samples); this.preCount += samples.length;
    while (this.preRoll.length > 1 && this.preCount > sampleRate * 0.25) this.preCount -= this.preRoll.shift()!.length;
    this.voiceMs = voiced ? this.voiceMs + duration : 0;
    if (this.voiceMs >= 160) {
      this.active = true; this.silenceMs = 0;
      this.chunks = this.preRoll; this.count = this.preCount; this.preRoll = []; this.preCount = 0;
      this.options.onSpeechStart();
    }
    return level;
  }

  private append(samples: Float32Array): void {
    const remaining = this.rate * MAX_UTTERANCE_SECONDS - this.count;
    const kept = samples.length > remaining ? samples.slice(0, remaining) : samples;
    if (kept.length) { this.chunks.push(kept); this.count += kept.length; }
    if (this.count >= this.rate * MAX_UTTERANCE_SECONDS) this.finish();
  }

  finish(): void {
    const chunks = this.chunks; const count = this.count; const rate = this.rate;
    const active = this.active;
    this.chunks = []; this.count = 0; this.preRoll = []; this.preCount = 0; this.voiceMs = 0; this.silenceMs = 0; this.active = false;
    if (!active) return;
    this.options.onSpeechEnd();
    if (count < rate * 0.16) return;
    const samples = new Float32Array(count);
    let offset = 0; for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
    if (rms(samples) < 0.002) return;
    this.options.onUtterance(samples, rate);
  }
}
