import assert from 'node:assert/strict';
import test from 'node:test';
import type { InferenceSource } from '../src/main/sourceStore';
import { declareModel, removeDeclaredModel, updateModelMetadata } from '../src/main/modelCatalog';
import { mergeProbedModels } from '../src/main/probe';

const configured = (): InferenceSource => ({
  id: 'private-source',
  name: 'Private source',
  apiKey: 'stored-secret',
  baseUrl: 'https://models.example/v1',
  models: [{ id: 'server-model', name: 'Server model', contextWindow: 32_768 }],
  supportsStreaming: true,
  kind: 'openai',
  createdAt: 1,
});

test('declaring a model adds normalized durable metadata without touching the source credential', () => {
  const source = configured();
  const next = declareModel(source, {
    id: '  org/nemotron-super  ',
    name: '  Nemotron Super  ',
    architecture: '  nemotron_h_moe ',
    quantization: ' Q4_K_M ',
    contextWindow: 131_072,
    vision: false,
  });

  assert.equal(next.apiKey, 'stored-secret');
  assert.equal(source.models.length, 1, 'catalog operations do not mutate the caller');
  assert.deepEqual(next.models[1], {
    id: 'org/nemotron-super',
    name: 'Nemotron Super',
    architecture: 'nemotron_h_moe',
    quantization: 'Q4_K_M',
    contextWindow: 131_072,
    vision: false,
    manuallyDeclared: true,
    contextWindowCurated: true,
    visionCurated: true,
  });
  assert.throws(() => declareModel(next, { id: 'org/nemotron-super' }), /already declared/);
});

test('metadata editing keeps model identity and declaration origin while allowing optional values to clear', () => {
  const declared = declareModel(configured(), { id: 'manual', architecture: 'qwen3' });
  const next = updateModelMetadata(declared, 'manual', {
    name: 'Manual model',
    architecture: null,
    quantization: 'Q8_0',
    contextWindow: 65_536,
    vision: true,
  });

  assert.deepEqual(next.models[1], {
    id: 'manual',
    name: 'Manual model',
    nameCurated: true,
    quantization: 'Q8_0',
    contextWindow: 65_536,
    vision: true,
    manuallyDeclared: true,
    contextWindowCurated: true,
    visionCurated: true,
  });
  assert.equal(next.apiKey, 'stored-secret');
  assert.throws(
    () => updateModelMetadata(next, 'manual', { name: '   ' }),
    /Display name is required/
  );
});

test('a partial metadata patch preserves existing values and their curated provenance', () => {
  const declared = declareModel(configured(), {
    id: 'manual',
    architecture: 'qwen3',
    contextWindow: 65_536,
    vision: false,
  });
  const renamed = updateModelMetadata(declared, 'manual', { name: 'Renamed only' });

  assert.deepEqual(renamed.models[1], {
    id: 'manual',
    name: 'Renamed only',
    nameCurated: true,
    architecture: 'qwen3',
    contextWindow: 65_536,
    vision: false,
    manuallyDeclared: true,
    contextWindowCurated: true,
    visionCurated: true,
  });

  const unknown = updateModelMetadata(renamed, 'manual', {
    name: 'Explicitly unknown',
    contextWindow: null,
    vision: null,
  });
  assert.deepEqual(unknown.models[1], {
    id: 'manual',
    name: 'Explicitly unknown',
    nameCurated: true,
    architecture: 'qwen3',
    manuallyDeclared: true,
    contextWindowCurated: true,
    visionCurated: true,
  });
});

test('removal is limited to explicitly declared entries', () => {
  const source = declareModel(configured(), { id: 'manual' });
  assert.throws(() => removeDeclaredModel(source, 'server-model'), /managed by its source/);
  const next = removeDeclaredModel(source, 'manual');
  assert.deepEqual(next.models.map((model) => model.id), ['server-model']);
  assert.equal(next.apiKey, 'stored-secret');
});

test('renamed discovered cards survive refresh and temporarily missing catalog entries', () => {
  const renamed = updateModelMetadata(configured(), 'server-model', { name: 'My model' });
  const refreshed = mergeProbedModels(renamed.models, [{ id: 'server-model', name: 'Server model' }]);
  assert.equal(refreshed[0].name, 'My model');
  assert.equal(refreshed[0].nameCurated, true);
  const missing = mergeProbedModels(refreshed, [{ id: 'another-model', name: 'Another' }]);
  assert.equal(missing.find((model) => model.id === 'server-model')?.name, 'My model');
});

test('hiding and restoring are source-scoped, survive discovery, and preserve model identity', () => {
  const source = configured();
  const hidden = updateModelMetadata(source, 'server-model', { name: 'Server model', hidden: true, deployment: 'distributed' });
  assert.equal(source.models[0].hidden, undefined);
  assert.equal(hidden.apiKey, source.apiKey);
  const refreshed = mergeProbedModels(hidden.models, [{ id: 'server-model', name: 'Server model' }]);
  assert.equal(refreshed[0].hidden, true);
  assert.equal(refreshed[0].deployment, 'distributed');
  const missing = mergeProbedModels(refreshed, [{ id: 'new', name: 'New' }]);
  assert.equal(missing.find((model) => model.id === 'server-model')?.hidden, true);
  const restored = updateModelMetadata({ ...hidden, models: missing }, 'server-model', { name: 'Server model', hidden: false });
  assert.equal(restored.models[0].hidden, false);
  assert.equal(restored.models[0].deployment, 'distributed');
  assert.throws(() => updateModelMetadata(source, 'server-model', { name: 'Server model', deployment: 'other' as never }), /category/);
  assert.throws(() => updateModelMetadata(source, 'server-model', { name: 'Server model', hidden: 'yes' as never }), /Hidden/);
});

test('metadata edits preserve observed execution limits and cannot replace them', () => {
  for (const maxEvaluatedTokens of [128, null]) {
    const source = configured();
    source.models[0].maxEvaluatedTokens = maxEvaluatedTokens;
    const renamed = updateModelMetadata(source, 'server-model', {
      name: 'Renamed', contextWindow: 131_072,
      // IPC input cannot promote a server fact into an editable preference.
      ...({ maxEvaluatedTokens: 8192 } as object),
    });
    assert.equal(renamed.models[0].maxEvaluatedTokens, maxEvaluatedTokens);
    assert.equal(renamed.models[0].contextWindow, 131_072);
    assert.equal(source.models[0].name, 'Server model');
  }
});
