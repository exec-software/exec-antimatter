import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { CONNECTION_PROVIDERS, connectionPlugin, type ConnectionProvider, type ConnectionRegistration, type ConnectionState } from '../../api/connections';
import type { SecretProtector } from '../remote/pairingStore';
import { writePrivateFileAtomic } from '../privateState';

export interface ConnectionSecret { accessToken: string; refreshToken?: string; expiresAt?: number; password?: boolean; clientSecret?: string }
export interface AccountRecord { id: string; provider: ConnectionProvider; label: string; address: string; guild: string; secret: string; grants: Record<string, { read: boolean; send: boolean }> }
export interface RegistrationRecord extends Omit<ConnectionRegistration, 'hasSecret'> { secret: string }
export interface ConnectionRecord {
  version: 1; revision: number; plugins: { comms: boolean; email: boolean }; accounts: AccountRecord[]; registrations: RegistrationRecord[];
  sends: Record<string, { fingerprint: string; state: 'pending' | 'sent' | 'uncertain'; messageId?: string }>;
}
export function connectionText(value: unknown, max = 200, optional = false): string {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) { throw new Error('Invalid connection field.'); }
  return value.trim();
}
export function connectionProvider(value: unknown): ConnectionProvider {
  if (!CONNECTION_PROVIDERS.includes(value as ConnectionProvider)) { throw new Error('Unknown connection provider.'); }
  return value as ConnectionProvider;
}
export const connectionProject = (root: string): string => createHash('sha256').update(realpathSync(root)).digest('hex');

const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid connection data.'); } return value as Record<string, unknown>; };
const MAX_SEALED_SECRET = 256000;
function parseSecret(raw: unknown): ConnectionSecret {
  const value = object(raw);
  const accessToken = connectionText(value.accessToken, 32000);
  if (value.password !== true && /[\u0000-\u0020\u007f]/.test(accessToken)) { throw new Error('Invalid credential.'); }
  const refreshToken = value.refreshToken === undefined ? undefined : connectionText(value.refreshToken, 32000);
  if (refreshToken && /[\u0000-\u0020\u007f]/.test(refreshToken)) { throw new Error('Invalid credential.'); }
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0 || value.expiresAt > 8.64e15)) { throw new Error('Invalid credential expiry.'); }
  if (value.password !== undefined && typeof value.password !== 'boolean') { throw new Error('Invalid credential kind.'); }
  return { accessToken, ...(refreshToken ? { refreshToken } : {}), ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt as number } : {}),
    ...(value.password !== undefined ? { password: value.password as boolean } : {}), ...(value.clientSecret !== undefined ? { clientSecret: connectionText(value.clientSecret, 16000) } : {}) };
}
function parseRecord(raw: unknown): ConnectionRecord {
  const value = object(raw); const plugins = object(value.plugins);
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof plugins.comms !== 'boolean' || typeof plugins.email !== 'boolean'
    || !Array.isArray(value.accounts) || value.accounts.length > 50 || !Array.isArray(value.registrations) || value.registrations.length > 6) { throw new Error('Unsupported connections store.'); }
  const accounts = value.accounts.map(raw => {
    const account = object(raw); const grants = object(account.grants);
    if (Object.keys(grants).length > 10000) { throw new Error('Too many connection grants.'); }
    const parsedGrants = Object.fromEntries(Object.entries(grants).map(([key, rawGrant]) => {
      const grant = object(rawGrant);
      if (!/^[a-f0-9]{64}$/.test(key) || typeof grant.read !== 'boolean' || typeof grant.send !== 'boolean') { throw new Error('Invalid connection grant.'); }
      return [key, { read: grant.read, send: grant.send }];
    }));
    return { id: connectionText(account.id), provider: connectionProvider(account.provider), label: connectionText(account.label), address: connectionText(account.address, 320, true),
      guild: connectionText(account.guild, 100, true), secret: connectionText(account.secret, MAX_SEALED_SECRET), grants: parsedGrants };
  });
  if (new Set(accounts.map(account => account.id)).size !== accounts.length) { throw new Error('Duplicate connection accounts.'); }
  const registrations = value.registrations.map(raw => {
    const registration = object(raw); const provider = connectionProvider(registration.provider);
    if (provider === 'discord') { throw new Error('Discord uses a bot credential, not an OAuth registration.'); }
    const redirectUri = connectionText(registration.redirectUri, 2048); const redirect = new URL(redirectUri);
    if (redirect.username || redirect.password || redirect.search || redirect.hash || !['http:', 'https:'].includes(redirect.protocol)) { throw new Error('Invalid registration redirect.'); }
    return { provider, clientId: connectionText(registration.clientId, 500), redirectUri, tenant: connectionText(registration.tenant, 100), secret: connectionText(registration.secret, MAX_SEALED_SECRET, true) };
  });
  if (new Set(registrations.map(registration => registration.provider)).size !== registrations.length) { throw new Error('Duplicate app registrations.'); }
  const rawSends = object(value.sends);
  if (Object.keys(rawSends).length > 10000) { throw new Error('Too many send receipts.'); }
  const sends = Object.fromEntries(Object.entries(rawSends).map(([key, rawReceipt]) => {
    const receipt = object(rawReceipt);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key) || typeof receipt.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || !['pending', 'sent', 'uncertain'].includes(String(receipt.state))) { throw new Error('Invalid send receipt.'); }
    return [key, { fingerprint: receipt.fingerprint, state: receipt.state as 'pending' | 'sent' | 'uncertain', ...(receipt.messageId !== undefined ? { messageId: connectionText(receipt.messageId, 1024) } : {}) }];
  }));
  return { version: 1, revision: Number(value.revision), plugins: { comms: plugins.comms, email: plugins.email }, accounts, registrations, sends };
}

