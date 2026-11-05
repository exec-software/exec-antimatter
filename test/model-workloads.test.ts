import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createWorkload,
  listWorkloads,
  removeWorkload,
  resolve,
  hasWorkload,
  setDefaultWorkload,
  setOverride,
  storedModels,
  updateWorkload,
  useConfigPath,
  overrides,
} from '../src/main/modelProfiles';
import { assertWorkloadSettings, assertWorkloadId } from '../src/api/modelWorkloads';
import * as modelChoice from '../src/main/modelChoice';

/** A scratch store, optionally seeded with a file written by an older build. */
const scratch = (t: { after(fn: () => unknown): void }, seed?: unknown) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-model-workloads-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'model-profiles.json');
  if (seed !== undefined) writeFileSync(file, JSON.stringify(seed, null, 2));
  useConfigPath(file);
  return file;
};

test('a pre-ADR-0001 store migrates to one Default workload and resolves identically', (t) => {
  // The exact shape an older build wrote: one anonymous override per model.
  const file = scratch(t, {
    version: 1,
    overrides: {
      'local::coder': { contextTokens: 32768, instructions: 'Small patches.', thinkingLevel: 'high' },
      'local::omni': { maxToolCallsPerMessage: 4 },
    },
  });

  const coder = listWorkloads('local', 'coder');
  assert.equal(coder.workloads.length, 1, 'one override becomes exactly one workload');
  assert.equal(coder.defaultId, 'default');
  assert.equal(coder.workloads[0].name, 'Default');
  assert.equal(coder.workloads[0].description, '');
  assert.deepEqual(coder.workloads[0].settings,
    { contextTokens: 32768, instructions: 'Small patches.', thinkingLevel: 'high' },
    'settings survive migration unchanged');

  // The migration contract: resolution is byte-identical to the old store's.
  const profile = resolve({ providerId: 'local', modelId: 'coder' });
  assert.equal(profile.contextTokens, 32768);
  assert.equal(profile.contextSource, 'override');
  assert.equal(profile.instructions, 'Small patches.');
  assert.equal(profile.thinkingLevel, 'high');
  assert.equal(resolve({ providerId: 'local', modelId: 'omni' }).maxToolCallsPerMessage, 4);

  // Both models carried over, and the legacy-shaped view still answers.
  assert.deepEqual(Object.keys(storedModels()).sort(), ['local::coder', 'local::omni']);
  assert.deepEqual(overrides()['local::omni'], { maxToolCallsPerMessage: 4 });

  // Reading alone must not rewrite the file; a write upgrades it to v2.
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1, 'a read is not a migration on disk');
  setOverride('local', 'coder', { compaction: 'drop' });
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.models['local::coder'].workloads.default.settings.compaction, 'drop');
  assert.equal(saved.models['local::coder'].workloads.default.settings.contextTokens, 32768,
    'merging into the default workload keeps the migrated settings');
});

test('a model carries many workloads, and the default is what resolves', (t) => {
  scratch(t);

  createWorkload('local', 'coder', { name: 'Wide window', description: 'One long read.', settings: { contextTokens: 262144 } });
  createWorkload('local', 'coder', { name: 'Fan out', settings: { contextTokens: 32768, maxToolCallsPerMessage: 8 } });

  const view = listWorkloads('local', 'coder');
  assert.equal(view.workloads.length, 2);
  assert.deepEqual(view.workloads.map((w) => w.id), ['wide-window', 'fan-out'], 'ids derive from the name');
  assert.equal(view.defaultId, 'wide-window', 'the first workload created becomes the default');
  assert.equal(view.workloads[0].description, 'One long read.');

  // Resolution follows the default, not creation order or the last write.
  assert.equal(resolve({ providerId: 'local', modelId: 'coder' }).contextTokens, 262144);
  setDefaultWorkload('local', 'coder', 'fan-out');
  assert.equal(resolve({ providerId: 'local', modelId: 'coder' }).contextTokens, 32768);
  assert.equal(resolve({ providerId: 'local', modelId: 'coder' }).maxToolCallsPerMessage, 8);

  // A second model is untouched by any of it.
  assert.deepEqual(listWorkloads('local', 'omni').workloads, []);
  assert.equal(listWorkloads('local', 'omni').defaultId, '');
});

