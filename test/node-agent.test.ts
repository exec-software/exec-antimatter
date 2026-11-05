import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { NodeTrustStore } from '../src/main/nodeAgent/trust';
import { NodePeerStore } from '../src/main/nodeAgent/peers';
import { NodeAgent } from '../src/main/nodeAgent/server';
import { parseReport, pairWithNode, requestReport } from '../src/main/nodeAgent/client';
import { NODE_AGENT_PROTOCOL, parseNodePairingCode } from '../src/api/nodeAgent';
import { listNodes } from '../src/main/nodes';
import type { Recipe } from '../src/main/recipes';

/** Not the OS keyring, but the same contract: sealed in, opened out, opaque on disk. */
const protector = {
  available: () => true,
  seal: (value: string) => `sealed:${Buffer.from(value, 'utf8').toString('base64')}`,
  open: (value: string) => {
    if (!value.startsWith('sealed:')) throw new Error('not sealed by this protector');
    return Buffer.from(value.slice('sealed:'.length), 'base64').toString('utf8');
  },
};

const scratch = (label: string) => mkdtempSync(join(tmpdir(), `antimatter-${label}-`));

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    probe.close(() => (port ? resolve(port) : reject(new Error('no port'))));
  });
});

const readings = {
  accelerators: async () => [
    { name: 'card0', memoryFree: 90 * 1024 ** 3, memoryTotal: 96 * 1024 ** 3 },
    { name: 'card1', memoryFree: null, memoryTotal: null },
  ],
  checkpoints: async () => [{ id: 'qwen3-omni-30b-q8', name: 'Qwen3 Omni 30B', bytes: 32 * 1024 ** 3 }],
};

// ---------------------------------------------------------------------------
// The agent's own list of machines it answers
// ---------------------------------------------------------------------------