export class ConnectionsStore {
  constructor(private file: string, readonly protector: SecretProtector & { available(): boolean }, private write = writePrivateFileAtomic) {}
  read(): ConnectionRecord {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) { throw new Error('Invalid connections store.'); }
      const bytes = Buffer.alloc(stat.size + 1);
      const size = readSync(descriptor, bytes, 0, bytes.length, 0);
      if (size !== stat.size) { throw new Error('Connections changed while reading.'); }
      const after = fstatSync(descriptor);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) { throw new Error('Connections changed while reading.'); }
      return parseRecord(JSON.parse(bytes.subarray(0, size).toString('utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { version: 1, revision: 0, plugins: { comms: false, email: false }, accounts: [], registrations: [], sends: {} }; }
      throw new Error('Connections could not be read. Restore the private settings file before making changes.');
    } finally { if (descriptor !== undefined) { closeSync(descriptor); } }
  }
  change(update: (record: ConnectionRecord) => void): void {
    const record = this.read(); update(record); record.revision++;
    const text = JSON.stringify(parseRecord(record));
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) { throw new Error('Connection storage is full.'); }
    this.write(this.file, text);
  }
  public(): ConnectionState {
    const record = this.read();
    return { revision: record.revision, secureStorage: this.protector.available(), plugins: record.plugins,
      accounts: record.accounts.map((account) => ({ id: account.id, provider: account.provider, label: account.label, address: account.address, guild: account.guild,
        connected: !!account.secret, agentRead: Object.values(account.grants).some((grant) => grant.read), agentSend: Object.values(account.grants).some((grant) => grant.send), projectCount: Object.keys(account.grants).length })),
      registrations: record.registrations.map(({ provider, clientId, redirectUri, tenant, secret }) => ({ provider, clientId, redirectUri, tenant, hasSecret: !!secret })) };
  }
  seal(secret: ConnectionSecret): string {
    if (!this.protector.available()) { throw new Error('Connections require an unlocked operating-system keyring.'); }
    return this.protector.seal(JSON.stringify(parseSecret(secret)));
  }
  secret(account: AccountRecord): ConnectionSecret {
    if (!this.protector.available()) { throw new Error('Unlock the operating-system keyring to use this connection.'); }
    try { return parseSecret(JSON.parse(this.protector.open(account.secret))); }
    catch { throw new Error('Credentials could not be opened. Connect this account again.'); }
  }
  account(id: string, project?: string, operation?: 'read' | 'send'): AccountRecord {
    const record = this.read(); const account = record.accounts.find((entry) => entry.id === id);
    if (!account || !record.plugins[connectionPlugin(account.provider)]) { throw new Error('This connection is unavailable.'); }
    if (operation && (!project || !account.grants[connectionProject(project)]?.[operation])) { throw new Error('Agent access is disabled for this project.'); }
    return account;
  }
  add(input: Omit<AccountRecord, 'id' | 'secret' | 'grants'>, secret: ConnectionSecret): string {
    const id = randomUUID(); const sealed = this.seal(secret);
    this.change((record) => { if (record.accounts.length >= 50) { throw new Error('Remove an account before adding another.'); } record.accounts.push({ ...input, id, secret: sealed, grants: {} }); });
    return id;
  }
}