test('colliding names get distinct ids rather than overwriting each other', (t) => {
  scratch(t);
  createWorkload('local', 'coder', { name: 'Review' });
  createWorkload('local', 'coder', { name: 'Review' });
  createWorkload('local', 'coder', { name: 'review!' });
  assert.deepEqual(listWorkloads('local', 'coder').workloads.map((w) => w.id), ['review', 'review-2', 'review-3']);
});

test('removing the default promotes another, and the last one leaving restores plain resolution', (t) => {
  scratch(t);
  createWorkload('local', 'coder', { name: 'First', settings: { contextTokens: 262144 } });
  createWorkload('local', 'coder', { name: 'Second', settings: { contextTokens: 65536 } });
  assert.equal(listWorkloads('local', 'coder').defaultId, 'first');

  const after = removeWorkload('local', 'coder', 'first');
  assert.equal(after.workloads.length, 1);
  assert.equal(after.defaultId, 'second', 'the default never dangles');
  assert.equal(resolve({ providerId: 'local', modelId: 'coder' }).contextTokens, 65536);

  // With no workloads the model resolves from server and catalog facts, as it did before any
  // override existed.
  const empty = removeWorkload('local', 'coder', 'second');
  assert.deepEqual(empty.workloads, []);
  const plain = resolve({ providerId: 'local', modelId: 'coder', serverContextTokens: 8192 });
  assert.equal(plain.contextTokens, 8192);
  assert.equal(plain.contextSource, 'server');
});

test('updates replace settings rather than merging, so a field can be cleared', (t) => {
  scratch(t);
  createWorkload('local', 'coder', { name: 'Draft', settings: { contextTokens: 262144, instructions: 'Be terse.' } });
  updateWorkload('local', 'coder', 'draft', { settings: { contextTokens: 262144 } });
  assert.deepEqual(listWorkloads('local', 'coder').workloads[0].settings, { contextTokens: 262144 });

  updateWorkload('local', 'coder', 'draft', { name: 'Renamed', description: 'Now explained.' });
  const [only] = listWorkloads('local', 'coder').workloads;
  assert.equal(only.name, 'Renamed');
  assert.equal(only.description, 'Now explained.');
  assert.deepEqual(only.settings, { contextTokens: 262144 }, 'a rename leaves settings alone');

  for (const call of [
    () => updateWorkload('local', 'coder', 'missing', { name: 'x' }),
    () => removeWorkload('local', 'coder', 'missing'),
    () => setDefaultWorkload('local', 'coder', 'missing'),
  ]) assert.throws(call, /no longer exists/);
  assert.throws(() => updateWorkload('local', 'nothing', 'draft', { name: 'x' }), /no workloads yet/);
});

test('clearing settings keeps named workloads but drops a lone migrated default', (t) => {
  scratch(t, { version: 1, overrides: { 'local::coder': { contextTokens: 32768 } } });
  // One workload and it is the migrated Default: clearing removes the model's entry, which is
  // what deleting its only override always did.
  setOverride('local', 'coder', null);
  assert.deepEqual(listWorkloads('local', 'coder').workloads, []);

  // With more than one, clearing empties the default's settings and keeps every name.
  createWorkload('local', 'coder', { name: 'Keep me', settings: { contextTokens: 262144 } });
  createWorkload('local', 'coder', { name: 'Also me', settings: { contextTokens: 65536 } });
  setOverride('local', 'coder', null);
  const view = listWorkloads('local', 'coder');
  assert.deepEqual(view.workloads.map((w) => w.name), ['Keep me', 'Also me']);
  assert.deepEqual(view.workloads[0].settings, {}, 'the default is emptied, not deleted');
  assert.deepEqual(view.workloads[1].settings, { contextTokens: 65536 }, 'the others are untouched');
});

