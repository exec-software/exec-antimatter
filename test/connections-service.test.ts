import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectionsStore } from '../src/main/connections/store';
import { ConnectionProviders } from '../src/main/connections/providers';
import { ConnectionsService } from '../src/main/connections/service';
import { withConnections } from '../src/main/connections/tools';
import { allowedUnattended, decide, tierOf } from '../src/main/toolPolicy';
import type { ConnectionDraft } from '../src/api/connections';
import type { ToolRuntime } from '../src/main/toolLoop';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(process.env.ANTIMATTER_TEST_ARTIFACTS || tmpdir(), 'connections-service-'));
  const project = join(directory, 'project'); const other = join(directory, 'other'); mkdirSync(project); mkdirSync(other);
  const file = join(directory, 'connections.json'); const secrets = new Map<string, string>(); let available = true;
  const protector = { available: () => available, seal: (value: string) => { const id = randomUUID(); secrets.set(id, value); return id; }, open: (value: string) => { const secret = secrets.get(value); if (!secret) { throw new Error('No key'); } return secret; } };
  const store = new ConnectionsStore(file, protector); const calls = { reads: 0, sends: 0 }; let sendGate: (() => Promise<string>) | undefined;
  class FixtureProviders extends ConnectionProviders {
    override async folders() { calls.reads++; return { items: [{ id: 'inbox', name: 'Inbox' }] }; }
    override async messages() { calls.reads++; return { items: [] }; }
    override async send() { calls.sends++; return sendGate ? sendGate() : 'provider-message'; }
  }
  const service = new ConnectionsService(store, new FixtureProviders(), async () => { throw new Error('No browser in fixture'); });
  t.after(() => { service.dispose(); rmSync(directory, { recursive: true, force: true }); });
  const add = () => { service.enable('comms', true); const id = store.add({ provider: 'slack', label: 'Fixture', address: '', guild: '' }, { accessToken: 'fixture-secret-value' }); return id; };
  const draft = (account: string): ConnectionDraft => ({ account, destination: 'C123', subject: '', text: 'Fixture message', requestId: randomUUID() });
  return { store, service, file, directory, project, other, calls, add, draft, lock: () => { available = false; }, setSend: (operation: () => Promise<string>) => { sendGate = operation; } };
}

test('connections are opt-in, credentials stay private and project grants are live', async (t) => {
  const f = fixture(t); assert.deepEqual(f.service.get().plugins, { comms: false, email: false });
  const id = f.add(); assert.equal(JSON.stringify(f.service.get()).includes('fixture-secret-value'), false);
  assert.equal(readFileSync(f.file, 'utf8').includes('fixture-secret-value'), false); assert.equal(statSync(f.file).mode & 0o777, 0o600);
  await assert.rejects(f.service.folders(id, undefined, f.project), /disabled/);
  f.service.access(id, f.project, true, false); await f.service.folders(id, undefined, f.project);
  await assert.rejects(f.service.folders(id, undefined, f.other), /disabled/);
  await assert.rejects(f.service.send(f.draft(id), f.project), /disabled/);
  f.service.access(id, f.project, false, false); await assert.rejects(f.service.folders(id, undefined, f.project), /disabled/);
  assert.deepEqual(f.service.agentAccounts(f.project), []);
  f.service.enable('comms', false); await assert.rejects(f.service.folders(id), /unavailable/);
});

test('send receipts prevent concurrent duplicate sends and survive a service restart', async (t) => {
  const f = fixture(t); const id = f.add(); let release!: (value: string) => void;
  f.setSend(() => new Promise((resolve) => { release = resolve; }));
  const draft = f.draft(id); const first = f.service.send(draft);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(f.calls.sends, 1);
  assert.equal((await f.service.send(draft)).state, 'uncertain'); assert.equal(f.calls.sends, 1);
  assert.equal(f.service.receipt(draft.requestId)?.state, 'uncertain');
  assert.equal(f.service.receipt(randomUUID()), null);
  release('sent-id'); assert.equal((await first).state, 'sent');
  const restarted = new ConnectionsService(f.store, new ConnectionProviders(), async () => {});
  assert.deepEqual(await restarted.send(draft), { requestId: draft.requestId, state: 'sent', messageId: 'sent-id' });
  await assert.rejects(restarted.send({ ...draft, text: 'Different message' }), /different/); restarted.dispose();
});

