import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultHubCache } from '../src/main/hub/cache';
import { HubSettings, normalizeToken, type SecretBox } from '../src/main/hub/settings';

const keyring: SecretBox = {
  available: () => true,
  seal: (value) => Buffer.from([...value].reverse().join('')).toString('base64'),
  open: (sealed) => [...Buffer.from(sealed, 'base64').toString('utf8')].reverse().join(''),
};

test('the token is sealed at rest, never stored in the clear, and can be removed', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-hub-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'userData', 'hub-settings.json');
  const settings = new HubSettings(path, keyring, {});

  assert.equal(settings.token(), null);
  const state = settings.setToken('  hf_abcdefghijklmnopqrstuvwxyz0123456789  ');
  assert.deepEqual({ configured: state.configured, encrypted: state.encrypted }, { configured: true, encrypted: true });
  assert.equal(settings.token(), 'hf_abcdefghijklmnopqrstuvwxyz0123456789');
  assert.equal(readFileSync(path, 'utf8').includes('hf_abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(statSync(path).mode & 0o777, 0o600);

  // A fresh instance reads it back from disk.
  assert.equal(new HubSettings(path, keyring, {}).token(), 'hf_abcdefghijklmnopqrstuvwxyz0123456789');

  settings.setToken(null);
  assert.equal(settings.token(), null);
  assert.equal(settings.tokenState().configured, false);

  const noKeyring = new HubSettings(join(root, 'plain.json'), { ...keyring, available: () => false }, {});
  noKeyring.setToken('hf_plaintextfallback');
  assert.equal(noKeyring.tokenState().encrypted, false, 'the UI is told when there is no keyring');
  assert.match(readFileSync(join(root, 'plain.json'), 'utf8'), /"tokenPlain": "hf_plaintextfallback"/);

  const legacyPath = join(root, 'legacy-cipher.json');
  new HubSettings(legacyPath, keyring, {}).setToken('hf_legacyciphertext');
  const legacyReader = new HubSettings(legacyPath, { ...keyring, available: () => false }, {});
  assert.equal(legacyReader.token(), 'hf_legacyciphertext', 'legacy cipher blobs remain readable');
  assert.equal(legacyReader.tokenState().encrypted, false, 'an unavailable secure backend is not called a keyring');
  legacyReader.setToken('hf_newplaintextfallback');
  const rewritten = readFileSync(legacyPath, 'utf8');
  assert.match(rewritten, /"tokenPlain": "hf_newplaintextfallback"/);
  assert.doesNotMatch(rewritten, /tokenCipher/);
});

test('pasted tokens with whitespace inside are refused', () => {
  assert.throws(() => normalizeToken('hf_abc def123'), /spaces or line breaks/);
  assert.throws(() => normalizeToken('   '), /empty/);
  assert.throws(() => normalizeToken('short'), /does not look like/);
});

test('import copies HF_TOKEN first, then the hf login token file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-hub-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tokenFile = join(root, 'hf-home', 'token');
  mkdirSync(join(root, 'hf-home'), { recursive: true });
  writeFileSync(tokenFile, 'hf_fromthelogintokenfile\n');

  const fromFile = new HubSettings(join(root, 'a.json'), keyring, { HF_HOME: join(root, 'hf-home') });
  assert.equal(fromFile.tokenState().importable, 'file');
  assert.equal(fromFile.tokenState().importPath, tokenFile);
  assert.equal(fromFile.importToken(), true);
  assert.equal(fromFile.token(), 'hf_fromthelogintokenfile');

  const fromEnv = new HubSettings(join(root, 'b.json'), keyring, { HF_HOME: join(root, 'hf-home'), HF_TOKEN: 'hf_fromtheenvironment' });
  assert.equal(fromEnv.tokenState().importable, 'env');
  fromEnv.importToken();
  assert.equal(fromEnv.token(), 'hf_fromtheenvironment');

  const nothing = new HubSettings(join(root, 'c.json'), keyring, { HF_HOME: join(root, 'missing') });
  assert.equal(nothing.importToken(), false);
});

test('downloads default to the cache huggingface_hub would use, and a chosen directory must be absolute', (t) => {
  assert.equal(defaultHubCache({}, '/home/u'), '/home/u/.cache/huggingface/hub');
  assert.equal(defaultHubCache({ XDG_CACHE_HOME: '/x' }, '/home/u'), '/x/huggingface/hub');
  assert.equal(defaultHubCache({ HF_HOME: '/hf' }, '/home/u'), '/hf/hub');
  assert.equal(defaultHubCache({ HF_HOME: '/hf', HF_HUB_CACHE: '/models' }, '/home/u'), '/models');

  const root = mkdtempSync(join(tmpdir(), 'antimatter-hub-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = new HubSettings(join(root, 'settings.json'), keyring, { HF_HOME: '/hf' });
  assert.deepEqual(settings.rootState(), { path: '/hf/hub', isDefault: true, defaultPath: '/hf/hub' });
  assert.throws(() => settings.setRoot('relative/models'), /absolute/);
  assert.deepEqual(settings.setRoot('/mnt/nvme/models/'), { path: '/mnt/nvme/models', isDefault: false, defaultPath: '/hf/hub' });
  assert.equal(settings.root(), '/mnt/nvme/models');
  settings.setRoot(null);
  assert.equal(settings.root(), '/hf/hub');
});
