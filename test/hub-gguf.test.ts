import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { forkQuantizationReason, readGgufMetadata } from '../src/main/hub/gguf';

type Value =
  | { type: 'string'; value: string }
  | { type: 'u32'; value: number }
  | { type: 'u64'; value: number }
  | { type: 'f32'; value: number }
  | { type: 'strings'; value: string[] }
  | { type: 'u32s'; value: number[] };

const u32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};
const u64 = (value: number) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
};
const str = (value: string) => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);

/** A minimal GGUF v3 header, written the way llama.cpp's converter orders its keys. */
function gguf(entries: [string, Value][], version = 3): Buffer {
  const parts = [Buffer.from('GGUF'), u32(version), u64(0), u64(entries.length)];
  for (const [key, entry] of entries) {
    parts.push(str(key));
    switch (entry.type) {
      case 'string':
        parts.push(u32(8), str(entry.value));
        break;
      case 'u32':
        parts.push(u32(4), u32(entry.value));
        break;
      case 'u64':
        parts.push(u32(10), u64(entry.value));
        break;
      case 'f32': {
        const float = Buffer.alloc(4);
        float.writeFloatLE(entry.value);
        parts.push(u32(6), float);
        break;
      }
      case 'strings':
        parts.push(u32(9), u32(8), u64(entry.value.length), ...entry.value.map(str));
        break;
      case 'u32s':
        parts.push(u32(9), u32(4), u64(entry.value.length), ...entry.value.map(u32));
        break;
    }
  }
  return Buffer.concat(parts);
}

test('reads architecture, name, trained context and file type from a GGUF header', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-gguf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'model.gguf');

  writeFileSync(
    path,
    gguf([
      ['general.architecture', { type: 'string', value: 'qwen3moe' }],
      ['general.name', { type: 'string', value: 'Qwen3 Coder 30B A3B Instruct' }],
      ['qwen3moe.block_count', { type: 'u32', value: 48 }],
      ['llama.context_length', { type: 'u32', value: 4096 }],
      ['qwen3moe.context_length', { type: 'u32', value: 262144 }],
      ['qwen3moe.rope.freq_base', { type: 'f32', value: 10000000 }],
      // Tokenizer tables are the bulk of any header: stepped over, never kept.
      ['tokenizer.ggml.tokens', { type: 'strings', value: Array.from({ length: 5000 }, (_, index) => `token-${index}`) }],
      ['tokenizer.ggml.token_type', { type: 'u32s', value: Array.from({ length: 5000 }, () => 1) }],
      ['general.file_type', { type: 'u32', value: 7 }],
      ['split.count', { type: 'u64', value: 3 }],
      ['tokenizer.chat_template', { type: 'string', value: '{{ messages }}' }],
    ])
  );

  return readGgufMetadata(path).then((metadata) => {
    assert.deepEqual(metadata, {
      version: 3,
      tensorCount: 0,
      architecture: 'qwen3moe',
      name: 'Qwen3 Coder 30B A3B Instruct',
      contextLength: 262144,
      fileType: 7,
    });
  });
});

test('refuses files that are not GGUF, are too old, or end inside their header', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-gguf-bad-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const notGguf = join(root, 'weights.safetensors');
  writeFileSync(notGguf, Buffer.from('{"__metadata__":{}}'));
  await assert.rejects(readGgufMetadata(notGguf), /not a GGUF file/);

  const old = join(root, 'old.gguf');
  writeFileSync(old, gguf([], 1));
  await assert.rejects(readGgufMetadata(old), /too old/);

  const truncated = join(root, 'truncated.gguf');
  const whole = gguf([['general.architecture', { type: 'string', value: 'llama' }]]);
  writeFileSync(truncated, whole.subarray(0, whole.length - 3));
  await assert.rejects(readGgufMetadata(truncated), /past the end|ended early/);
});

test('a quantization from a llama.cpp fork is named, and mainline ones are left alone', () => {
  // 139 is what ubergarm's Kimi-Dev-72B-smol-IQ3_K carries: ik_llama.cpp's IQ*_K range, which a
  // mainline build exits on rather than loads.
  const reason = forkQuantizationReason(139);
  assert.match(reason!, /general\.file_type 139/);
  assert.match(reason!, /ik_llama\.cpp/);
  assert.ok(forkQuantizationReason(100), 'the fork range is inclusive at its start');
  assert.ok(forkQuantizationReason(1023), 'and at its end');

  // Mainline: Q8_0, the Fable distill's Q5_0, MXFP4, and the GUESSED sentinel above the range.
  for (const fileType of [0, 7, 8, 15, 38, 99, 1024]) {
    assert.equal(forkQuantizationReason(fileType), null, `file type ${fileType} is mainline`);
  }

  // A header that does not say, or was never read, is not a reason to refuse the file.
  assert.equal(forkQuantizationReason(null), null);
  assert.equal(forkQuantizationReason(undefined), null);
});
