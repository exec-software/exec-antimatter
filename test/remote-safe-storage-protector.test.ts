import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRemoteSafeStorageProtector,
  secureRemoteStorageAvailable,
  type SafeStorageAdapter,
} from '../src/main/remote/safeStorageProtector';

function storage(options: {
  encryptionAvailable?: boolean;
  backend?: string;
} = {}): SafeStorageAdapter {
  const { encryptionAvailable = true, backend = 'gnome_libsecret' } = options;
  return {
    isEncryptionAvailable: () => encryptionAvailable,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^sealed:/, ''),
  };
}

test('Linux remote secrets require one of Electron secure keyring backends', () => {
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    assert.equal(secureRemoteStorageAvailable(storage({ backend }), 'linux'), true, backend);
  }
  for (const backend of ['basic_text', 'unknown', 'future_backend']) {
    assert.equal(secureRemoteStorageAvailable(storage({ backend }), 'linux'), false, backend);
  }
  assert.equal(
    secureRemoteStorageAvailable({ ...storage(), getSelectedStorageBackend: undefined }, 'linux'),
    false,
  );
});

test('non-Linux remote secrets preserve Electron encryption availability semantics', () => {
  const throwingBackend = {
    ...storage(),
    getSelectedStorageBackend: () => { throw new Error('Linux-only API must not be called.'); },
  };
  assert.equal(secureRemoteStorageAvailable(throwingBackend, 'darwin'), true);
  assert.equal(secureRemoteStorageAvailable(throwingBackend, 'win32'), true);
  assert.equal(secureRemoteStorageAvailable(storage({ encryptionAvailable: false }), 'darwin'), false);
});

test('remote protector refuses unavailable, basic_text, and unknown Linux storage', () => {
  for (const unsafe of [
    storage({ encryptionAvailable: false, backend: 'gnome_libsecret' }),
    storage({ backend: 'basic_text' }),
    storage({ backend: 'unknown' }),
  ]) {
    const protector = createRemoteSafeStorageProtector(unsafe, 'linux');
    assert.equal(protector.available(), false);
    assert.throws(() => protector.seal('device-secret'), /secure operating-system keyring/i);
    assert.throws(() => protector.open('c2VhbGVkOmRldmljZS1zZWNyZXQ='), /secure operating-system keyring/i);
  }
});

test('remote protector round-trips only after the secure gate passes', () => {
  const protector = createRemoteSafeStorageProtector(storage({ backend: 'kwallet6' }), 'linux');
  const sealed = protector.seal('device-secret');
  assert.notEqual(sealed, 'device-secret');
  assert.equal(protector.open(sealed), 'device-secret');
});
