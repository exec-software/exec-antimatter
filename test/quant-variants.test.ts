import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverQuantVariants, modelRootFor, quantFromName } from '../src/main/quantVariants';

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'quantvar-'));
  return dir;
}

/** Write a file of `size` bytes at `rel` under `root`. */
function put(root: string, rel: string, size: number): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, Buffer.alloc(size));
}

test('a quant label is read from the file name, not from a model name that looks like one', () => {
  // `Qwen3` must not read as a quantization: the pattern requires a digit straight after Q.
  assert.equal(quantFromName('Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf'), 'Q4_K_M');
  assert.equal(quantFromName('Qwen3-Omni-30B-A3B-Thinking-Q8_0.gguf'), 'Q8_0');
  assert.equal(quantFromName('OpenMythos-27B-Q6_K.gguf'), 'Q6_K');
  assert.equal(quantFromName('gpt-oss-20b-F16.gguf'), 'F16');
  assert.equal(quantFromName('Qwen3.8-27B-BF16-00001-of-00002.gguf'), 'BF16');
});

test('Unsloth dynamic quants keep their UD- prefix, which is part of the identity', () => {
  assert.equal(quantFromName('GLM-5.3-UD-Q2_K_XL-00006-of-00007.gguf'), 'UD-Q2_K_XL');
  assert.equal(quantFromName('DeepSeek-V4-Flash-0731-UD-Q2_K_XL-00001-of-00003.gguf'),
               'UD-Q2_K_XL');
  assert.equal(quantFromName('Qwen3-VL-235B-A22B-Instruct-UD-Q5_K_XL-00003-of-00004.gguf'),
               'UD-Q5_K_XL');
  assert.notEqual(quantFromName('GLM-5.3-UD-Q2_K_XL-00001-of-00007.gguf'), 'Q2_K_XL');
});

test('a name carrying no quantization reports none rather than guessing', () => {
  assert.equal(quantFromName('model.gguf'), null);
  assert.equal(quantFromName('Qwen3-Coder-Next.gguf'), null);
});

test('one directory per quant is collapsed to one variant each, cheapest first', (t) => {
  const root = scratch(t);
  put(root, 'Q6_K/OpenMythos-27B-Q6_K.gguf', 600);
  put(root, 'Q4_K/OpenMythos-27B-Q4_K.gguf', 400);
  const got = discoverQuantVariants(root);
  assert.deepEqual(got.map((v) => v.quant), ['Q4_K', 'Q6_K']);
  assert.deepEqual(got.map((v) => v.bytes), [400, 600]);
  assert.deepEqual(got.map((v) => v.shards), [1, 1]);
});

test('a directory of safetensors yields nothing, because it cannot be served', (t) => {
  const root = scratch(t);
  put(root, 'BF16/model-00001-of-00002.safetensors', 900);
  put(root, 'BF16/config.json', 10);
  put(root, 'Q4_K/OpenMythos-27B-Q4_K.gguf', 400);
  assert.deepEqual(discoverQuantVariants(root).map((v) => v.quant), ['Q4_K']);
});

test('a split set is one variant: shard 1 is the path and bytes are the whole set', (t) => {
  const root = scratch(t);
  for (let i = 1; i <= 3; i += 1) {
    put(root, `UD-Q2_K_XL/DeepSeek-V4-Flash-0731-UD-Q2_K_XL-0000${i}-of-00003.gguf`, 100);
  }
  const got = discoverQuantVariants(root);
  assert.equal(got.length, 1);
  assert.equal(got[0].quant, 'UD-Q2_K_XL');
  assert.equal(got[0].bytes, 300);
  assert.equal(got[0].shards, 3);
  assert.match(got[0].path, /-00001-of-00003\.gguf$/);
});

test('a set whose first shard is missing is not offered, because it cannot be loaded', (t) => {
  const root = scratch(t);
  put(root, 'UD-Q2_K_XL/GLM-5.3-UD-Q2_K_XL-00002-of-00007.gguf', 100);
  put(root, 'UD-Q2_K_XL/GLM-5.3-UD-Q2_K_XL-00003-of-00007.gguf', 100);
  assert.deepEqual(discoverQuantVariants(root), []);
});

test('companion files beside a model are never offered as models', (t) => {
  const root = scratch(t);
  put(root, 'Qwen3-Omni-30B-A3B-Thinking-Q8_0.gguf', 500);
  put(root, 'mmproj-Qwen3-Omni-30B-A3B-Thinking-Q8_0.gguf', 50);
  put(root, 'mtp-MiMo-V2.6-Flash-RL-Q8_0.gguf', 40);
  put(root, 'dflash-MiMo-V2.6-Flash-RL-Q8_0.gguf', 30);
  put(root, 'imatrix-dsv41-262144.gguf', 20);
  const got = discoverQuantVariants(root);
  assert.equal(got.length, 1);
  assert.equal(got[0].bytes, 500);
});