test('a pairing offer is one-time, and its bearer is never written down', () => {
  const path = join(scratch('node-trust'), 'trust.json');
  const store = new NodeTrustStore({ path, nodeName: 'fixture-host-a', protector });

  const offer = store.createOffer(['inventory']);
  const result = store.exchange({
    offerId: offer.id,
    secret: offer.secret,
    controllerName: 'the laptop',
    clientVersion: '9.0.0',
    requestedScopes: ['inventory'],
  });
  assert.deepEqual(result.controller.scopes, ['inventory']);
  assert.equal(store.authenticate(result.credential)?.id, result.controller.id);

  // The same code cannot mint a second controller, even a second later.
  assert.throws(() => store.exchange({
    offerId: offer.id,
    secret: offer.secret,
    controllerName: 'someone else',
    clientVersion: '9.0.0',
    requestedScopes: ['inventory'],
  }), /invalid or expired/);

  const raw = readFileSync(path, 'utf8');
  assert.doesNotMatch(raw, new RegExp(result.credential.split('.')[1].slice(0, 16)), 'the bearer is stored only as a keyed hash');
  assert.match(raw, /"secretCiphertext": "sealed:/, 'and the key that hashes it is sealed');
});

test('a wrong secret, an expired offer and a revoked controller are all refused', () => {
  let clock = 1_000;
  const store = new NodeTrustStore({
    path: join(scratch('node-trust-refuse'), 'trust.json'),
    nodeName: 'fixture-host-a',
    protector,
    now: () => clock,
    offerTtlMs: 60_000,
  });

  const offer = store.createOffer(['inventory']);
  assert.throws(() => store.exchange({
    offerId: offer.id, secret: 'not-the-secret', controllerName: 'x', clientVersion: '1', requestedScopes: ['inventory'],
  }), /invalid or expired/);

  // Consuming nothing: the failed attempt above must not have burned the offer.
  const paired = store.exchange({
    offerId: offer.id, secret: offer.secret, controllerName: 'the laptop', clientVersion: '9.0.0', requestedScopes: ['inventory'],
  });
  assert.ok(store.authenticate(paired.credential));
  assert.equal(store.revoke(paired.controller.id), true);
  assert.equal(store.authenticate(paired.credential), null, 'revoking is immediate, not advisory');
  assert.equal(store.revoke(paired.controller.id), false);

  const second = store.createOffer(['inventory']);
  clock += 60_001;
  assert.throws(() => store.exchange({
    offerId: second.id, secret: second.secret, controllerName: 'late', clientVersion: '1', requestedScopes: ['inventory'],
  }), /invalid or expired/);
});

test('a scope this version cannot enforce is refused rather than recorded', () => {
  const store = new NodeTrustStore({ path: join(scratch('node-trust-scope'), 'trust.json'), nodeName: 'box', protector });
  const offer = store.createOffer(['inventory']);
  assert.throws(() => store.exchange({
    offerId: offer.id, secret: offer.secret, controllerName: 'eager', clientVersion: '1',
    requestedScopes: ['inventory', 'fetch-weights'],
  }), /cannot grant/);
  // And the code is spent either way: it is one-time whatever happens after the secret checks
  // out, so a controller asking for a scope this version has never heard of has to be told to
  // ask for a new one rather than allowed to keep guessing at the same one.
  assert.throws(() => store.exchange({
    offerId: offer.id, secret: offer.secret, controllerName: 'ordinary', clientVersion: '1', requestedScopes: ['inventory'],
  }), /invalid or expired/);
});

test('an only-offer is replaced, not accumulated, so a code on a desk stops working', () => {
  const store = new NodeTrustStore({ path: join(scratch('node-trust-single'), 'trust.json'), nodeName: 'box', protector });
  const first = store.createOffer(['inventory']);
  store.createOffer(['inventory']);
  assert.throws(() => store.exchange({
    offerId: first.id, secret: first.secret, controllerName: 'stale', clientVersion: '1', requestedScopes: ['inventory'],
  }), /invalid or expired/);
});

// ---------------------------------------------------------------------------
// The protocol, without a socket
// ---------------------------------------------------------------------------

const agentFor = async (label: string, port: number) => {
  const agent = new NodeAgent({
    userData: scratch(label),
    appVersion: '9.0.0',
    protector,
    readings,
    nodeName: 'fixture-host-a',
  });
  await agent.configure({ enabled: true, address: '127.0.0.1', port });
  return agent;
};

test('a caller with no credential learns nothing a TCP connect had not already told it', async (t) => {
  const agent = await agentFor('node-agent-unauth', await freePort());
  t.after(() => agent.stop());

  assert.equal((await agent.respond('GET', '/v1/report', undefined, undefined)).status, 401);
  assert.equal((await agent.respond('GET', '/v1/report', 'Bearer nonsense', undefined)).status, 401);
  assert.equal((await agent.respond('GET', '/v1/models', undefined, undefined)).status, 404);
  const refused = await agent.respond('GET', '/v1/report', undefined, undefined);
  assert.equal(Object.keys(refused.body).sort().join(','), 'error,message', 'no inventory leaks through the refusal');
});

test('a paired controller is told what the driver said, with an unreadable device left unknown', async (t) => {
  const agent = await agentFor('node-agent-report', await freePort());
  t.after(() => agent.stop());

  const offer = await agent.createPairingOffer();
  const code = parseNodePairingCode(agent.pairingCode(offer.id));
  const paired = await agent.respond('POST', '/v1/pair', undefined, {
    offerId: code.offerId, secret: code.secret, controllerName: 'the laptop', clientVersion: '9.0.0', scopes: ['inventory'],
  });
  assert.equal(paired.status, 200);

  const credential = String((paired.body as { credential: string }).credential);
  const answer = await agent.respond('GET', '/v1/report', `Bearer ${credential}`, undefined);
  assert.equal(answer.status, 200);
  const report = parseReport(answer.body);
  assert.equal(report.protocol, NODE_AGENT_PROTOCOL);
  assert.equal(report.name, 'fixture-host-a');
  assert.equal(report.accelerators.length, 2);
  // One card publishes nothing. It must not contribute a zero to either total.
  assert.equal(report.memoryTotal, 96 * 1024 ** 3);
  assert.equal(report.memoryFree, 90 * 1024 ** 3);
  assert.deepEqual(report.checkpoints.map((held) => held.id), ['qwen3-omni-30b-q8']);
});

test('stopping the agent kills the pairing material it had in memory', async (t) => {
  const agent = await agentFor('node-agent-stop', await freePort());
  t.after(() => agent.stop());
  const offer = await agent.createPairingOffer();
  assert.ok(agent.pairingCode(offer.id));
  await agent.stop();
  assert.equal(agent.pairingCode(offer.id), null);
  const code = `${offer.id}`;
  assert.equal(agent.cancelPairingOffer(code), false);
});

// ---------------------------------------------------------------------------
// Over a real socket, with the pin doing its job
// ---------------------------------------------------------------------------

test('pairing and reporting work end to end, and a changed certificate is refused', async (t) => {
  const port = await freePort();
  const agent = await agentFor('node-agent-tls', port);
  t.after(() => agent.stop());
  assert.equal(agent.status().running, true, agent.status().error ?? '');

  const offer = await agent.createPairingOffer();
  const raw = agent.pairingCode(offer.id);
  assert.ok(raw?.startsWith('ANTIMATTER-NODE-V1?'));
  const code = parseNodePairingCode(raw);
  assert.equal(code.endpoint, `https://127.0.0.1:${port}`);

  const pairing = await pairWithNode(code, 'the laptop', '9.0.0');
  assert.equal(pairing.nodeId, code.nodeId);
  const report = await requestReport({ endpoint: code.endpoint, certificatePin: code.certificatePin }, pairing.credential);
  assert.equal(report.memoryTotal, 96 * 1024 ** 3);

  // The pin is the whole defence on a LAN: a box presenting anything else is not that box.
  await assert.rejects(
    requestReport(
      { endpoint: code.endpoint, certificatePin: 'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
      pairing.credential
    ),
    /different certificate/
  );

  // And a revoked controller is told so rather than quietly reading stale numbers.
  agent.revokeController(agent.status().controllers[0].id);
  await assert.rejects(
    requestReport({ endpoint: code.endpoint, certificatePin: code.certificatePin }, pairing.credential),
    /no longer trusts/
  );
});

// ---------------------------------------------------------------------------
// A report is input from a machine this one does not control
// ---------------------------------------------------------------------------

test('a hostile or broken report is clamped, not believed', () => {
  assert.throws(() => parseReport({ protocol: 'something-else', nodeId: 'x' }), /does not understand/);
  assert.throws(() => parseReport({ protocol: NODE_AGENT_PROTOCOL }), /no identity/);
  assert.throws(() => parseReport('a string'), /no report/);

  const clamped = parseReport({
    protocol: NODE_AGENT_PROTOCOL,
    nodeId: 'n'.repeat(64),
    name: 'x'.repeat(400),
    agentVersion: 12,
    memoryFree: -5,
    memoryTotal: Number.POSITIVE_INFINITY,
    accelerators: Array.from({ length: 200 }, () => ({ name: 7, memoryFree: 'lots', memoryTotal: 1 })),
    checkpoints: [{ id: 'ok', name: 'OK', bytes: -1 }, { name: 'no id' }, 'junk'],
    observedAt: 'now',
  });
  assert.equal(clamped.name, 'an unnamed box', 'an over-long name is dropped rather than truncated into a lie');
  assert.equal(clamped.agentVersion, 'unknown');
  assert.equal(clamped.memoryFree, null, 'a negative byte count is not a byte count');
  assert.equal(clamped.memoryTotal, null, 'and neither is infinity');
  assert.equal(clamped.accelerators.length, 32, 'a long list is cut, not iterated forever');
  assert.equal(clamped.accelerators[0].name, 'an accelerator');
  assert.equal(clamped.accelerators[0].memoryFree, null);
  assert.deepEqual(clamped.checkpoints, [{ id: 'ok', name: 'OK', bytes: 0 }]);
  assert.equal(clamped.observedAt, 0);
});

test('a pairing code is parsed strictly, because it is pasted by hand', () => {
  const good = 'ANTIMATTER-NODE-V1?endpoint=https%3A%2F%2F192.0.2.220%3A43129&node=' +
    'A'.repeat(22) + '&offer=' + 'B'.repeat(22) + '&secret=' + 'C'.repeat(43) +
    '&pin=sha256%2F' + 'D'.repeat(43) + '%3D&expires=1760000000000';
  const parsedCode = parseNodePairingCode(good);
  assert.equal(parsedCode.endpoint, 'https://192.0.2.220:43129');
  assert.equal(parsedCode.secret, 'C'.repeat(43));

  for (const bad of [
    'nope',
    good.replace('https%3A', 'http%3A'),
    good.replace('&pin=sha256%2F', '&pin=md5%2F'),
    good.replace('secret=' + 'C'.repeat(43), 'secret=short'),
    good.replace('%3A43129', '%3A0'),
    good.replace('&expires=1760000000000', '&expires=soon'),
    42,
    null,
  ]) {
    assert.throws(() => parseNodePairingCode(bad), /pairing code/, `rejected ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// The controller's side
// ---------------------------------------------------------------------------

test('a paired box survives a restart, keeps its bearer out of the view, and re-pairs in place', () => {
  const path = join(scratch('node-peers'), 'peers.json');
  const store = new NodePeerStore({ path, protector });
  const view = store.remember({
    endpoint: 'https://192.0.2.220:43129',
    certificatePin: 'sha256/aaa',
    nodeId: 'node-1',
    name: 'the second box',
    credential: 'controller-1.secret-one',
  });
  assert.equal(view.key, '192.0.2.220:43129');
  assert.equal(JSON.stringify(store.list()).includes('secret-one'), false, 'a view never carries a bearer');
  assert.equal(store.target('192.0.2.220:43129')?.credential, 'controller-1.secret-one');
  assert.doesNotMatch(readFileSync(path, 'utf8'), /secret-one/);

  // Re-pairing the same box replaces its credential. Two entries for one box would mean polling
  // it twice with one dead bearer.
  store.remember({
    endpoint: 'https://192.0.2.220:43129',
    certificatePin: 'sha256/bbb',
    nodeId: 'node-1',
    name: 'the second box',
    credential: 'controller-2.secret-two',
  });
  assert.equal(store.list().length, 1);
  assert.equal(store.target('192.0.2.220:43129')?.credential, 'controller-2.secret-two');

  const reopened = new NodePeerStore({ path, protector });
  assert.deepEqual(reopened.keys(), ['192.0.2.220:43129']);
  reopened.fail('192.0.2.220:43129', new Error('That box did not answer in time.'));
  assert.match(reopened.list()[0].lastError ?? '', /did not answer/);
  assert.deepEqual(reopened.forget('192.0.2.220:43129'), []);
  assert.deepEqual(new NodePeerStore({ path, protector }).keys(), []);
});

test('an endpoint that is not a host:port is refused before it can be stored', () => {
  const store = new NodePeerStore({ path: join(scratch('node-peers-bad'), 'peers.json'), protector });
  assert.throws(() => store.remember({
    endpoint: 'https://192.0.2.220:43129/../elsewhere',
    certificatePin: 'sha256/aaa',
    nodeId: 'n',
    name: 'x',
    credential: 'a.b',
  }), /host:port/);
});

// ---------------------------------------------------------------------------
// The roster, once a box can talk
// ---------------------------------------------------------------------------

const peer = (name: string, host: string, port: number, start: string | null = null) =>
  ({ name, host, port, start, startTimeoutMs: 1000 });
const recipe = (id: string, name: string, models: string[], peers: ReturnType<typeof peer>[]): Recipe =>
  ({ id, name, models, peers } as Recipe);

const reportFor = (name: string) => ({
  protocol: NODE_AGENT_PROTOCOL as typeof NODE_AGENT_PROTOCOL,
  agentVersion: '9.0.0',
  nodeId: 'node-1',
  name,
  accelerators: [{ name: 'card0', memoryFree: 40 * 1024 ** 3, memoryTotal: 96 * 1024 ** 3 }],
  memoryFree: 40 * 1024 ** 3,
  memoryTotal: 96 * 1024 ** 3,
  checkpoints: [{ id: 'mimo', name: 'MiMo v26', bytes: 155 * 1024 ** 3 }],
  observedAt: 1,
});

test("a paired agent's report attaches to the box's RPC row, by host rather than by port", async () => {
  const nodes = await listNodes({
    recipes: () => [recipe('mimo', 'MiMo across both boxes', ['mimo-v26-flash'], [peer('the second box', '192.0.2.220', 50052)])],
    probe: async () => true,
    paired: () => [{ key: '192.0.2.220:43129', name: 'the second box', endpoint: 'https://192.0.2.220:43129' }],
    report: async () => reportFor('fixture-host-b'),
  });

  // One machine, one row: the agent listens on its own port while --rpc listens on another, and
  // memory is a property of the box rather than of either port.
  assert.equal(nodes.length, 2, 'this machine and the one declared box');
  const remote = nodes[1];
  assert.equal(remote.key, '192.0.2.220:50052', 'the row keeps the address a workload would record');
  assert.equal(remote.paired, true);
  assert.equal(remote.memoryTotal, 96 * 1024 ** 3);
  assert.equal(remote.capacityFrom, 'agent');
  assert.equal(remote.name, 'fixture-host-b', 'the machine talking about itself beats a recipe label');
  assert.deepEqual(remote.checkpoints.map((held) => held.id), ['mimo']);
  assert.equal(remote.agentError, null);
});

test('a paired box no recipe mentions is still in the roster', async () => {
  const nodes = await listNodes({
    recipes: () => [],
    probe: async () => true,
    paired: () => [{ key: '192.0.2.7:43129', name: 'spare', endpoint: 'https://192.0.2.7:43129' }],
    report: async () => reportFor('the spare box'),
  });
  assert.deepEqual(nodes.map((node) => node.key), ['local', '192.0.2.7:43129']);
  assert.equal(nodes[1].startable, false, 'nothing knows how to start a box no recipe describes');
  assert.equal(nodes[1].capacityFrom, 'agent');
});

test('a report that never arrives says so, and never becomes a capacity figure', async () => {
  const nodes = await listNodes({
    recipes: () => [],
    probe: async () => true,
    paired: () => [{ key: '192.0.2.7:43129', name: 'spare', endpoint: 'https://192.0.2.7:43129' }],
    report: async () => { throw new Error('That box did not answer in time.'); },
  });
  const remote = nodes[1];
  assert.equal(remote.paired, true);
  assert.equal(remote.memoryFree, null);
  assert.equal(remote.memoryTotal, null);
  assert.equal(remote.capacityFrom, null);
  assert.match(remote.agentError ?? '', /did not answer/);
});

test('with nothing paired the roster is exactly what stage 4 produced', async () => {
  const nodes = await listNodes({
    recipes: () => [recipe('r', 'R', ['m'], [peer('fixture-host-c', '192.0.2.220', 50052)])],
    probe: async () => true,
    localMemory: async () => ({ free: 1, total: 2 }),
  });
  assert.equal(nodes[0].capacityFrom, 'driver');
  assert.equal(nodes[1].paired, false);
  assert.equal(nodes[1].capacityFrom, null);
  assert.equal(nodes[1].memoryTotal, null);
});
