import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rememberInteractiveTurn,
  resetInteractiveTurn,
  resolveRunnerModel,
  resolveRunnerSource,
} from '../src/main/runnerSource';

const sources = [
  { id: 'stopped-deepseek', name: 'DeepSeek (local)', models: [{ id: 'DeepSeek-V4-Flash-0731-UD-Q2_K_XL' }] },
  { id: 'live-stripe', name: 'Qwen3-235B striped', models: [{ id: 'qwen3-235b-a22b-q5_k_m' }] },
];

test('a pinned provider wins, by id or by display name', (t) => {
  t.after(resetInteractiveTurn);
  resetInteractiveTurn();
  rememberInteractiveTurn({ providerId: 'live-stripe', model: 'qwen3-235b-a22b-q5_k_m' });

  // The pin is a hard constraint for unattended determinism: the chat must not override it.
  assert.equal(resolveRunnerSource(sources, 'stopped-deepseek')!.id, 'stopped-deepseek');
  assert.equal(resolveRunnerSource(sources, 'DeepSeek (local)')!.id, 'stopped-deepseek');
  // A pin that names nothing resolves to nothing, so the page reports it rather than
  // silently running on some other model than the workflow asked for.
  assert.equal(resolveRunnerSource(sources, 'beholdd GPU (Vulkan)'), undefined);
});

test('an unpinned runner follows the chat instead of whatever is first in the list', (t) => {
  t.after(resetInteractiveTurn);
  resetInteractiveTurn();
  // With no chat yet there is nothing to follow, so list order is still the only answer.
  assert.equal(resolveRunnerSource(sources, null)!.id, 'stopped-deepseek');

  rememberInteractiveTurn({ providerId: 'live-stripe', model: 'qwen3-235b-a22b-q5_k_m' });
  assert.equal(resolveRunnerSource(sources, null)!.id, 'live-stripe');
  assert.equal(resolveRunnerModel(sources[1]!, null), 'qwen3-235b-a22b-q5_k_m');
});

test('an agent run cannot redefine the default it was dispatched under', (t) => {
  t.after(resetInteractiveTurn);
  resetInteractiveTurn();
  rememberInteractiveTurn({ providerId: 'live-stripe', model: 'qwen3-235b-a22b-q5_k_m' });
  // Only renderer-owned turns reach rememberInteractiveTurn; a partial record is ignored so a
  // malformed request cannot blank the default either.
  rememberInteractiveTurn({ providerId: 'stopped-deepseek', model: null });
  rememberInteractiveTurn({ providerId: null, model: 'something' });
  assert.equal(resolveRunnerSource(sources, null)!.id, 'live-stripe');
});

test('the model follows the chat only when it belongs to the same source', (t) => {
  t.after(resetInteractiveTurn);
  resetInteractiveTurn();
  rememberInteractiveTurn({ providerId: 'live-stripe', model: 'qwen3-235b-a22b-q5_k_m' });
  // Inheriting a model name across sources would ask a server for something it does not serve.
  assert.equal(resolveRunnerModel(sources[0]!, null), 'DeepSeek-V4-Flash-0731-UD-Q2_K_XL');
  assert.equal(resolveRunnerModel(sources[1]!, null), 'qwen3-235b-a22b-q5_k_m');
  // An explicit model pin still wins over both.
  assert.equal(resolveRunnerModel(sources[1]!, 'pinned-model'), 'pinned-model');
  assert.equal(resolveRunnerModel({ id: 'x', name: 'X', models: [] }, null), undefined);
});
