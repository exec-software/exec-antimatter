import { open, type FileHandle } from 'node:fs/promises';

/**
 * Reads the metadata at the front of a GGUF file.
 *
 * The Hub reports an architecture per repository, but what decides whether an engine can load a
 * file is what that file says about itself, so a finished download is read before it is
 * registered. Only the header is touched: the few keys that matter come first, and the reader
 * stops as soon as it has them rather than walking a 150,000-entry vocabulary to get there.
 *
 * Format: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
 */

export interface GgufMetadata {
  version: number;
  tensorCount: number;
  architecture: string | null;
  name: string | null;
  /** The context length the model was trained for, from `<architecture>.context_length`. */
  contextLength: number | null;
  /** llama.cpp's `general.file_type` enum. */
  fileType: number | null;
}

/**
 * `general.file_type` is llama.cpp's `llama_ftype`. Mainline numbers its quantizations below 100
 * and reserves 1024 for `GUESSED`; forks number their own from 100 up, and ik_llama.cpp's IQ*_K
 * types land in the 130s. A build without those decoders does not fail slowly or partially: it
 * reads the header, reaches a tensor type it has no case for, and exits before serving anything.
 *
 * Deliberately a denylist of the fork range rather than a list of the types known to work. A
 * mainline release that adds a quantization should not be refused here for being newer than this
 * file: guessing wrong in that direction costs a model that would have run, while guessing wrong
 * in the other only returns the behaviour this replaces.
 */
const FORK_FILE_TYPE_FIRST = 100;
const FORK_FILE_TYPE_LAST = 1023;

/** Why no llama.cpp build here can read this file, or null when nothing about it says so. */
export function forkQuantizationReason(fileType: number | null | undefined): string | null {
  if (typeof fileType !== 'number') return null;
  if (fileType < FORK_FILE_TYPE_FIRST || fileType > FORK_FILE_TYPE_LAST) return null;
  return `Its quantization (general.file_type ${fileType}) comes from a llama.cpp fork — ik_llama.cpp numbers its IQ*_K quantizations in this range — which the llama.cpp builds here cannot decode.`;
}

const MAGIC = 0x46554747; // "GGUF", little-endian
const CHUNK = 1 << 20;
/** A header larger than this is not one worth believing. */
const MAX_HEADER_BYTES = 256 << 20;
const MAX_STRING_BYTES = 16 << 20;

const ValueType = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;
type ValueType = (typeof ValueType)[keyof typeof ValueType];

const FIXED_SIZE: Partial<Record<number, number>> = {
  [ValueType.UINT8]: 1,
  [ValueType.INT8]: 1,
  [ValueType.UINT16]: 2,
  [ValueType.INT16]: 2,
  [ValueType.UINT32]: 4,
  [ValueType.INT32]: 4,
  [ValueType.FLOAT32]: 4,
  [ValueType.BOOL]: 1,
  [ValueType.UINT64]: 8,
  [ValueType.INT64]: 8,
  [ValueType.FLOAT64]: 8,
};

class Reader {
  private buffer = Buffer.alloc(0);
  private bufferStart = 0;
  position = 0;

  constructor(
    private readonly handle: FileHandle,
    private readonly size: number
  ) {}

  private async ensure(length: number): Promise<void> {
    if (this.position + length > this.size) throw new Error('GGUF header runs past the end of the file.');
    if (this.position >= this.bufferStart && this.position + length <= this.bufferStart + this.buffer.length) return;
    const wanted = Math.max(length, CHUNK);
    const next = Buffer.alloc(Math.min(wanted, this.size - this.position));
    const { bytesRead } = await this.handle.read(next, 0, next.length, this.position);
    if (bytesRead < length) throw new Error('GGUF header ended early.');
    this.buffer = next.subarray(0, bytesRead);
    this.bufferStart = this.position;
  }

  private offset(): number {
    return this.position - this.bufferStart;
  }

  skip(length: number): void {
    if (this.position + length > this.size) throw new Error('GGUF header runs past the end of the file.');
    this.position += length;
  }

  async u32(): Promise<number> {
    await this.ensure(4);
    const value = this.buffer.readUInt32LE(this.offset());
    this.position += 4;
    return value;
  }

