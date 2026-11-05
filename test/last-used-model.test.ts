import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderConfig } from '../src/api/types';
import { resolveAgentModel } from '../src/main/agents/modelResolution';
import { createLastUsedModel } from '../src/main/lastUsedModel';

const source = (id: string, model: string): ProviderConfig => ({
  id,
  name: id,
  apiKey: '',
  baseUrl: `https://${id}.invalid/v1`,
  models: [{ id: model, name: model }],
  supportsStreaming: true,
});

test('a picker selection becomes the straight-routing fallback before the first chat turn', () => {
  const cpu = source('cpu', 'local-model');
  const cloud = source('cloud', 'cloud-model');
  const selected = createLastUsedModel({ providerId: cpu.id, modelId: 'local-model' });

  // This is the transition performed by model:set; no chat:stream or agents:useSource happened.
  selected.select(cloud.id, 'cloud-model');

  assert.deepEqual(resolveAgentModel([cpu, cloud], null, null, selected.read()), {
    source: cloud,
    model: 'cloud-model',
  });
});

test('a source with no selected model does not leave a stale agent fallback behind', () => {
  const selected = createLastUsedModel({ providerId: 'cpu', modelId: 'local-model' });
  assert.equal(selected.select('empty-source', ''), null);
  assert.equal(selected.read(), null);
});
