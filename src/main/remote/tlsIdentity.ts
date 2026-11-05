import { X509Certificate, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import selfsigned from 'selfsigned';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from '../privateState';

export interface RemoteTlsSecrets {
  available(): boolean;
  seal(value: string): string;
  open(value: string): string;
}

export interface RemoteTlsIdentity {
  cert: string;
  key: string;
  /** SHA-256 of the exact leaf certificate DER, encoded for the pairing URL. */
  certificatePin: string;
}

interface StoredTlsIdentity {
  version: 1;
  cert: string;
  keyCipher: string;
  certificatePin: string;
}

const pinOf = (cert: string): string => {
  const digest = createHash('sha256').update(new X509Certificate(cert).raw).digest('base64');
  return `sha256/${digest}`;
};

/** Persistent TLS identity. Losing it intentionally invalidates every device's certificate pin. */
export class RemoteTlsIdentityStore {
  constructor(
    private readonly path: string,
    private readonly secrets: RemoteTlsSecrets,
    /** What to call the feature in an error a person has to act on. */
    private readonly label = 'Remote'
  ) {}

  async loadOrCreate(): Promise<RemoteTlsIdentity> {
    const ownsDirectory = migratePrivateDirectory(dirname(this.path));
    if (existsSync(this.path)) {
      if (ownsDirectory) migratePrivateFile(this.path);
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoredTlsIdentity;
      if (parsed?.version !== 1 || !parsed.cert || !parsed.keyCipher) {
        throw new Error(`The ${this.label} TLS identity is unreadable. Turn ${this.label} off and repair its identity file.`);
      }
      const certificatePin = pinOf(parsed.cert);
      if (certificatePin !== parsed.certificatePin) {
        throw new Error(`The ${this.label} TLS identity failed its integrity check.`);
      }
      if (!this.secrets.available()) {
        throw new Error(`${this.label} requires an available operating-system keyring.`);
      }
      return { cert: parsed.cert, key: this.secrets.open(parsed.keyCipher), certificatePin };
    }

    if (!this.secrets.available()) {
      throw new Error(`${this.label} requires an available operating-system keyring.`);
    }
    const now = new Date();
    // A long-lived pinned leaf keeps already paired devices stable. Rotation is an explicit
    // re-pairing event rather than a surprise on every annual renewal.
    const notAfter = new Date(now);
    notAfter.setFullYear(notAfter.getFullYear() + 10);
    const generated = await selfsigned.generate(
      [{ name: 'commonName', value: `Antimatter ${this.label}` }],
      {
        keyType: 'ec',
        curve: 'P-256',
        algorithm: 'sha256',
        notBeforeDate: new Date(now.getTime() - 5 * 60_000),
        notAfterDate: notAfter,
        extensions: [
          { name: 'basicConstraints', cA: false, critical: true },
          { name: 'keyUsage', digitalSignature: true, keyAgreement: true, critical: true },
          { name: 'extKeyUsage', serverAuth: true },
        ],
      }
    );
    const certificatePin = pinOf(generated.cert);
    const stored: StoredTlsIdentity = {
      version: 1,
      cert: generated.cert,
      keyCipher: this.secrets.seal(generated.private),
      certificatePin,
    };
    writePrivateFileAtomic(this.path, `${JSON.stringify(stored, null, 2)}\n`);
    return { cert: generated.cert, key: generated.private, certificatePin };
  }
}

export const certificatePin = pinOf;
