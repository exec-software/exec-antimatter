import type { SecretProtector } from './pairingStore';

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

const SECURE_LINUX_BACKENDS = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
]);

/**
 * Electron's Linux `basic_text` backend still makes isEncryptionAvailable() return true, but its
 * ciphertext is protected only by a hard-coded key. Remote device and TLS secrets therefore require
 * one of Electron's OS-keyring backends. macOS and Windows retain Electron's normal availability gate.
 */
export function secureRemoteStorageAvailable(
  storage: SafeStorageAdapter,
  platform: NodeJS.Platform = process.platform
): boolean {
  try {
    if (!storage.isEncryptionAvailable()) return false;
    if (platform !== 'linux') return true;
    const backend = storage.getSelectedStorageBackend?.();
    return typeof backend === 'string' && SECURE_LINUX_BACKENDS.has(backend);
  } catch {
    return false;
  }
}

export function createRemoteSafeStorageProtector(
  storage: SafeStorageAdapter,
  platform: NodeJS.Platform = process.platform
): SecretProtector & { available(): boolean } {
  const available = () => secureRemoteStorageAvailable(storage, platform);
  const requireSecureStorage = () => {
    if (!available()) {
      throw new Error('Remote connections require a secure operating-system keyring.');
    }
  };
  return {
    available,
    seal: (value) => {
      requireSecureStorage();
      return storage.encryptString(value).toString('base64');
    },
    open: (value) => {
      requireSecureStorage();
      return storage.decryptString(Buffer.from(value, 'base64'));
    },
  };
}
