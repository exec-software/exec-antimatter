import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectManagedSource, managedSourceReadiness } from '../src/main/managedSourceInspection';
import type { InferenceSource } from '../src/main/sourceStore';
import type { ManagedConnection } from '../src/main/llamaVulkan';

const source: InferenceSource = {
  id: 'workload-current', name: 'Current workload', kind: 'llama-cpp', protocol: 'openai-chat',
  baseUrl: 'http://127.0.0.1:6769/v1', apiKey: '', supportsStreaming: true, createdAt: 1,
  models: [{ id: 'current', name: 'My renamed model', hidden: true, deployment: 'distributed' }],
};
const connection: ManagedConnection = { baseUrl: source.baseUrl, apiKey: 'private-process-key', modelId: 'current' };
const observed = { ok: true, latencyMs: 10, models: [
  { id: 'current', name: 'Engine model', contextWindow: 32768 },
  { id: 'another-workload', name: 'Another workload' },
] };

test('inactive managed inspections are actionable and perform no requests or persistence', async () => {
  for (const persist of [false, true]) {
    const result = await inspectManagedSource(source, persist, {
      current: () => source,
      connectionFor: () => null,
      probe: async () => { throw new Error('must not probe a shared inactive port'); },
      save: () => { throw new Error('must not save'); },
    });
    assert.equal(result.probe.ok, false);
    assert.match(result.probe.error!, /Send it a message/);
    assert.equal(result.saved, null);
  }
});

test('managed refresh uses ephemeral authentication while preserving only the stored credential and exact model', async () => {
  let stored: InferenceSource | undefined;
  const result = await inspectManagedSource(source, true, {
    current: () => source,
    connectionFor: (id) => id === source.id ? connection : null,
    probe: async (url, key, protocol) => {
      assert.equal(url, connection.baseUrl);
      assert.equal(key, connection.apiKey);
      assert.equal(protocol, source.protocol);
      return observed;
    },
    save: (next) => { stored = next; return next; },
  });
  assert.equal(result.probe.ok, true);
  assert.deepEqual(result.probe.models.map((model) => model.id), ['current']);
  assert.deepEqual(stored?.models.map((model) => model.id), ['current']);
  assert.equal(stored?.models[0].name, 'My renamed model');
  assert.equal(stored?.models[0].hidden, true);
  assert.equal(stored?.models[0].deployment, 'distributed');
  assert.equal(stored?.apiKey, '');
  assert.doesNotMatch(JSON.stringify(stored), /private-process-key/);
  assert.doesNotMatch(JSON.stringify(result.probe), /private-process-key/);
});

test('a connection test does not persist or replace an inactive workload catalog', async () => {
  const result = await inspectManagedSource(source, false, {
    current: () => source,
    connectionFor: () => connection, probe: async () => observed,
    save: () => { throw new Error('tests must not save'); },
  });
  assert.equal(result.probe.ok, true);
  assert.equal(result.saved, null);
  const mismatch = await inspectManagedSource(source, true, {
    current: () => source,
    connectionFor: () => connection,
    probe: async () => ({ ...observed, models: [observed.models[1]] }),
    save: () => { throw new Error('a different workload must not be adopted'); },
  });
  assert.equal(mismatch.probe.ok, false);
  assert.equal(mismatch.saved, null);
});

test('a switched process generation invalidates the observation before saving', async () => {
  let current: ManagedConnection | null = connection;
  const result = await inspectManagedSource(source, true, {
    current: () => source,
    connectionFor: () => current,
    probe: async () => { current = { ...connection, apiKey: 'replacement-process-key' }; return observed; },
    save: () => { throw new Error('stale observations must not save'); },
  });
  assert.equal(result.probe.ok, false);
  assert.equal(result.saved, null);
  assert.match(result.probe.error!, /Send it a message/);
});

test('the persistence boundary checks ownership again after the asynchronous probe returns', async () => {
  let reads = 0;
  await assert.rejects(inspectManagedSource(source, true, {
    current: () => source,
    connectionFor: () => ++reads <= 2 ? connection : null,
    probe: async () => observed,
    save: () => { throw new Error('retired observations must not reach storage'); },
  }), /Send it a message/);
});

test('managed readiness is unknown while inactive and uses the owned credential only while active', async () => {
  assert.deepEqual(await managedSourceReadiness(source.id, {
    connectionFor: () => null,
    read: async () => { throw new Error('inactive sources must not query a shared port'); },
  }), { state: 'unknown' });
  let current: ManagedConnection | null = connection;
  assert.deepEqual(await managedSourceReadiness(source.id, {
    connectionFor: () => current,
    read: async (value) => { assert.equal(value.apiKey, connection.apiKey); return { state: 'loading', detail: 'Loading model' }; },
  }), { state: 'loading', detail: 'Loading model' });
  assert.deepEqual(await managedSourceReadiness(source.id, {
    connectionFor: () => current,
    read: async () => { current = null; return { state: 'ready' }; },
  }), { state: 'unknown' });
});

test('inactive managed workloads require startup validation and never probe the shared port', async () => {
  for (const [startup, expected] of [
    [() => ({ state: 'startable' as const }), 'startable'],
    [() => { throw new Error('A verified model shard is missing.'); }, 'unreachable'],
  ] as const) {
    const result = await managedSourceReadiness(source.id, {
      connectionFor: () => null, startup,
      read: async () => { throw new Error('inactive shared port must never be probed'); },
    });
    assert.equal(result.state, expected);
  }
});