test('uncertain sends remain blocked, including a durable pending receipt after a crash', async (t) => {
  const f = fixture(t); const id = f.add(); f.setSend(async () => { throw new Error('fixture-secret-value'); });
  const draft = f.draft(id); const receipt = await f.service.send(draft);
  assert.equal(receipt.state, 'uncertain'); assert.equal(JSON.stringify(receipt).includes('secret'), false);
  await f.service.send(draft); assert.equal(f.calls.sends, 1);
  f.store.change((record) => { record.sends[draft.requestId].state = 'pending'; });
  assert.equal((await f.service.send(draft)).state, 'uncertain'); assert.equal(f.calls.sends, 1);
});

test('failed durable intent prevents external sends and corrupt settings fail closed', async (t) => {
  const f = fixture(t); const id = f.add(); const failing = new ConnectionsStore(f.file, f.store.protector, () => { throw new Error('Disk unavailable'); });
  class NeverSend extends ConnectionProviders { override async send(): Promise<string> { throw new Error('Should not reach provider'); } }
  const service = new ConnectionsService(failing, new NeverSend(), async () => {});
  await assert.rejects(service.send(f.draft(id)), /Disk unavailable/); service.dispose();
  writeFileSync(f.file, 'broken'); assert.throws(() => f.service.enable('email', true), /could not be read/); assert.equal(readFileSync(f.file, 'utf8'), 'broken');
});

test('locked keyring and disconnected accounts cannot read or send', async (t) => {
  const f = fixture(t); const id = f.add(); f.lock(); await assert.rejects(f.service.folders(id), /keyring/);
  await assert.rejects(f.service.send(f.draft(id)), /keyring/); assert.equal(f.calls.sends, 0);
  f.service.disconnect(id); await assert.rejects(f.service.folders(id), /unavailable/); assert.equal(f.service.get().accounts.length, 0);
});

test('agent tools expose granted accounts only and cannot bypass host project checks', async (t) => {
  const f = fixture(t); const id = f.add();
  const runtime: ToolRuntime = { enabledTools: () => [], callTool: async () => ({ ok: false, text: 'unhandled' }) };
  const wrapped = withConnections(runtime, f.service, f.project); assert.equal(wrapped.enabledTools().length, 0);
  f.service.access(id, f.project, true, false); assert.equal(wrapped.enabledTools().some((tool) => tool.tool.name === 'connection_send'), false);
  assert.equal((await wrapped.callTool('antimatter.connections', 'connection_send', f.draft(id) as unknown as Record<string, unknown>)).ok, false);
  f.service.access(id, f.project, true, true); assert.equal(wrapped.enabledTools().some((tool) => tool.tool.name === 'connection_send'), true);
  assert.equal(tierOf('connection_send', 'antimatter.connections'), 'danger');
  assert.equal(allowedUnattended('connection_send', 'antimatter.connections'), false);
  assert.equal(allowedUnattended('connection_messages', 'antimatter.connections'), false);
  assert.equal(tierOf('connection_messages', 'untrusted-provider'), 'danger');
  for (const mode of ['ask', 'full'] as const) {
    assert.equal(decide('connection_send', { mode, serverId: 'antimatter.connections', workspaceConfirmed: true }), 'ask');
  }
  assert.equal(decide('connection_send', { mode: 'read', serverId: 'antimatter.connections', workspaceConfirmed: true }), 'deny');
  assert.equal(decide('connection_messages', { mode: 'full', serverId: 'antimatter.connections', workspaceConfirmed: false }), 'deny');
});

test('input validation rejects header injection and changing signed-in app registration', async (t) => {
  const f = fixture(t); const id = f.add();
  await assert.rejects(f.service.send({ ...f.draft(id), subject: 'Subject\r\nBcc: victim@example.test' }), /Invalid/);
  assert.throws(() => f.service.registration({ provider: 'slack', clientId: 'client', redirectUri: 'https://example.test/callback', tenant: 'common' }), /disconnect/);
  await assert.rejects(f.service.connect({ provider: 'gmail', label: 'Mail', credential: 'fixture' }), /browser/);
});