test('a model-named directory still resolves, because the file name carries the quant', (t) => {
  const root = scratch(t);
  for (let i = 1; i <= 2; i += 1) {
    put(root, `Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M-0000${i}-of-00002.gguf`, 100);
  }
  assert.deepEqual(discoverQuantVariants(root).map((v) => v.quant), ['Q4_K_M']);
});

test('a bare quant directory resolves from the directory when the file name is silent', (t) => {
  const root = scratch(t);
  put(root, 'Q6_K/model.gguf', 100);
  assert.deepEqual(discoverQuantVariants(root).map((v) => v.quant), ['Q6_K']);
});

test('a relative or empty directory is refused rather than scanned from the cwd', () => {
  assert.deepEqual(discoverQuantVariants(''), []);
  assert.deepEqual(discoverQuantVariants('Models/openmythos-27b'), []);
});

test('a missing directory reports nothing instead of throwing', () => {
  assert.deepEqual(discoverQuantVariants(join(tmpdir(), 'quantvar-absent-' + Date.now())), []);
});

test('depth is bounded, so a models root is not walked end to end', (t) => {
  const root = scratch(t);
  put(root, 'a/b/c/Deep-Q4_K.gguf', 100);
  assert.deepEqual(discoverQuantVariants(root, 2), []);
  assert.deepEqual(discoverQuantVariants(root, 3).map((v) => v.quant), ['Q4_K']);
});

// modelRootFor decides WHERE to look for sibling quantizations, from the path a service is
// already serving, so no new configuration is needed to find them. Getting it inverted is not
// cosmetic: treating a flat model's parent as a quant directory would make the models root the
// search root and offer every model on the disk as a quantization of this one.

test('a quant-named parent means the model root is one level up', () => {
  assert.equal(modelRootFor('/m/openmythos-27b/Q4_K/OpenMythos-27B-Q4_K.gguf'), '/m/openmythos-27b');
  assert.equal(modelRootFor('/m/glm-5.3/UD-Q2_K_XL/GLM-5.3-UD-Q2_K_XL-00001-of-00007.gguf'), '/m/glm-5.3');
  assert.equal(modelRootFor('/m/qwen3.8-27b/BF16/Qwen3.8-27B-BF16-00001-of-00002.gguf'), '/m/qwen3.8-27b');
  // A directory named for the model AND its quant is still a quant directory.
  assert.equal(modelRootFor('/m/qwen3-coder-next/Qwen3-Coder-Next-Q4_K_M/x-00001-of-00004.gguf'),
               '/m/qwen3-coder-next');
});

test('a flat layout keeps the model’s own directory as the root', () => {
  // The hazard: returning '/m' here would enumerate every model on the disk.
  assert.equal(modelRootFor('/m/qwen3-omni-30b/Qwen3-Omni-30B-A3B-Thinking-Q8_0.gguf'),
               '/m/qwen3-omni-30b');
  assert.equal(modelRootFor('/m/gpt-oss-20b/gpt-oss-20b-F16.gguf'), '/m/gpt-oss-20b');
});

test('modelRootFor refuses what it cannot anchor', () => {
  assert.equal(modelRootFor(''), null);
  assert.equal(modelRootFor('relative/x.gguf'), null);
  assert.equal(modelRootFor('/x.gguf'), null);          // the filesystem root is not a model
});

test('a model holding one quantization yields exactly one variant', (t) => {
  // The store offers a choice only above one, so this is the boundary that makes that rule mean
  // something: a single-quant model must not report two.
  const root = scratch(t);
  put(root, 'Q6_K/OpenMythos-27B-Q6_K.gguf', 600);
  put(root, 'BF16/model-00001-of-00002.safetensors', 900);
  put(root, 'Q6_K/mmproj-OpenMythos-27B-Q6_K.gguf', 50);
  assert.equal(discoverQuantVariants(root).length, 1);
});

test('discovery anchored on a served path finds its siblings', (t) => {
  // End to end: the two functions compose the way the store composes them.
  const root = scratch(t);
  put(root, 'Q4_K/OpenMythos-27B-Q4_K.gguf', 400);
  put(root, 'Q6_K/OpenMythos-27B-Q6_K.gguf', 600);
  const serving = join(root, 'Q6_K/OpenMythos-27B-Q6_K.gguf');
  const anchored = modelRootFor(serving)!;
  assert.equal(anchored, root);
  assert.deepEqual(discoverQuantVariants(anchored).map((v) => v.quant), ['Q4_K', 'Q6_K']);
});
