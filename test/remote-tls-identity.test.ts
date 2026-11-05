import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RemoteTlsIdentityStore, certificatePin } from '../src/main/remote/tlsIdentity';

const secrets = {
  available: () => true,
  seal: (value: string) => Buffer.from(value, 'utf8').toString('base64'),
  open: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
};

test('remote TLS identity is stable, pinned, and never stores its private key in plaintext', async () => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-tls-'));
  const path = join(root, 'identity.json');
  const store = new RemoteTlsIdentityStore(path, secrets);

  const created = await store.loadOrCreate();
  const loaded = await store.loadOrCreate();
  assert.deepEqual(loaded, created);
  assert.equal(created.certificatePin, certificatePin(created.cert));
  assert.match(created.certificatePin, /^sha256\/[A-Za-z0-9+/=]+$/);

  const raw = readFileSync(path, 'utf8');
  assert.doesNotMatch(raw, /BEGIN PRIVATE KEY/);
  assert.match(raw, /BEGIN CERTIFICATE/);
});

test('remote TLS identity fails closed without an OS encryption backend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-tls-no-keyring-'));
  const store = new RemoteTlsIdentityStore(join(root, 'identity.json'), {
    ...secrets,
    available: () => false,
  });
  await assert.rejects(store.loadOrCreate(), /keyring/i);
});
