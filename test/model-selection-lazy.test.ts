import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderManager } from '../src/api/providers';
import type { ProviderConfig } from '../src/api/types';
import { selectModel } from '../src/main/modelSelection';
import type { ModelChoice } from '../src/main/modelChoice';

function fixture() {
  const sources: ProviderConfig[] = ['local-openmythos-27b', 'local-qwen3-omni-30b', 'local-qwen3-coder-30b', 'bundled-hag-experimental'].map((id) => ({
    id, name: id, kind: id === 'bundled-hag-experimental' ? 'beholdd' : 'llama-cpp',
    protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:6769/v1', apiKey: '', supportsStreaming: true,
    models: [{ id: `${id}-model`, name: id }],
  }));
  const manager = ProviderManager.fromConfigs(sources);
  const prepared: string[] = [];
  manager.usePrepareProvider(async (id) => { prepared.push(id); throw new Error('Selecting or restoring a choice must not prepare a model.'); });
  const saved: ModelChoice[] = [], selected: ModelChoice[] = [];
  const deps = {
    source: (id: string) => manager.getConfig(id),
    hasWorkload: (_provider: string, _model: string, id: string) => id === 'deep',
    save: (choice: ModelChoice) => { saved.push(choice); return choice; },
    selected: (choice: ModelChoice) => { selected.push(choice); },
  };
  return { sources, manager, prepared, saved, selected, deps };
}

test('picker changes and restored legacy choices persist without starting any local model', () => {
  const f = fixture();
  for (const source of f.sources) {
    const choice = { providerId: source.id, modelId: source.models[0].id };
    // App startup migrates its old remembered choice through the same model:set handler.
    assert.deepEqual(selectModel(choice.providerId, choice.modelId, undefined, f.deps), choice);
    assert.deepEqual(f.saved.at(-1), choice);
    assert.deepEqual(f.selected.at(-1), choice);
    assert.equal(f.manager.anyBusy(), false);
  }
  assert.deepEqual(f.prepared, []);
  assert.equal(f.saved.length, f.sources.length);
});

test('unknown source or model is refused before changing the durable or last-used choice', () => {
  const f = fixture();
  assert.throws(() => selectModel('missing', 'model', undefined, f.deps));
  assert.throws(() => selectModel(f.sources[0].id, 'missing', undefined, f.deps));
  assert.deepEqual(f.saved, []); assert.deepEqual(f.selected, []); assert.deepEqual(f.prepared, []);
});

test('a valid workload is remembered and a deleted or invalid workload falls back without preparation', () => {
  const f = fixture();
  const source = f.sources[0];
  const choice = { providerId: source.id, modelId: source.models[0].id };
  assert.deepEqual(selectModel(choice.providerId, choice.modelId, 'deep', f.deps), { ...choice, workloadId: 'deep' });
  for (const workload of ['deleted', null, 12, {}]) {
    assert.deepEqual(selectModel(choice.providerId, choice.modelId, workload, f.deps), choice);
  }
  assert.deepEqual(f.prepared, []);
});
