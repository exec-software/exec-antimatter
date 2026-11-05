import assert from 'node:assert/strict';
import test from 'node:test';

import { listNodes } from '../src/main/nodes';
import { assertNodeKey, nodeKey } from '../src/api/nodes';
import type { Recipe } from '../src/main/recipes';

const peer = (name: string, host: string, port: number, start: string | null = null) =>
  ({ name, host, port, start, startTimeoutMs: 1000 });

const recipe = (id: string, name: string, models: string[], peers: ReturnType<typeof peer>[]): Recipe =>
  ({ id, name, models, peers } as Recipe);

test('two recipes naming one box collapse into a single node keeping both reasons', async () => {
  const recipes = [
    recipe('mimo', 'MiMo across both boxes', ['mimo-v26-flash'], [peer('the second box', '192.0.2.220', 50052, 'ssh ...')]),
    recipe('glm', 'GLM striped', ['glm-5.3'], [peer('the second box', '192.0.2.220', 50052), peer('fixture-host-a', '192.0.2.221', 50052)]),
  ];
  const nodes = await listNodes({
    recipes: () => recipes,
    probe: async (host) => host === '192.0.2.220',
    now: () => 1234,
  });

  // This machine is always present and always first, with no recipe needed.
  assert.equal(nodes.length, 3, 'the shared peer is one node, not two, plus this machine');
  assert.deepEqual(nodes.map((node) => node.key), ['local', '192.0.2.220:50052', '192.0.2.221:50052']);
  assert.equal(nodes[0].local, true);
  assert.equal(nodes[0].reachable, true, 'the box you are sitting at is never the uncertain one');

  const shared = nodes[1];
  assert.deepEqual(shared.recipes, ['MiMo across both boxes', 'GLM striped']);
  assert.deepEqual(shared.models, ['mimo-v26-flash', 'glm-5.3']);
  assert.equal(shared.reachable, true);
  assert.equal(shared.probedAt, 1234);
  // Any recipe that knows how to start it makes the node startable, even though the second
  // recipe declares the same peer without a start command.
  assert.equal(shared.startable, true);

  assert.equal(nodes[2].reachable, false);
  assert.equal(nodes[2].startable, false);
});

test('a probe that throws is a box that is not answering', async () => {
  const nodes = await listNodes({
    recipes: () => [recipe('r', 'R', ['m'], [peer('flaky', 'nowhere.invalid', 50052)])],
    probe: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.equal(nodes.length, 2, 'this machine plus the flaky peer');
  assert.equal(nodes[1].reachable, false);
  assert.ok(nodes[1].probedAt !== null, 'it was probed, and the answer was no');
});

test('with no recipes the roster is just this machine, with its real capacity', async () => {
  const nodes = await listNodes({
    recipes: () => [],
    probe: async () => true,
    localMemory: async () => ({ free: 11 * 1024 ** 3, total: 96 * 1024 ** 3 }),
    localName: () => 'fixture-host-a',
  });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].key, 'local');
  assert.equal(nodes[0].name, 'fixture-host-a');
  assert.equal(nodes[0].memoryTotal, 96 * 1024 ** 3);
  assert.equal(nodes[0].memoryFree, 11 * 1024 ** 3);
});

test('a remote box reports no capacity, because a TCP probe measures none', async () => {
  const nodes = await listNodes({
    recipes: () => [recipe('r', 'R', ['m'], [peer('fixture-host-c', '192.0.2.220', 50052)])],
    probe: async () => true,
    localMemory: async () => ({ free: 1, total: 2 }),
  });
  const remote = nodes.find((node) => !node.local)!;
  assert.equal(remote.reachable, true, 'the port answered');
  assert.equal(remote.memoryTotal, null, 'which says nothing at all about its capacity');
  assert.equal(remote.memoryFree, null);
});

test('an unreadable local reading is unknown, never zero free', async () => {
  const nodes = await listNodes({
    recipes: () => [],
    probe: async () => true,
    localMemory: async () => { throw new Error('no driver'); },
  });
  assert.equal(nodes[0].memoryTotal, null);
  assert.equal(nodes[0].memoryFree, null);
});

test('a node key is a host:port and nothing that could become a runtime flag', () => {
  for (const good of ['192.0.2.220:50052', 'fixture-host-c:50052', 'fixture-host-a.local:8080', '[::1]:50052']) {
    assert.equal(assertNodeKey(good), good);
  }
  for (const bad of [
    '192.0.2.220', ':50052', '192.0.2.220:0', '192.0.2.220:65536', '192.0.2.220:abc',
    'host:50052\nrpc = elsewhere:1', 'http://host:50052', 'user@host:22', '', 42, null,
  ]) {
    assert.throws(() => assertNodeKey(bad), /host:port/, `rejected ${JSON.stringify(bad)}`);
  }
  assert.equal(nodeKey('192.0.2.220', 50052), '192.0.2.220:50052');
});
