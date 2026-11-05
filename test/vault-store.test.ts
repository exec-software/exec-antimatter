import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The Vault's guarantees, tested where they are actually made.
 *
 * Three of them are the whole feature, so each has a test that would fail loudly if the
 * implementation ever softened: a secret is never written in the clear, a secret is never returned
 * to anything outside the main process, and a secret is masked out of tool output before a model
 * or a transcript can see it.
 */
let encryptionAvailable = true;
let selectedStorageBackend = 'gnome_libsecret';
let decryptionFails = false;

const electron = {
  app: { getPath: () => tmpdir(), getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    getSelectedStorageBackend: () => selectedStorageBackend,
    // A reversible stand-in for the keyring: the point under test is that the *stored* bytes are
    // not the secret and that nothing but unseal() ever turns them back.
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      if (decryptionFails) throw new Error('temporary keyring failure');
      return value.toString('utf8').replace(/^sealed:/, '');
    },
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
const { withVault } = require('../src/main/vault/tools') as typeof import('../src/main/vault/tools');
nodeModule._load = originalLoad;

const fresh = (t: { after(fn: () => void): void }): string => {
  const base = mkdtempSync(join(tmpdir(), 'antimatter-vault-'));
  const path = join(base, 'vault.json');
  store.useStorePath(path);
  encryptionAvailable = true;
  selectedStorageBackend = 'gnome_libsecret';
  decryptionFails = false;
  grants.releaseAll();
  t.after(() => {
    grants.releaseAll();
    store.forget();
    rmSync(base, { recursive: true, force: true });
  });
  return path;
};

test('a secret is sealed on disk, never stored in the clear, and the file stays private', (t) => {
  const path = fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'sudo', label: 'This box', secret: 'correct horse battery' });

  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes('correct horse battery'), 'the plaintext secret must not appear in the store');
  // sourceStore keeps an apiKeyPlain fallback; the Vault deliberately has no equivalent field.
  assert.ok(!/plain/i.test(raw), 'the Vault must not write a plaintext fallback field');
  // What is on disk is base64 of whatever the keyring produced, and nothing else about the value.
  const stored = (JSON.parse(raw) as { entries: { cipher: string }[] }).entries[0].cipher;
  assert.equal(Buffer.from(stored, 'base64').toString('utf8'), 'sealed:correct horse battery');
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('without a real OS keyring nothing can be stored and the Vault cannot be turned on', (t) => {
  fresh(t);
  // Electron's Linux basic_text backend reports encryption as available while protecting it with
  // a key compiled into the binary. For a machine password that is not storage, it is theatre.
  selectedStorageBackend = 'basic_text';
  assert.equal(store.sealingAvailable(), false);
  assert.throws(() => store.setEnabled(true), /keyring/i);
  assert.throws(() => store.save({ tag: 'sudo', secret: 'hunter2' }), /keyring/i);
  assert.equal(store.status().entries.length, 0);
});

test('a vault whose keyring disappeared reports itself off and keeps the sealed blobs', (t) => {
  fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'sudo', secret: 'hunter2' });
  assert.equal(store.enabled(), true);

  encryptionAvailable = false;
  store.forget();
  const status = store.status();
  assert.equal(status.enabled, false, 'no keyring means no tools, even though the setting says on');
  assert.equal(status.entries.length, 1, 'the sealed credential is kept, not discarded');

  encryptionAvailable = true;
  store.forget();
  assert.equal(store.enabled(), true, 'and it comes back when the keyring does');
});

test('tags are normalized to one safe token and the environment name follows from them', (t) => {
  fresh(t);
  store.setEnabled(true);
  store.save({ tag: '  My SUDO Pass!  ', secret: 'x1234' });
  const entry = store.status().entries[0];
  assert.equal(entry.tag, 'my-sudo-pass');
  assert.equal(entry.envName, 'ANTIMATTER_VAULT_MY_SUDO_PASS');
  assert.throws(() => store.save({ tag: '!!!', secret: 'x1234' }), /needs a tag/i);
});

test('saving the same tag replaces it in place, and a blank secret keeps the stored one', (t) => {
  fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'github', label: 'old label', secret: 'token-one' });
  store.save({ tag: 'github', label: 'new label', username: 'nathan' });

  const entries = store.status().entries;
  assert.equal(entries.length, 1, 'one tag is one credential');
  assert.equal(entries[0].label, 'new label');
  assert.equal(entries[0].username, 'nathan');
  assert.equal(store.unseal('github'), 'token-one', 'an edit that sends no secret must not erase one');

  store.save({ tag: 'github', secret: 'token-two' });
  assert.equal(store.unseal('github'), 'token-two');
  assert.throws(() => store.save({ tag: 'brand-new' }), /needs a secret/i);
});

