import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeAgent } from '../src/main/nodeAgent/server';
import { NodePeerStore } from '../src/main/nodeAgent/peers';
import { pairWithNode, requestNodeEngines, requestNodeEngineAction, requestNodeVitals } from '../src/main/nodeAgent/client';
import { NODE_AGENT_PROTOCOL, parseNodePairingCode } from '../src/api/nodeAgent';
import { assertClusterAction, parseClusterEngines, parseClusterVitals, type ClusterEngineAction, type ClusterEngine } from '../src/api/cluster';
import { ClusterService } from '../src/main/cluster/service';

const protector = { available: () => true, seal: (value: string) => `sealed:${Buffer.from(value).toString('base64')}`, open: (value: string) => Buffer.from(value.slice(7), 'base64').toString() };
const engine: ClusterEngine = { id: 'bundled-beholdd', name: 'Native engine', running: true, ready: true, ownership: 'app', busy: false, startable: true };
const vitals = { observedAt: 1000, uptimeSeconds: 300, cpuUsage: .25, cpuCores: 8, memoryUsed: 1024, memoryTotal: 4096, gpus: [], disks: [], networkRx: null, networkTx: null };
const operation: ClusterEngineAction = { requestId: '11111111-2222-3333-4444-555555555555', serverId: engine.id, action: 'restart', force: false };
const scratch = (t: { after(fn: () => void): void }) => { const path = mkdtempSync(join(tmpdir(), 'antimatter-cluster-test-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };
const freePort = () => new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; server.close(() => resolve(port)); }); });

async function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const actions: ClusterEngineAction[] = []; let busy = false; let external = false;
  const agent = new NodeAgent({ userData: scratch(t), appVersion: '1', protector, readings: { accelerators: async () => [], checkpoints: async () => [] },
    cluster: { vitals: async () => vitals, engines: async () => [{ ...engine, busy, ownership: external ? 'external' : 'app' }],
      action: async (input) => { actions.push(input); await new Promise(resolve => setTimeout(resolve, 5)); return [engine]; } } });
  t.after(() => agent.stop());
  await agent.configure({ enabled: true, address: '127.0.0.1', port: await freePort() });
  return { agent, actions, busy: (value: boolean) => { busy = value; }, external: (value: boolean) => { external = value; } };
}

test('default and legacy pairings never gain vitals or engine control after upgrade', async (t) => {
  const { agent, actions } = await fixture(t);
  const offer = await agent.createPairingOffer(); assert.deepEqual(offer.scopes, ['inventory']);
  const code = parseNodePairingCode(agent.pairingCode(offer.id));
  const paired = await pairWithNode(code, 'controller', '1'); assert.deepEqual(paired.scopes, ['inventory']);
  for (const route of ['/v1/vitals', '/v1/engines']) assert.equal((await agent.respond('GET', route, `Bearer ${paired.credential}`, undefined)).status, 403);
  assert.equal((await agent.respond('POST', '/v1/engines/action', `Bearer ${paired.credential}`, operation)).status, 403);
  assert.equal((await agent.respond('POST', '/v1/engines/action', undefined, operation)).status, 401);
  assert.equal(actions.length, 0);
  const raw = agent.pairingCode(offer.id)!; const params = new URLSearchParams(raw.split('?')[1]); params.delete('scopes');
  assert.deepEqual(parseNodePairingCode(`ANTIMATTER-NODE-V1?${params}`).scopes, ['inventory']);
});

test('explicit scopes work over pinned TLS, strip private engine fields, and revoked tokens fail', async (t) => {
  const { agent } = await fixture(t);
  const offer = await agent.createPairingOffer(['inventory', 'vitals', 'manage-engines']);
  const code = parseNodePairingCode(agent.pairingCode(offer.id)); const paired = await pairWithNode(code, 'controller', '1');
  assert.deepEqual(paired.scopes, ['inventory', 'vitals', 'manage-engines']);
  assert.deepEqual(await requestNodeVitals(code, paired.credential), vitals);
  assert.deepEqual(await requestNodeEngines(code, paired.credential), [engine]);
  assert.deepEqual(await requestNodeEngineAction(code, paired.credential, operation), [engine]);
  agent.revokeController(paired.controllerId);
  await assert.rejects(requestNodeEngineAction(code, paired.credential, { ...operation, requestId: 'another-request-id' }), /does not know/);
  assert.deepEqual(parseClusterEngines([{ ...engine, logs: ['secret'], detail: '/private/file', command: 'secret' }]), [engine]);
});

test('remote actions cannot bypass busy/external ownership and repeated requests execute once', async (t) => {
  const { agent, actions, busy, external } = await fixture(t);
  const offer = await agent.createPairingOffer(['manage-engines']); const code = parseNodePairingCode(agent.pairingCode(offer.id));
  const paired = await pairWithNode(code, 'controller', '1'); const authorization = `Bearer ${paired.credential}`;
  const invoke = (input: ClusterEngineAction) => agent.respond('POST', '/v1/engines/action', authorization, input);
  busy(true); assert.equal((await invoke(operation)).status, 409); assert.equal(actions.length, 0);
  busy(false);
  const action = { ...operation, requestId: 'second-request-id' };
  const [a, b] = await Promise.all([invoke(action), invoke(action)]); assert.equal(a.status, 200); assert.deepEqual(a, b); assert.equal(actions.length, 1);
  assert.equal((await invoke({ ...action, action: 'stop' })).status, 409);
  external(true); assert.equal((await invoke({ ...operation, requestId: 'third-request-id', force: true })).status, 403);
  external(false); busy(true); assert.equal((await invoke({ ...operation, requestId: 'fourth-request-id', force: true })).status, 200);
  assert.equal(actions.length, 2);
  assert.throws(() => assertClusterAction({ ...operation, command: 'arbitrary shell' }), /Unknown/);
});

