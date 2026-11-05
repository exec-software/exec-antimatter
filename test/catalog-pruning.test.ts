import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from '../src/api/types';
import { mergeProbedModels } from '../src/main/probe';

const probed = (id: string) => ({ id });
const ids = (models: Model[]) => models.map((model) => model.id).sort();

test('an id the source has stopped listing is dropped', () => {
  // The reported case: beholdd reports its loaded engine beside its configured models, so a probe
  // taken while MiMo was up adopted the engine alias, which then never resolved again.
  const configured: Model[] = [
    { id: 'mimo-v26-flash', name: 'mimo-v26-flash' },
    { id: 'MiMo-V2.6-Flash-RL-MXFP4', name: 'MiMo-V2.6-Flash-RL-MXFP4' },
  ];
  const merged = mergeProbedModels(configured, [probed('mimo-v26-flash')]);
  assert.deepEqual(ids(merged), ['mimo-v26-flash']);
});

test('a model the user declared by hand is kept even when unlisted', () => {
  // A server that serves more than it advertises is exactly why declaring one by hand exists.
  const configured: Model[] = [
    { id: 'listed', name: 'listed' },
    { id: 'hand-written', name: 'hand-written', manuallyDeclared: true },
  ];
  const merged = mergeProbedModels(configured, [probed('listed')]);
  assert.deepEqual(ids(merged), ['hand-written', 'listed']);
});

test('an empty observation never empties the picker', () => {
  const configured: Model[] = [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }];
  const merged = mergeProbedModels(configured, []);
  assert.equal(merged, configured, 'nothing changed, so the same array comes back');
  assert.deepEqual(ids(merged), ['a', 'b']);
});

test('newly listed models are still added', () => {
  const merged = mergeProbedModels([{ id: 'a', name: 'a' }], [probed('a'), probed('b')]);
  assert.deepEqual(ids(merged), ['a', 'b']);
});

test('adding and removing in the same refresh both take effect', () => {
  const configured: Model[] = [{ id: 'gone', name: 'gone' }, { id: 'kept', name: 'kept' }];
  const merged = mergeProbedModels(configured, [probed('kept'), probed('new')]);
  assert.deepEqual(ids(merged), ['kept', 'new']);
});

test('an unchanged catalog is returned as the same array, so nothing is rewritten', () => {
  const configured: Model[] = [{ id: 'a', name: 'a' }];
  assert.equal(mergeProbedModels(configured, [probed('a')]), configured);
});

test('curated metadata on a still-listed model survives a refresh', () => {
  const configured: Model[] = [
    { id: 'a', name: 'Nice name', contextWindow: 65_536, contextWindowCurated: true },
    { id: 'stale', name: 'stale' },
  ];
  const merged = mergeProbedModels(configured, [probed('a')]);
  assert.deepEqual(ids(merged), ['a']);
  assert.equal(merged[0].contextWindow, 65_536);
  assert.equal(merged[0].contextWindowCurated, true);
});
