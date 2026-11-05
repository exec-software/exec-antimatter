import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from '../privateState';
import { listRemoteInterfaces, type RemoteInterface } from '../remote/settings';
import { DEFAULT_NODE_AGENT_PORT, type NodeAgentSettings } from '../../api/nodeAgent';

/**
 * Whether this box answers as an inference node, and on which interface.
 *
 * The same rule Remote follows: one explicit address, never a wildcard bind. A person choosing
 * which network their machine's capacity is published on is the whole point of the setting, and
 * `0.0.0.0` would quietly answer on every network the box is attached to.
 */
interface StoredNodeAgentSettings extends NodeAgentSettings {
  version: 1;
}

const EMPTY: StoredNodeAgentSettings = {
  version: 1,
  enabled: false,
  address: null,
  port: DEFAULT_NODE_AGENT_PORT,
};

export class NodeAgentSettingsStore {
  constructor(
    private readonly path: string,
    private readonly interfaces: () => RemoteInterface[] = listRemoteInterfaces
  ) {}

  read(): NodeAgentSettings {
    const ownsDirectory = migratePrivateDirectory(dirname(this.path));
    if (!existsSync(this.path)) return this.validate(EMPTY);
    if (ownsDirectory) migratePrivateFile(this.path);
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredNodeAgentSettings>;
      return this.validate({ ...EMPTY, ...parsed });
    } catch (error) {
      // An unreadable setting leaves the agent off. Failing open would publish an inventory of
      // this machine because a file was corrupt.
      console.error('[node-agent] settings unreadable; the node agent remains off:', error);
      return this.validate(EMPTY);
    }
  }

  write(patch: Partial<NodeAgentSettings>): NodeAgentSettings {
    const next = this.validate({ ...this.read(), ...patch });
    writePrivateFileAtomic(this.path, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`);
    return next;
  }

  private validate(input: NodeAgentSettings): NodeAgentSettings {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
      throw new Error('A node agent port must be between 1024 and 65535.');
    }
    const address = input.address?.trim() || null;
    if (input.enabled && !address) throw new Error('Choose one network interface before answering as a node.');
    if (address && !this.interfaces().some((candidate) => candidate.address === address)) {
      throw new Error('That network address is not assigned to this computer.');
    }
    return { enabled: !!input.enabled, address, port };
  }
}