test('nothing that leaves the store carries the secret', (t) => {
  fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'sudo', secret: 'topsecretvalue', notes: 'for apt' });

  const serialized = JSON.stringify(store.status());
  assert.ok(!serialized.includes('topsecretvalue'), 'status() crosses IPC and must be secret-free');
  assert.ok(!serialized.includes('sealed:'), 'not even the sealed blob leaves the main process');
  assert.ok(serialized.includes('for apt'), 'the metadata a model needs does leave');
  assert.equal(JSON.stringify(store.find('sudo')).includes('topsecretvalue'), false);
});

test('an unsealable blob reports what to do instead of returning an empty secret', (t) => {
  fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'sudo', secret: 'hunter2' });
  decryptionFails = true;
  assert.throws(() => store.unseal('sudo'), /re-enter it in Settings/);
});

test('an unreadable store is treated as off rather than as an empty one', (t) => {
  const path = fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'sudo', secret: 'hunter2' });
  require('node:fs').writeFileSync(path, '{ this is not json', { mode: 0o600 });
  store.forget();
  assert.equal(store.status().enabled, false);
  assert.equal(store.status().entries.length, 0);
});

test('a grant hands the secret to a command as an environment variable, and only that', (t) => {
  fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'sudo', label: 'This box', secret: 'hunter2hunter2' });

  const armed = grants.arm('run-1', 'sudo', 'install the build dependencies');
  assert.equal(armed.envName, 'ANTIMATTER_VAULT_SUDO');
  // The arming result is what the model is told; it must describe the variable, not hold a value.
  assert.ok(!JSON.stringify(armed).includes('hunter2hunter2'));

  assert.deepEqual(grants.environmentFor('run-1'), { ANTIMATTER_VAULT_SUDO: 'hunter2hunter2' });
  assert.equal(grants.environmentFor('another-run'), undefined, 'a grant belongs to one turn');

  // Given a command, only one that names the variable is served — and charged.
  assert.equal(grants.environmentFor('run-1', 'ls -la'), undefined);
  assert.deepEqual(grants.environmentFor('run-1', 'sudo -S true <<<"$ANTIMATTER_VAULT_SUDO"'), {
    ANTIMATTER_VAULT_SUDO: 'hunter2hunter2',
  });
});

test('an approval covers a bounded number of commands, then stops', (t) => {
  fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'sudo', secret: 'hunter2hunter2' });
  grants.arm('run-1', 'sudo', 'install packages');

  for (let used = 0; used < grants.GRANT_LIMITS.maxUses; used += 1) {
    assert.ok(grants.environmentFor('run-1'), `use ${used + 1} should still be covered`);
  }
  assert.equal(grants.environmentFor('run-1'), undefined, 'the budget is spent, not renewed');
  assert.equal(store.status().entries[0].useCount, grants.GRANT_LIMITS.maxUses, 'each use is recorded for the user');
});

test('a turn that ends, and a vault that is switched off, both revoke what was armed', (t) => {
  fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'sudo', secret: 'hunter2hunter2' });

  grants.arm('run-1', 'sudo', 'first');
  grants.release('run-1');
  assert.equal(grants.environmentFor('run-1'), undefined);

  grants.arm('run-2', 'sudo', 'second');
  grants.releaseAll();
  assert.equal(grants.environmentFor('run-2'), undefined);
  assert.equal(grants.anyActive(), false);
});

test('arming refuses when the vault is off or the tag is unknown, and unseals nothing', (t) => {
  fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'sudo', secret: 'hunter2hunter2' });
  assert.throws(() => grants.arm('run-1', 'nosuchtag', 'why'), /tagged "nosuchtag"/);

  store.setEnabled(false);
  assert.throws(() => grants.arm('run-1', 'sudo', 'why'), /Vault is off/);
  assert.equal(grants.anyActive(), false);
});

test('a live secret is masked out of text, and a stale one needs no masking', (t) => {
  fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'sudo', secret: 'hunter2hunter2' });
  grants.arm('run-1', 'sudo', 'install packages');

  const leak = 'SHELL=/bin/bash\nANTIMATTER_VAULT_SUDO=hunter2hunter2\nTERM=xterm (hunter2hunter2)';
  const masked = grants.redact(leak);
  assert.ok(!masked.includes('hunter2hunter2'), 'every occurrence, not just the first');
  assert.equal(masked.match(/\[vault:sudo redacted\]/g)?.length, 2);
  assert.ok(masked.includes('SHELL=/bin/bash'), 'the rest of the output survives');

  grants.release('run-1');
  assert.equal(grants.redact(leak), leak, 'with nothing armed there is nothing to mask');
});

