import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from '../privateState';

export const DEFAULT_REMOTE_PORT = 43_128;

export interface RemoteInterface {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  internal: boolean;
}

export interface RemoteSettings {
  enabled: boolean;
  /** Exact local address. Remote never implicitly binds every interface. */
  address: string | null;
  port: number;
  keepAwake: boolean;
}

interface StoredRemoteSettings extends RemoteSettings {
  version: 1;
}

const EMPTY: StoredRemoteSettings = {
  version: 1,
  enabled: false,
  address: null,
  port: DEFAULT_REMOTE_PORT,
  keepAwake: false,
};

export const listRemoteInterfaces = (): RemoteInterface[] =>
  Object.entries(networkInterfaces())
    .flatMap(([name, entries]) =>
      (entries ?? []).flatMap((entry) => {
        if (entry.family !== 'IPv4' && entry.family !== 'IPv6') return [];
        // Scoped link-local IPv6 addresses do not make usable mobile pairing endpoints. Loopback stays in the
        // list for local development but is visibly marked internal by the settings UI.
        if (entry.family === 'IPv6' && /^fe80:/i.test(entry.address)) return [];
        return [{ name, address: entry.address, family: entry.family, internal: entry.internal }];
      })
    )
    .sort((a, b) => Number(a.internal) - Number(b.internal) || a.name.localeCompare(b.name) || a.address.localeCompare(b.address));

export const httpsEndpoint = (address: string, port: number): string =>
  `https://${address.includes(':') ? `[${address}]` : address}:${port}`;

export class RemoteSettingsStore {
  constructor(
    private readonly path: string,
    private readonly interfaces: () => RemoteInterface[] = listRemoteInterfaces
  ) {}

  read(): RemoteSettings {
    const ownsDirectory = migratePrivateDirectory(dirname(this.path));
    if (!existsSync(this.path)) return this.validate(EMPTY);
    if (ownsDirectory) migratePrivateFile(this.path);
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredRemoteSettings>;
      return this.validate({ ...EMPTY, ...parsed });
    } catch (error) {
      console.error('[remote] settings unreadable; Remote remains disabled:', error);
      return this.validate(EMPTY);
    }
  }

  write(patch: Partial<RemoteSettings>): RemoteSettings {
    const next = this.validate({ ...this.read(), ...patch });
    writePrivateFileAtomic(this.path, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`);
    return next;
  }

  private validate(input: RemoteSettings): RemoteSettings {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
      throw new Error('Remote port must be between 1024 and 65535.');
    }
    const address = input.address?.trim() || null;
    if (input.enabled && !address) throw new Error('Choose one network interface before enabling Remote.');
    if (address && !this.interfaces().some((candidate) => candidate.address === address)) {
      throw new Error('That network address is not assigned to this computer.');
    }
    return {
      enabled: !!input.enabled,
      address,
      port,
      keepAwake: !!input.keepAwake,
    };
  }
}
