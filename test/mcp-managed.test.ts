import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { ManagedMcpServerConfig } from '../src/main/mcp';

const directory = mkdtempSync(join(tmpdir(), 'antimatter-managed-mcp-'));
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const modules = require('node:module') as { _load: ModuleLoader };
const original = modules._load;
modules._load = function(request, parent, isMain) {
  return request === 'electron' ? { app: { getPath: () => directory, getAppPath: () => process.cwd(), isPackaged: false } }
    : original.call(this, request, parent, isMain);
};
const mcp = require('../src/main/mcp') as typeof import('../src/main/mcp');
const store = require('../src/main/mcpStore') as typeof import('../src/main/mcpStore');
modules._load = original;
test.after(async () => { await mcp.shutdown(); rmSync(directory, { recursive: true, force: true }); });

const config = (patch: Partial<ManagedMcpServerConfig> = {}): ManagedMcpServerConfig => ({
  id: 'plugin.test.echo', name: 'Reviewed echo', command: process.execPath,
  args: [resolve('test/fixtures/managed-mcp-server.mjs')], enabled: true, createdAt: 1,
  fingerprint: 'reviewed-v1', env: { MANAGED_MARKER: 'original' }, ...patch,
});

test('managed configs are ephemeral, namespaced, and cannot shadow a built-in server', async () => {
  store.save(config({ enabled: false })); // A legacy store row cannot enable or impersonate a reviewed plugin.
  let current: ManagedMcpServerConfig[] = [config(), config({ id: 'antimatter', builtin: true })];
  mcp.configureManagedServers(() => current);
  assert.deepEqual(mcp.statuses().map((entry) => entry.id), ['plugin.test.echo']);
  assert.equal((await mcp.connect('plugin.test.echo', directory)).connected, true);
  assert.equal((await mcp.callTool('plugin.test.echo', 'echo', {})).text, 'original');
  assert.equal(JSON.parse(readFileSync(join(directory, 'mcp-servers.json'), 'utf8')).servers[0].enabled, false,
    'derived enablement must not be persisted into the legacy store');
  current = [];
  assert.deepEqual(mcp.enabledTools(), []);
  assert.equal((await mcp.callTool('plugin.test.echo', 'echo', {})).attempted, false);
  await mcp.reconcileManagedServers();
  assert.deepEqual(mcp.statuses(), []);
});

test('global managed sessions are revoked on fingerprint, arguments, and environment changes', async () => {
  let current = config();
  mcp.configureManagedServers(() => [current]);
  for (const patch of [{ fingerprint: 'reviewed-v2' }, { env: { MANAGED_MARKER: 'changed' } },
    { args: [resolve('test/fixtures/managed-mcp-server.mjs'), 'changed-argument'] }]) {
    assert.equal((await mcp.connect(current.id, directory)).connected, true);
    current = { ...current, ...patch };
    assert.deepEqual(mcp.enabledTools(), []);
    assert.equal((await mcp.callTool(current.id, 'echo', {})).attempted, false);
    await mcp.reconcileManagedServers();
    assert.equal(mcp.statuses()[0].connected, false);
  }
  await mcp.connectEnabled(directory);
  assert.equal((await mcp.callTool(current.id, 'echo', {})).text, 'changed');
  await mcp.shutdown();
});

test('isolated workspaces recheck disabled and changed plugins instead of trusting their startup snapshot', async () => {
  let current = config();
  mcp.configureManagedServers(() => [current]);
  const isolated = await mcp.createWorkspaceRuntime(directory);
  try {
    assert.equal(isolated.enabledTools().length, 1);
    assert.equal((await isolated.callTool(current.id, 'echo', {})).ok, true);
    current = { ...current, fingerprint: 'changed-manifest-same-command' };
    assert.deepEqual(isolated.enabledTools(), []);
    assert.equal((await isolated.callTool(current.id, 'echo', {})).attempted, false);
  } finally { await isolated.shutdown(); }
  const another = await mcp.createWorkspaceRuntime(directory);
  current = { ...current, enabled: false };
  assert.equal((await another.callTool(current.id, 'echo', {})).attempted, false);
  await another.shutdown();
  assert.equal((await mcp.connect(current.id, directory)).connected, false);
});

test('a managed plugin revoked during connection never becomes connected', async () => {
  let current: ManagedMcpServerConfig[] = [config({ env: { TEST_MCP_DELAY: '150' } })];
  mcp.configureManagedServers(() => current);
  const connecting = mcp.connect(current[0].id, directory);
  setTimeout(() => { current = []; }, 20);
  assert.equal((await connecting).connected, false);
  assert.deepEqual(mcp.enabledTools(), []);
});

test('a registry failure or duplicate managed id fails closed', async () => {
  let fail = false;
  mcp.configureManagedServers(() => { if (fail) throw new Error('manifest became unreadable'); return [config()]; });
  assert.equal((await mcp.connect(config().id, directory)).connected, true);
  fail = true;
  assert.equal((await mcp.callTool(config().id, 'echo', {})).attempted, false);
  await mcp.reconcileManagedServers();
  mcp.configureManagedServers(() => [config(), config({ command: '/unexpected' })]);
  assert.deepEqual(mcp.statuses(), []);
});

test('explicit plugin reconciliation stops isolated processes and interrupts an in-flight call immediately', async () => {
  const pidPath = join(directory, 'isolated-server.pid');
  const callPath = join(directory, 'isolated-server.called');
  // Wrap the real fixture to observe process lifetime and hold the tool reply. The timer is
  // unref'd so ending stdio lets the fixture exit immediately instead of delaying shutdown.
  const wrapper = `
    const fs = require('node:fs');
    fs.writeFileSync(process.env.TEST_PID_PATH, String(process.pid));
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...args) => {
      if (JSON.parse(String(chunk)).result?.content) {
        fs.writeFileSync(process.env.TEST_CALL_PATH, 'called');
        setTimeout(() => write(chunk, ...args), 60000).unref();
        return true;
      }
      return write(chunk, ...args);
    };
    import(process.env.TEST_FIXTURE);
  `;
  let current: ManagedMcpServerConfig[] = [config({ args: ['-e', wrapper], env: {
    TEST_PID_PATH: pidPath, TEST_CALL_PATH: callPath,
    TEST_FIXTURE: pathToFileURL(resolve('test/fixtures/managed-mcp-server.mjs')).href,
  } })];
  mcp.configureManagedServers(() => current);
  const isolated = await mcp.createWorkspaceRuntime(directory);
  const pid = Number(readFileSync(pidPath, 'utf8'));
  try {
    assert.doesNotThrow(() => process.kill(pid, 0), 'fixture is alive before revocation');
    const pending = isolated.callTool(current[0].id, 'echo', {}, { timeoutMs: 5000 });
    const deadline = Date.now() + 2000;
    while (!existsSync(callPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(existsSync(callPath), true, 'tool invocation must be in flight');
    current = [];
    await mcp.reconcileManagedServers();
    // No enabledTools() or subsequent call is needed to trigger revocation.
    assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.attempted, true);
    assert.deepEqual(isolated.enabledTools(), []);
  } finally { await isolated.shutdown(); }
  // Repeated revocation/shutdown is idempotent after removing transport tracking.
  await mcp.reconcileManagedServers();
});