test('a corrupt entry is dropped without taking the rest of the store with it', (t) => {
  scratch(t, {
    version: 2,
    models: {
      'local::good': { defaultId: 'default', workloads: { default: { id: 'default', name: 'Default', description: '', settings: { contextTokens: 4096 } } } },
      'local::nameless': { defaultId: 'default', workloads: { default: { id: 'default', settings: {} } } },
      'local::dangling': { defaultId: 'gone', workloads: { real: { id: 'real', name: 'Real', description: '', settings: { contextTokens: 2048 } } } },
      'local::empty': { defaultId: 'default', workloads: {} },
    },
  });

  assert.equal(listWorkloads('local', 'good').workloads.length, 1);
  assert.equal(resolve({ providerId: 'local', modelId: 'good' }).contextTokens, 4096);
  // A workload with no name is unusable; its model is dropped rather than failing the file.
  assert.deepEqual(listWorkloads('local', 'nameless').workloads, []);
  // A defaultId naming nothing would make resolution undefined, so it is repointed.
  assert.equal(listWorkloads('local', 'dangling').defaultId, 'real');
  assert.equal(resolve({ providerId: 'local', modelId: 'dangling' }).contextTokens, 2048);
  assert.deepEqual(listWorkloads('local', 'empty').workloads, []);
});

test('an unreadable store starts empty rather than throwing', (t) => {
  const file = scratch(t);
  writeFileSync(file, '{ not json');
  useConfigPath(file);
  assert.deepEqual(listWorkloads('local', 'coder').workloads, []);
  assert.equal(resolve({ providerId: 'local', modelId: 'coder' }).contextSource, 'default');
});

test('workload ids and settings are validated at the boundary', () => {
  for (const bad of ['', 'Upper', 'has space', '-leading', 'a'.repeat(65), 42, null, undefined]) {
    assert.throws(() => assertWorkloadId(bad), /workload id/);
  }
  for (const good of ['default', 'wide-window', 'a', 'w-1']) assert.equal(assertWorkloadId(good), good);

  assert.throws(() => assertWorkloadSettings({ nope: 1 }), /Unknown workload setting/);
  assert.throws(() => assertWorkloadSettings({ thinkingLevel: 'enormous' }), /thinking level/);
  assert.throws(() => assertWorkloadSettings({ compaction: 'shred' }), /compaction/);
  assert.throws(() => assertWorkloadSettings({ contextTokens: 'lots' }), /must be a number/);
  assert.throws(() => assertWorkloadSettings({ contextTokens: Number.NaN }), /must be a number/);
  assert.throws(() => assertWorkloadSettings([]), /must be an object/);

  // Out-of-range figures are accepted and clamped when the profile resolves, which is where the
  // window and the tool-call cap are actually known.
  assert.deepEqual(assertWorkloadSettings({ maxToolCallsPerMessage: 0 }), { maxToolCallsPerMessage: 0 });
  assert.deepEqual(assertWorkloadSettings({ contextTokens: 1e9 }), { contextTokens: 1e9 });
  assert.deepEqual(assertWorkloadSettings(undefined), {});
});

test('a name is required, and over-long text is refused', (t) => {
  scratch(t);
  for (const bad of ['', '   ', 'x'.repeat(61), 42, null]) {
    assert.throws(() => createWorkload('local', 'coder', { name: bad }));
  }
  assert.throws(() => createWorkload('local', 'coder', { name: 'Fine', description: 'd'.repeat(501) }), /description/);
  assert.deepEqual(listWorkloads('local', 'coder').workloads, [], 'a refused create writes nothing');
});