  async u64(): Promise<number> {
    await this.ensure(8);
    const value = this.buffer.readBigUInt64LE(this.offset());
    this.position += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('GGUF header holds an implausibly large count.');
    return Number(value);
  }

  async string(): Promise<string> {
    const length = await this.u64();
    if (length > MAX_STRING_BYTES) throw new Error('GGUF header holds an implausibly long string.');
    await this.ensure(length);
    const value = this.buffer.toString('utf8', this.offset(), this.offset() + length);
    this.position += length;
    return value;
  }

  /** Reads a scalar as a number, or returns null for a type that is not one. */
  async scalar(type: ValueType): Promise<number | null> {
    const size = FIXED_SIZE[type];
    if (!size) return null;
    await this.ensure(size);
    const at = this.offset();
    let value: number;
    switch (type) {
      case ValueType.UINT8:
      case ValueType.BOOL:
        value = this.buffer.readUInt8(at);
        break;
      case ValueType.INT8:
        value = this.buffer.readInt8(at);
        break;
      case ValueType.UINT16:
        value = this.buffer.readUInt16LE(at);
        break;
      case ValueType.INT16:
        value = this.buffer.readInt16LE(at);
        break;
      case ValueType.UINT32:
        value = this.buffer.readUInt32LE(at);
        break;
      case ValueType.INT32:
        value = this.buffer.readInt32LE(at);
        break;
      case ValueType.FLOAT32:
        value = this.buffer.readFloatLE(at);
        break;
      case ValueType.UINT64:
        value = Number(this.buffer.readBigUInt64LE(at));
        break;
      case ValueType.INT64:
        value = Number(this.buffer.readBigInt64LE(at));
        break;
      default:
        value = this.buffer.readDoubleLE(at);
    }
    this.position += size;
    return value;
  }

  /** Steps over a value without keeping it. Arrays of fixed-size values are skipped in one move. */
  async skipValue(type: ValueType): Promise<void> {
    if (type === ValueType.STRING) {
      this.skip(await this.u64());
      return;
    }
    if (type === ValueType.ARRAY) {
      const elementType = (await this.u32()) as ValueType;
      const count = await this.u64();
      const size = FIXED_SIZE[elementType];
      if (size) {
        this.skip(size * count);
        return;
      }
      for (let index = 0; index < count; index += 1) await this.skipValue(elementType);
      return;
    }
    const size = FIXED_SIZE[type];
    if (!size) throw new Error(`GGUF header uses unknown value type ${type}.`);
    this.skip(size);
  }
}

export async function readGgufMetadata(path: string): Promise<GgufMetadata> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const reader = new Reader(handle, size);

    if ((await reader.u32()) !== MAGIC) throw new Error(`${path} is not a GGUF file.`);
    const version = await reader.u32();
    // Version 1 used 32-bit counts and has not been written by anything current in years.
    if (version < 2) throw new Error(`${path} is GGUF version ${version}, which is too old to read.`);
    const tensorCount = await reader.u64();
    const keyCount = await reader.u64();

    const found: GgufMetadata = {
      version,
      tensorCount,
      architecture: null,
      name: null,
      contextLength: null,
      fileType: null,
    };
    const contextLengths = new Map<string, number>();

    for (let index = 0; index < keyCount; index += 1) {
      if (reader.position > MAX_HEADER_BYTES) break;
      const key = await reader.string();
      const type = (await reader.u32()) as ValueType;

      if (type === ValueType.STRING && (key === 'general.architecture' || key === 'general.name')) {
        const value = await reader.string();
        if (key === 'general.architecture') found.architecture = value;
        else found.name = value;
      } else if (key.endsWith('.context_length') || key === 'general.file_type') {
        const value = await reader.scalar(type);
        if (value === null) await reader.skipValue(type);
        else if (key === 'general.file_type') found.fileType = value;
        else contextLengths.set(key.slice(0, -'.context_length'.length), value);
      } else {
        await reader.skipValue(type);
      }

      // Everything wanted is in hand; the rest of the header is tokenizer tables.
      if (found.architecture && contextLengths.has(found.architecture) && found.fileType !== null) break;
    }

    if (found.architecture) found.contextLength = contextLengths.get(found.architecture) ?? null;
    return found;
  } finally {
    await handle.close();
  }
}