/** A minimal inner runtime: enough to observe what the Vault wrapper passes through and changes. */
const innerRuntime = (result: string) => ({
  enabledTools: () => [
    { serverId: 'antimatter', serverName: 'Antimatter', tool: { name: 'run_command', description: '', inputSchema: {}, enabled: true } },
  ],
  callTool: async () => ({ ok: true, text: result, attempted: true }),
});

test('the Vault offers no tools while it is off, even to a turn already under way', async (t) => {
  fresh(t);
  store.save({ tag: 'sudo', secret: 'hunter2hunter2' });
  const runtime = withVault(innerRuntime('ok') as never, { runId: 'run-1' });
  assert.deepEqual(runtime.enabledTools().map((entry) => entry.tool.name), ['run_command']);

  // A definition read on an earlier round must not outlive the setting that offered it.
  store.setEnabled(true);
  assert.deepEqual(runtime.enabledTools().map((entry) => entry.tool.name), ['run_command', 'vault_list', 'vault_use']);
  store.setEnabled(false);
  const refused = await runtime.callTool('antimatter.vault', 'vault_use', { tag: 'sudo', purpose: 'x' }, undefined);
  assert.equal(refused.ok, false);
  assert.match(refused.text, /Vault is off/);
});

test('vault_list describes the credentials without disclosing any of them', async (t) => {
  fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'sudo', label: 'This box', username: 'nathan', notes: 'apt and systemctl', secret: 'hunter2hunter2' });
  const runtime = withVault(innerRuntime('ok') as never, { runId: 'run-1' });

  const listed = await runtime.callTool('antimatter.vault', 'vault_list', {}, undefined);
  assert.equal(listed.ok, true);
  assert.ok(!listed.text.includes('hunter2hunter2'));
  for (const expected of ['sudo', 'This box', 'nathan', 'apt and systemctl', 'ANTIMATTER_VAULT_SUDO']) {
    assert.ok(listed.text.includes(expected), `vault_list should mention ${expected}`);
  }
});

test('vault_use arms a grant, tells the model only the variable name, and needs a purpose', async (t) => {
  fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'sudo', label: 'This box', secret: 'hunter2hunter2' });
  const runtime = withVault(innerRuntime('ok') as never, { runId: 'run-1' });

  const missing = await runtime.callTool('antimatter.vault', 'vault_use', { tag: 'sudo' }, undefined);
  assert.equal(missing.ok, false);
  assert.match(missing.text, /purpose/);
  assert.equal(grants.anyActive(), false, 'a rejected call must not arm anything');

  const used = await runtime.callTool(
    'antimatter.vault', 'vault_use', { tag: 'sudo', purpose: 'install build dependencies' },
    { activity: { runId: 'run-1' } } as never
  );
  assert.equal(used.ok, true);
  assert.ok(!used.text.includes('hunter2hunter2'), 'the tool result reaches the model and the transcript');
  assert.ok(used.text.includes('ANTIMATTER_VAULT_SUDO'));
  assert.deepEqual(grants.environmentFor('run-1'), { ANTIMATTER_VAULT_SUDO: 'hunter2hunter2' });
});

test('every tool result passing the Vault is masked, not just the shell’s', async (t) => {
  fresh(t);
  store.setEnabled(true);
  store.save({ tag: 'sudo', secret: 'hunter2hunter2' });

  // A secret that reached a file comes back through read_file; one that reached an agent comes
  // back in its report. Both pass through here, which is why the Vault wraps outermost.
  const runtime = withVault(innerRuntime('config.ini: password=hunter2hunter2') as never, { runId: 'run-1' });
  const before = await runtime.callTool('antimatter', 'read_file', { path: 'config.ini' }, undefined);
  assert.ok(before.text.includes('hunter2hunter2'), 'nothing is armed, so nothing is masked');

  grants.arm('run-1', 'sudo', 'install packages');
  const after = await runtime.callTool('antimatter', 'read_file', { path: 'config.ini' }, undefined);
  assert.ok(!after.text.includes('hunter2hunter2'));
  assert.match(after.text, /\[vault:sudo redacted\]/);
});
