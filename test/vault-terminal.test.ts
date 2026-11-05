import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The last step of the delivery: an approved credential reaching the shell.
 *
 * What is asserted here is as much about where the secret is *not* as where it is. It arrives in
 * the command's environment, and it is absent from the tool arguments — which is what the approval
 * prompt quotes, what the transcript stores, and what is replayed to the model on every later
 * round of the turn.
 */
let selectedStorageBackend = 'gnome_libsecret';
const electron = {
  app: { getPath: () => tmpdir(), getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => selectedStorageBackend,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').replace(/^sealed:/, ''),
  },
};

type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const nodeModule = require('node:module') as { _load: ModuleLoader };
const originalLoad = nodeModule._load;
nodeModule._load = function load(request, parent, isMain) {
  return request === 'electron' ? electron : originalLoad.call(this, request, parent, isMain);
};
const store = require('../src/main/vault/store') as typeof import('../src/main/vault/store');
const grants = require('../src/main/vault/grants') as typeof import('../src/main/vault/grants');
const { withTerminal } = require('../src/main/terminalTools') as typeof import('../src/main/terminalTools');
nodeModule._load = originalLoad;

const SECRET = 'hunter2hunter2';

interface Recorded {
  command: string;
  env?: Record<string, string>;
}

const harness = (t: { after(fn: () => void): void }) => {
  const base = mkdtempSync(join(tmpdir(), 'antimatter-vault-terminal-'));
  store.useStorePath(join(base, 'vault.json'));
  grants.releaseAll();
  store.setEnabled(true);
  store.save({ tag: 'sudo', label: 'This box', secret: SECRET });
  t.after(() => {
    grants.releaseAll();
    store.forget();
    rmSync(base, { recursive: true, force: true });
  });

  const seen: Recorded[] = [];
  const runtime = withTerminal(
    {
      enabledTools: () => [
        { serverId: 'antimatter', serverName: 'Antimatter', tool: { name: 'run_command', description: '', inputSchema: {}, enabled: true } },
      ],
      callTool: async () => ({ ok: true, text: 'inner', attempted: true }),
    } as never,
    {
      workspace: base,
      runCommand: (async (spec: { command: string; env?: Record<string, string> }) => {
        seen.push({ command: spec.command, env: spec.env });
        return { ok: true, text: `$ ${spec.command}\n[exit] 0`, attempted: true };
      }) as never,
    }
  );
  const call = (args: Record<string, unknown>, runId = 'run-1') =>
    runtime.callTool('antimatter', 'run_command', args, { activity: { runId, callId: 'c1' } } as never);
  return { base, seen, call };
};

test('an armed credential reaches the command through its environment, and nowhere else', async (t) => {
  const { seen, call } = harness(t);
  grants.arm('run-1', 'sudo', 'install the build dependencies');

  const args = { command: 'printf \'%s\\n\' "$ANTIMATTER_VAULT_SUDO" | sudo -S -p \'\' apt-get install -y foo' };
  const result = await call(args);

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].env, { ANTIMATTER_VAULT_SUDO: SECRET });
  // The arguments are the transcript's copy of the call and are replayed on every later round.
  assert.ok(!JSON.stringify(args).includes(SECRET), 'the secret must not be written into the arguments');
  assert.ok(!seen[0].command.includes(SECRET), 'nor interpolated into the command line, which /proc exposes');
  assert.equal(store.status().entries[0].useCount, 1);
  assert.ok(!result.text.includes(SECRET));
});

test('only a command that names the variable gets it, or is charged for it', async (t) => {
  const { seen, call } = harness(t);
  grants.arm('run-1', 'sudo', 'install the build dependencies');

  // Ten incidental commands must not exhaust an approval before the command it was given for.
  await call({ command: 'ls -la' });
  assert.equal(seen[0].env, undefined);
  assert.equal(store.status().entries[0].useCount, 0, 'a command that does not ask is not charged');

  for (const command of [
    'sudo -S -p "" apt-get update <<<"$ANTIMATTER_VAULT_SUDO"',
    'printf %s "${ANTIMATTER_VAULT_SUDO}" | sudo -S true',
  ]) {
    const before = seen.length;
    await call({ command });
    assert.deepEqual(seen[before].env, { ANTIMATTER_VAULT_SUDO: SECRET }, command);
  }
  assert.equal(store.status().entries[0].useCount, 2);

  // A longer name that merely starts with this one is a different variable.
  await call({ command: 'echo "$ANTIMATTER_VAULT_SUDO_BACKUP"' });
  assert.equal(seen[seen.length - 1].env, undefined);
  assert.equal(store.status().entries[0].useCount, 2);
});

test('a command runs with no vault environment when nothing was approved', async (t) => {
  const { seen, call } = harness(t);
  await call({ command: 'ls' });
  assert.equal(seen[0].env, undefined, 'an unapproved turn gets a plain environment');

  // And a grant armed for a different turn is not this turn's to spend.
  grants.arm('other-run', 'sudo', 'something else');
  await call({ command: 'ls' }, 'run-1');
  assert.equal(seen[1].env, undefined);
});

test('one command spends exactly one use of its approval', async (t) => {
  const { call } = harness(t);
  grants.arm('run-1', 'sudo', 'install packages');
  await call({ command: 'sudo -S true <<<"$ANTIMATTER_VAULT_SUDO"' });
  assert.equal(store.status().entries[0].useCount, 1, 'not two: the lookup must happen once per command');
});