test('peer persistence records granted scopes, while older entries migrate to inventory only', (t) => {
  const path = join(scratch(t), 'peers.json'); const store = new NodePeerStore({ path, protector });
  const input = { endpoint: 'https://127.0.0.1:43129', certificatePin: 'sha256/pin', nodeId: 'fixture', name: 'Node', credential: 'private-bearer' };
  store.remember({ ...input, scopes: ['inventory', 'manage-engines'] });
  assert.deepEqual(new NodePeerStore({ path, protector }).list()[0].scopes, ['inventory', 'manage-engines']);
  const legacy = JSON.parse(readFileSync(path, 'utf8')); delete legacy.peers[0].scopes; writeFileSync(path, JSON.stringify(legacy));
  assert.deepEqual(new NodePeerStore({ path, protector }).list()[0].scopes, ['inventory']);
  assert.doesNotMatch(JSON.stringify(store.list()), /private-bearer|credential/);
});

test('cluster polls only granted capabilities and never dispatches management with inventory credentials', async (t) => {
  const peers = new NodePeerStore({ path: join(scratch(t), 'peers.json'), protector });
  peers.remember({ endpoint: 'https://127.0.0.1:43129', certificatePin: 'sha256/pin', nodeId: 'fixture', name: 'Legacy', credential: 'private-bearer' });
  const called: string[] = [];
  const report = { protocol: NODE_AGENT_PROTOCOL, agentVersion: '1', nodeId: 'fixture', name: 'fixture', accelerators: [], memoryFree: null, memoryTotal: null, checkpoints: [], observedAt: 1000 };
  const service = new ClusterService({ peers, local: { report: async () => report, vitals: async () => vitals, engines: async () => [engine], action: async () => [engine] },
    remote: { report: async () => { called.push('report'); return report; }, vitals: async () => { called.push('vitals'); return vitals; }, engines: async () => { called.push('engines'); return [engine]; }, action: async () => { called.push('action'); return [engine]; } } });
  const snapshot = await service.snapshot(); assert.equal(snapshot.nodes.length, 2); assert.deepEqual(called, ['report']);
  assert.equal(snapshot.nodes[1].vitals, null); assert.equal(snapshot.nodes[1].engines, null);
  await assert.rejects(service.action('127.0.0.1:43129', operation), /explicitly allow/); assert.deepEqual(called, ['report']);
  await assert.rejects(service.action('https://attacker.test/path', operation), /host:port/);
});

test('untrusted vitals are bounded and unknown values remain unknown', () => {
  const result = parseClusterVitals({ ...vitals, cpuUsage: 2, memoryTotal: Infinity, gpus: [{ name: 'G'.repeat(200), usage: -1, celsius: NaN }], disks: [{ total: 4, used: 5 }] });
  assert.equal(result.cpuUsage, null); assert.equal(result.memoryTotal, null); assert.equal(result.gpus[0].usage, null); assert.equal(result.gpus[0].name.length, 120); assert.equal(result.disks.length, 0);
  assert.throws(() => parseClusterVitals({ ...vitals, observedAt: NaN }), /timestamp/);
});

test('controller deduplicates local actions and hides remote error payloads', async (t) => {
  const peers = new NodePeerStore({ path: join(scratch(t), 'peers.json'), protector });
  peers.remember({ endpoint: 'https://127.0.0.1:43129', certificatePin: 'sha256/pin', nodeId: 'fixture', name: 'Managed', credential: 'private-bearer', scopes: ['manage-engines'] });
  const report = { protocol: NODE_AGENT_PROTOCOL, agentVersion: '1', nodeId: 'fixture', name: 'fixture', accelerators: [], memoryFree: null, memoryTotal: null, checkpoints: [], observedAt: 1000 };
  let calls = 0;
  const service = new ClusterService({ peers, local: { report: async () => report, vitals: async () => vitals, engines: async () => [engine], action: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return [engine]; } },
    remote: { report: async () => report, vitals: async () => vitals, engines: async () => [engine], action: async () => { throw new Error('private-bearer'); } } });
  await Promise.all([service.action('local', operation), service.action('local', operation)]); assert.equal(calls, 1);
  await assert.rejects(service.action('local', { ...operation, action: 'stop' }), /identifier/);
  await assert.rejects(service.action('127.0.0.1:43129', operation), (error: Error) => { assert.doesNotMatch(error.message, /private-bearer/); return true; });
  const audit = (await service.snapshot()).actions; assert.equal(audit.length, 2); assert.equal(audit[0].outcome, 'failed');
});
