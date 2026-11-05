/** Renderer transport: mono, signed 16-bit little-endian PCM. */
export interface SpeechPcmChunk {
  audioBase64: string;
  sampleRate: number;
  channels: 1;
  format: 'pcm16le';
}
export class SpeechDecodeError extends Error {}
export const MAX_STREAM_SPEECH_BYTES = 24 * 1024 * 1024;
const MAX_CHUNK_FRAMES = 8192;
const MAX_WAV_HEADER_BYTES = 64 * 1024;
interface Format { rate: number; channels: number; bits: number; float: boolean; bigEndian?: boolean }
const invalid = (message: string): never => { throw new SpeechDecodeError(message); };
function format(rate: number, channels: number, bits: number, float = false, bigEndian = false): Format {
  if (!Number.isInteger(rate) || rate < 8000 || rate > 48000 || ![1, 2].includes(channels)
    || !(float ? bits === 32 : [8, 16, 24, 32].includes(bits))) {
    return invalid('The speech source returned an unsupported PCM format.');
  }
  return { rate, channels, bits, float, bigEndian };
}

/** Incremental WAV/PCM parser. Only incomplete frames or bounded headers survive each push. */
export class SpeechStreamDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);
  private shape?: Format;
  private state: 'raw' | 'riff' | 'chunk' | 'fmt' | 'skip' | 'data' | 'pad' = 'riff';
  private remaining = 0;
  private padding = 0;
  private declaredBytes?: number;
  private received = 0;
  private headerBytes = 0;
  private dataSeen = false;
  private done = false;
  private frameCount = 0;

  constructor(headers: Headers) {
    const contentType = (headers.get('content-type') ?? 'audio/wav').toLowerCase();
    const type = contentType.split(';')[0].trim();
    if (['audio/pcm', 'audio/l16'].includes(type)) {
      const parameter = (name: string) => contentType.match(new RegExp(`(?:^|;)\\s*${name}=([^;]+)`))?.[1].trim();
      const rate = Number(parameter('rate') ?? headers.get('x-moss-sample-rate') ?? (type === 'audio/pcm' ? 24000 : undefined));
      const channels = Number(parameter('channels') ?? headers.get('x-moss-channels') ?? 1);
      const endian = parameter('endianness');
      if (endian && !['little-endian', 'big-endian'].includes(endian)) invalid('The speech source returned an unsupported PCM byte order.');
      // L16 is network byte order unless the server explicitly declares its little-endian extension.
      this.shape = format(rate, channels, 16, false, endian === 'big-endian' || (type === 'audio/l16' && !endian));
      this.state = 'raw';
    } else if (['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave', 'application/octet-stream'].includes(type)) {
      this.state = 'riff';
    } else invalid('The speech source did not return PCM or WAV audio.');
    const length = headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_STREAM_SPEECH_BYTES)) invalid('The speech audio exceeded its 24 MiB limit.');
  }

  push(input: Uint8Array): SpeechPcmChunk[] {
    if (this.done) return invalid('Speech arrived after the audio stream completed.');
    this.received += input.byteLength;
    if (this.received > MAX_STREAM_SPEECH_BYTES) return invalid('The speech audio exceeded its 24 MiB limit.');
    const output: SpeechPcmChunk[] = [];
    // A response may deliver its entire body in one read. Bound every parser allocation regardless.
    for (let start = 0; start < input.byteLength; start += MAX_WAV_HEADER_BYTES) {
      const part = Buffer.from(input.buffer, input.byteOffset + start, Math.min(input.byteLength - start, MAX_WAV_HEADER_BYTES));
      if (this.state === 'raw') this.pcm(part, output);
      else {
        this.pending = this.pending.length ? Buffer.concat([this.pending, part]) : part;
        this.parse(output);
      }
    }
    return output;
  }

  finish(): { sampleRate: number; channels: 1; frames: number } {
    if (this.done) return invalid('The speech stream already completed.');
    this.done = true;
    const complete = this.state === 'raw' || (this.state === 'data' && this.remaining === Infinity)
      || (this.state === 'chunk' && this.pending.length === 0);
    if (!complete || this.tail.length || !this.shape || !this.frameCount || (this.state !== 'raw' && !this.dataSeen)
      || (this.declaredBytes !== undefined && this.received !== this.declaredBytes)) {
      return invalid('The speech source returned truncated or empty audio.');
    }
    return { sampleRate: this.shape.rate, channels: 1, frames: this.frameCount };
  }

  private consume(length: number, header = true): Buffer {
    const bytes = this.pending.subarray(0, length); this.pending = this.pending.subarray(length);
    if (header && !this.dataSeen) {
      this.headerBytes += length;
      if (this.headerBytes > MAX_WAV_HEADER_BYTES) invalid('The speech WAV header exceeded its limit.');
    }
    return bytes;
  }

  private parse(output: SpeechPcmChunk[]): void {
    while (this.pending.length) {
      if (this.state === 'riff') {
        if (this.pending.length < 12) return;
        const bytes = this.consume(12);
        if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') invalid('The speech source returned invalid WAV audio.');
        const size = bytes.readUInt32LE(4);
        if (size !== 0xffffffff) {
          if (size < 36 || size + 8 > MAX_STREAM_SPEECH_BYTES) invalid('The speech WAV size is invalid or exceeds its limit.');
          this.declaredBytes = size + 8;
        }
        this.state = 'chunk';
      } else if (this.state === 'chunk') {
        if (this.pending.length < 8) return;
        const bytes = this.consume(8); const tag = bytes.toString('ascii', 0, 4); const size = bytes.readUInt32LE(4);
        this.remaining = size; this.padding = size % 2;
        if (tag === 'fmt ') {
          if (this.shape || size < 16 || size > 1024) invalid('The speech WAV format header is invalid.');
          this.state = 'fmt';
        } else if (tag === 'data') {
          if (!this.shape || this.dataSeen) invalid('The speech WAV audio layout is invalid.');
          this.dataSeen = true;
          if (size === 0xffffffff) { this.remaining = Infinity; this.padding = 0; }
          else if (size > MAX_STREAM_SPEECH_BYTES) invalid('The speech audio exceeded its 24 MiB limit.');
          this.state = 'data';
        } else {
          if (size > MAX_STREAM_SPEECH_BYTES) invalid('The speech WAV metadata exceeds its limit.');
          this.state = 'skip';
        }
      } else if (this.state === 'fmt') {
        if (this.pending.length < this.remaining) return;
        const bytes = this.consume(this.remaining); const encoding = bytes.readUInt16LE(0);
        if (![1, 3].includes(encoding)) invalid('The speech WAV encoding is unsupported.');
        this.shape = format(bytes.readUInt32LE(4), bytes.readUInt16LE(2), bytes.readUInt16LE(14), encoding === 3);
        const block = this.shape.channels * this.shape.bits / 8;
        if (bytes.readUInt16LE(12) !== block || bytes.readUInt32LE(8) !== block * this.shape.rate) invalid('The speech WAV frame size is invalid.');
        this.state = 'pad';
      } else if (this.state === 'data' || this.state === 'skip') {
        const size = Math.min(this.remaining, this.pending.length);
        const bytes = this.consume(size, this.state === 'skip');
        if (this.state === 'data') this.pcm(bytes, output);
        this.remaining -= size;
        if (this.remaining > 0) return;
        if (this.state === 'data' && this.tail.length) invalid('The speech WAV ends with an incomplete PCM frame.');
        this.state = 'pad';
      } else if (this.state === 'pad') {
        if (this.pending.length < this.padding) return;
        this.consume(this.padding); this.padding = 0; this.state = 'chunk';
      }
    }
    // Empty chunks and even-sized data require no bytes for their transition.
    if (this.state === 'pad' && this.padding === 0) this.state = 'chunk';
  }

  private pcm(bytes: Buffer, output: SpeechPcmChunk[]): void {
    const shape = this.shape!; const sampleBytes = shape.bits / 8; const block = sampleBytes * shape.channels;
    const joined = this.tail.length ? Buffer.concat([this.tail, bytes]) : bytes;
    const usable = joined.length - joined.length % block;
    // Copy the tiny tail so it does not retain the entire network buffer.
    this.tail = Buffer.from(joined.subarray(usable));
    for (let offset = 0; offset < usable;) {
      const length = Math.min(usable - offset, MAX_CHUNK_FRAMES * block); const pcm = Buffer.allocUnsafe(length / block * 2);
      for (let i = 0, target = 0; i < length; i += block, target += 2) {
        let sum = 0;
        for (let channel = 0; channel < shape.channels; channel++) {
          const at = offset + i + channel * sampleBytes; let sample: number;
          if (shape.float) {
            const value = joined.readFloatLE(at);
            if (!Number.isFinite(value)) invalid('The speech source returned non-finite audio samples.');
            sample = Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767));
          } else if (shape.bits === 8) sample = (joined[at] - 128) * 256;
          else if (shape.bits === 16) sample = shape.bigEndian ? joined.readInt16BE(at) : joined.readInt16LE(at);
          else if (shape.bits === 24) sample = joined.readIntLE(at, 3) >> 8;
          else sample = joined.readInt32LE(at) >> 16;
          sum += sample;
        }
        pcm.writeInt16LE(Math.round(sum / shape.channels), target);
      }
      this.frameCount += length / block;
      output.push({ audioBase64: pcm.toString('base64'), sampleRate: shape.rate, channels: 1, format: 'pcm16le' });
      offset += length;
    }
  }
}
