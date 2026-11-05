import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConversationModel } from '../renderer/src/lib/modelSelection';
import type { ProviderConfig } from '../renderer/src/types';

const source = (id: string, models: string[]): ProviderConfig => ({
  id,
  name: id,
  baseUrl: `https://${id}.example/v1`,
  supportsStreaming: true,
  credentialConfigured: true,
  kind: 'openai',
  protocol: 'openai-responses',
  models: models.map((model) => ({ id: model, name: model })),
});

test('a saved conversation never falls through to another source when its exact source is removed', () => {
  const result = resolveConversationModel(
    [source('personal-openai', ['gpt']), source('work-anthropic', ['claude'])],
    'personal-openai',
    'gpt',
    { providerId: 'removed-private-source', modelId: 'private-model' }
  );

  assert.equal(result.provider, undefined);
  assert.equal(result.model, undefined);
  assert.match(result.unavailableReason ?? '', /source is unavailable/i);
});

test('a saved conversation never falls through to another model on the same source', () => {
  const result = resolveConversationModel(
    [source('personal-openai', ['new-model'])],
    'personal-openai',
    'new-model',
    { providerId: 'personal-openai', modelId: 'removed-model' }
  );

  assert.equal(result.provider?.id, 'personal-openai');
  assert.equal(result.model, undefined);
  assert.match(result.unavailableReason ?? '', /model is unavailable/i);
});

test('a configured source with no declared models is unavailable with an actionable reason', () => {
  const result = resolveConversationModel(
    [source('opencode-zen', [])],
    'opencode-zen',
    '',
    { providerId: 'opencode-zen' }
  );

  assert.equal(result.provider?.id, 'opencode-zen');
  assert.equal(result.model, undefined);
  assert.match(result.unavailableReason ?? '', /no configured models/i);
});

test('only an unpinned conversation may use the current or first available source', () => {
  const providers = [source('first', ['one']), source('active', ['two'])];
  assert.deepEqual(resolveConversationModel(providers, 'active', 'two', null), {
    provider: providers[1],
    model: providers[1].models[0],
  });
  assert.deepEqual(resolveConversationModel(providers, 'gone', 'gone', null), {
    provider: providers[0],
    model: providers[0].models[0],
  });
});