test('resolution follows the chosen workload, and a vanished one falls back', (t) => {
  scratch(t);
  createWorkload('local', 'omni', { name: 'image', settings: { contextTokens: 16384, maxToolCallsPerMessage: 2 } });
  createWorkload('local', 'omni', { name: 'coding 32k', settings: { contextTokens: 32768 } });
  createWorkload('local', 'omni', { name: 'coding 64k', settings: { contextTokens: 65536 } });

  // The modular point of ADR 0001: one model, several units, each resolvable by name.
  const at = (workloadId?: string) =>
    resolve({ providerId: 'local', modelId: 'omni', serverContextTokens: 262144, workloadId }).contextTokens;
  assert.equal(at('image'), 16384);
  assert.equal(at('coding-32k'), 32768);
  assert.equal(at('coding-64k'), 65536);

  // No workload named means the default, which is the first one created.
  assert.equal(listWorkloads('local', 'omni').defaultId, 'image');
  assert.equal(at(), 16384);

  // A workload that has been deleted must not break a conversation that named it.
  assert.equal(hasWorkload('local', 'omni', 'coding-64k'), true);
  removeWorkload('local', 'omni', 'coding-64k');
  assert.equal(hasWorkload('local', 'omni', 'coding-64k'), false);
  assert.equal(at('coding-64k'), 16384, 'a vanished workload resolves as the default, not as an error');
  assert.equal(at('never-existed'), 16384);

  // A workload only applies to the model it belongs to.
  assert.equal(resolve({ providerId: 'local', modelId: 'coder', serverContextTokens: 262144, workloadId: 'image' }).contextTokens, 262144);
});

test('a model choice carries its workload and rejects a malformed one', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-model-choice-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  modelChoice.useConfigPath(join(root, 'model.json'));

  assert.deepEqual(modelChoice.save({ providerId: 'local', modelId: 'omni', workloadId: 'coding-32k' }),
    { providerId: 'local', modelId: 'omni', workloadId: 'coding-32k' });
  assert.equal(modelChoice.read()?.workloadId, 'coding-32k');

  // Selecting a bare model clears the workload rather than keeping a stale one.
  assert.deepEqual(modelChoice.save({ providerId: 'local', modelId: 'omni' }),
    { providerId: 'local', modelId: 'omni' });
  assert.equal(modelChoice.read()?.workloadId, undefined);

  // Garbage degrades to the default instead of being stored or throwing.
  for (const bad of ['Upper', 'has space', '../escape', '', 42, {}]) {
    const saved = modelChoice.save({ providerId: 'local', modelId: 'omni', workloadId: bad as string });
    assert.equal(saved.workloadId, undefined, `rejected ${JSON.stringify(bad)}`);
  }
});

test('a workload records the boxes it expects, validated as host:port', (t) => {
  scratch(t);
  createWorkload('local', 'mimo', { name: 'Striped', settings: { nodes: ['192.0.2.220:50052', '192.0.2.221:50052'] } });
  assert.deepEqual(listWorkloads('local', 'mimo').workloads[0].settings.nodes,
    ['192.0.2.220:50052', '192.0.2.221:50052']);

  // Duplicates collapse: the list is a set of boxes, not an ordering.
  assert.deepEqual(assertWorkloadSettings({ nodes: ['a:1', 'a:1', 'b:2'] }).nodes, ['a:1', 'b:2']);
  // The same rule as a preset's RPC target, so a stored value can never become an injected flag.
  assert.throws(() => assertWorkloadSettings({ nodes: ['host:50052\nrpc = elsewhere:1'] }), /host:port/);
  assert.throws(() => assertWorkloadSettings({ nodes: ['192.0.2.220'] }), /host:port/);
  assert.throws(() => assertWorkloadSettings({ nodes: 'fixture-host-c:50052' }), /must be a list/);
  assert.throws(() => assertWorkloadSettings({ nodes: Array.from({ length: 17 }, (_, i) => `h:${i + 1}`) }), /16 nodes/);

  // Distribution is a workload property, so the same model is local in one and striped in another.
  createWorkload('local', 'mimo', { name: 'Local only' });
  const view = listWorkloads('local', 'mimo');
  assert.equal(view.workloads[1].settings.nodes, undefined);
  assert.equal(view.workloads[0].settings.nodes?.length, 2);
});
