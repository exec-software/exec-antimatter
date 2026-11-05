import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RemoteSettingsStore, httpsEndpoint } from '../src/main/remote/settings';

const interfaces = () => [
  { name: 'vpn0', address: '100.64.1.2', family: 'IPv4' as const, internal: false },
  { name: 'vpn0', address: 'fd00::2', family: 'IPv6' as const, internal: false },
];

test('remote host is disabled until one exact local interface is selected', () => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-settings-'));
  const store = new RemoteSettingsStore(join(root, 'remote.json'), interfaces);
  assert.deepEqual(store.read(), { enabled: false, address: null, port: 43_128, keepAwake: false });
  assert.throws(() => store.write({ enabled: true }), /choose one network interface/i);
  assert.throws(() => store.write({ address: '0.0.0.0' }), /not assigned/i);

  const saved = store.write({ address: '100.64.1.2', enabled: true });
  assert.equal(saved.enabled, true);
  assert.equal(new RemoteSettingsStore(join(root, 'remote.json'), interfaces).read().address, '100.64.1.2');
});

test('remote HTTPS endpoints bracket IPv6 literals', () => {
  assert.equal(httpsEndpoint('100.64.1.2', 43128), 'https://100.64.1.2:43128');
  assert.equal(httpsEndpoint('fd00::2', 43128), 'https://[fd00::2]:43128');
});
