import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as modelChoice from '../src/main/modelChoice';

const scratch = (t: { after(fn: () => void): void }) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-model-choice-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'userData', 'model.json');
};

test('the choice is one private file that the next launch reads back', (t) => {
  const path = scratch(t);
  modelChoice.useConfigPath(path);
  assert.equal(modelChoice.read(), null, 'a fresh install has no choice');

  modelChoice.save({ providerId: 'gpu', modelId: 'qwen3-coder-next-80b' });
  assert.equal(statSync(path).mode & 0o777, 0o600);

  // Pointing at the same path again drops the cache, which is what a restart does.
  modelChoice.useConfigPath(path);
  assert.deepEqual(modelChoice.read(), { providerId: 'gpu', modelId: 'qwen3-coder-next-80b' });

  modelChoice.save({ providerId: 'gpu', modelId: 'gpt-oss-120b-fable5' });
  modelChoice.useConfigPath(path);
  assert.equal(modelChoice.read()?.modelId, 'gpt-oss-120b-fable5', 'the last pick replaces the one before');
});

test('a source picked before it listed any model is still remembered', (t) => {
  modelChoice.useConfigPath(scratch(t));
  modelChoice.save({ providerId: 'bundled', modelId: '' });
  assert.deepEqual(modelChoice.read(), { providerId: 'bundled', modelId: '' });
});

test('a choice without a source is refused rather than written', (t) => {
  const path = scratch(t);
  modelChoice.useConfigPath(path);
  assert.throws(() => modelChoice.save({ providerId: '', modelId: 'qwen3-coder-next-80b' }), /source/);
  assert.equal(modelChoice.read(), null);
});

test('a stale app-managed choice can be cleared without leaving a cached selection', (t) => {
  const path = scratch(t);
  modelChoice.useConfigPath(path);
  modelChoice.save({ providerId: 'bundled-llama-vulkan', modelId: 'qwen3-coder-30b' });
  modelChoice.clear();
  assert.equal(modelChoice.read(), null);
  modelChoice.useConfigPath(path);
  assert.equal(modelChoice.read(), null);
});

test('an unreadable or foreign file reads as no choice', (t) => {
  const path = scratch(t);
  mkdirSync(join(path, '..'), { recursive: true });
  for (const contents of [
    '{ not json',
    'null',
    JSON.stringify({ version: 2, providerId: 'gpu', modelId: 'm' }),
    JSON.stringify({ version: 1, modelId: 'm' }),
    JSON.stringify({ version: 1, providerId: 'gpu', modelId: 7 }),
  ]) {
    writeFileSync(path, contents);
    modelChoice.useConfigPath(path);
    assert.equal(modelChoice.read(), null, contents);
  }
});
