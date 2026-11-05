/** Area-average continuous microphone frames without dropping fractional samples at boundaries. */
export class StreamingPcmResampler {
  private rate = 0;
  private width = 0;
  private sum = 0;
  private filled = 0;
  reset(): void { this.rate = 0; this.width = 0; this.sum = 0; this.filled = 0; }
  push(samples: Float32Array, sampleRate: number): Float32Array {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || samples.length > sampleRate / 2) {
      throw new Error('Unsupported microphone frame.');
    }
    if (this.rate !== sampleRate) { this.reset(); this.rate = sampleRate; this.width = sampleRate / 16000; }
    const output: number[] = [];
    for (const raw of samples) {
      const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      let remaining = 1;
      while (remaining > 1e-10) {
        const part = Math.min(remaining, this.width - this.filled);
        this.sum += sample * part; this.filled += part; remaining -= part;
        if (this.width - this.filled < 1e-10) {
          output.push(this.sum / this.width); this.sum = 0; this.filled = 0;
        }
      }
    }
    return Float32Array.from(output);
  }
}
