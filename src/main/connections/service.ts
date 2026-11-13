import { createHash } from 'node:crypto';
import { connectionPlugin, type ConnectionDraft, type ConnectionInput, type ConnectionPlugin, type ConnectionProvider, type ConnectionReceipt, type ConnectionRegistration, type ConnectionState } from '../../api/connections';
import { ConnectionsStore, connectionProject, connectionProvider, connectionText, type AccountRecord, type ConnectionSecret } from './store';
import { ConnectionProviders, emailRecipients } from './providers';
import { ConnectionsOAuth, oauthEndpoints, registrationRedirect } from './oauth';

export class ConnectionsService {
  readonly oauth: ConnectionsOAuth;
  private error: string | null = null;
  private active = 0;
  private refreshes = new Map<string, Promise<ConnectionSecret>>();
  constructor(readonly store: ConnectionsStore, private providers: ConnectionProviders, openBrowser: (url: string) => Promise<void>, private changed: () => void = () => {}) {
    this.oauth = new ConnectionsOAuth(providers.http, openBrowser, (registration) => store.protector.open(registration.secret));
  }
  get(): ConnectionState { return { ...this.store.public(), error: this.error }; }
  enable(plugin: ConnectionPlugin, enabled: boolean): ConnectionState {
    if (!['comms', 'email'].includes(plugin) || typeof enabled !== 'boolean') { throw new Error('Invalid plugin setting.'); }
    this.store.change((record) => { record.plugins[plugin] = enabled; }); this.changed(); return this.get();
  }
  registration(input: Omit<ConnectionRegistration, 'hasSecret'> & { clientSecret?: string }): ConnectionState {
    const provider = connectionProvider(input?.provider); oauthEndpoints(provider, input.tenant || 'common');
    if (this.oauth.busy() || this.store.read().accounts.some((account) => account.provider === provider)) { throw new Error('Finish sign-in and disconnect this provider’s accounts before changing its app registration.'); }
    const clientId = connectionText(input.clientId, 500); const redirectUri = registrationRedirect(provider, input.redirectUri).toString();
    const tenant = connectionText(input.tenant || 'common', 100);
    if (input.clientSecret !== undefined && (!this.store.protector.available() || typeof input.clientSecret !== 'string' || input.clientSecret.length > 16000)) { throw new Error('Unlock the system keyring to store this client secret.'); }
    this.store.change((record) => {
      const old = record.registrations.find((entry) => entry.provider === provider);
      const secret = input.clientSecret === undefined ? old?.secret ?? '' : input.clientSecret ? this.store.protector.seal(input.clientSecret) : '';
      const entry = { provider, clientId, redirectUri, tenant, secret };
      record.registrations = [...record.registrations.filter((registration) => registration.provider !== provider), entry];
    }); this.changed(); return this.get();
  }
  async connect(input: ConnectionInput): Promise<ConnectionState> {
    const provider = connectionProvider(input?.provider);
    if (!['discord', 'slack', 'yahoo'].includes(provider)) { throw new Error('Use browser sign-in for this provider.'); }
    const label = connectionText(input.label, 120); const address = connectionText(input.address || '', 320, true); const guild = connectionText(input.guild || '', 100, true);
    if (provider === 'yahoo' && emailRecipients(address).length !== 1) { throw new Error('Enter one account email address.'); }
    if (provider === 'discord' && !/^[0-9]{1,25}$/.test(guild)) { throw new Error('Enter the Discord server ID for this bot.'); }
    const secret = { accessToken: connectionText(input.credential, 16000), password: provider === 'yahoo' };
    if (!this.store.read().plugins[connectionPlugin(provider)]) { throw new Error('Enable this plugin first.'); }
    if (!this.store.protector.available()) { throw new Error('Unlock the operating-system keyring first.'); }
    const account: AccountRecord = { id: 'verification', provider, label, address, guild, grants: {}, secret: '' };
    await this.run(() => this.providers.folders(account, secret));
    if (!this.store.read().plugins[connectionPlugin(provider)]) { throw new Error('The plugin was disabled while connecting.'); }
    this.store.add({ provider, label, address, guild }, secret); this.changed(); return this.get();
  }
  disconnect(id: string): ConnectionState {
    connectionText(id); this.store.change((record) => { record.accounts = record.accounts.filter((account) => account.id !== id); });
    this.changed(); return this.get();
  }
  async authorize(input: { provider: ConnectionProvider; label: string; address?: string }): Promise<{ id: string; manual: boolean }> {
    const provider = connectionProvider(input?.provider); const label = connectionText(input.label, 120); const address = connectionText(input.address || '', 320, true);
    if (['gmail', 'yahoo'].includes(provider) && emailRecipients(address).length !== 1) { throw new Error('Enter one account email address.'); }
    if (!this.store.protector.available()) { throw new Error('Unlock the operating-system keyring first.'); }
    const record = this.store.read(); if (!record.plugins[connectionPlugin(provider)]) { throw new Error('Enable the plugin first.'); }
    const registration = record.registrations.find((entry) => entry.provider === provider);
    if (!registration) { throw new Error('Add your app registration before signing in.'); }
    this.error = null;
    return this.oauth.start(provider, registration, (secret) => {
      if (!this.store.read().plugins[connectionPlugin(provider)]) { throw new Error('The plugin was disabled while signing in.'); }
      this.store.add({ provider, label, address, guild: '' }, secret); this.error = null; this.changed();
    }, (error) => { this.error = error; this.changed(); });
  }
  async complete(id: string, callback: string): Promise<ConnectionState> { await this.oauth.complete(id, callback); return this.get(); }
  access(id: string, workspace: string, read: boolean, send: boolean): ConnectionState {
    if (typeof read !== 'boolean' || typeof send !== 'boolean') { throw new Error('Invalid agent access.'); }
    const project = connectionProject(workspace);
    this.store.change((record) => { const account = record.accounts.find((entry) => entry.id === id); if (!account) { throw new Error('Account not found.'); }
      if (!read && !send) { delete account.grants[project]; } else { account.grants[project] = { read, send }; } });
    this.changed(); return this.get();
  }
  projectAccess(id: string, workspace: string): { read: boolean; send: boolean } { return this.store.account(id).grants[connectionProject(workspace)] ?? { read: false, send: false }; }
  agentAccounts(workspace: string): Array<{ id: string; provider: ConnectionProvider; label: string; address: string; read: boolean; send: boolean }> {
    const record = this.store.read(); const project = connectionProject(workspace);
    return record.accounts.filter((account) => record.plugins[connectionPlugin(account.provider)] && (account.grants[project]?.read || account.grants[project]?.send)).map((account) => ({ id: account.id, provider: account.provider, label: account.label, address: account.address, ...account.grants[project] }));
  }
  private async credentials(account: AccountRecord): Promise<ConnectionSecret> {
    const secret = this.store.secret(account);
    if (!secret.expiresAt || secret.expiresAt > Date.now() + 60000) { return secret; }
    const active = this.refreshes.get(account.id); if (active) { return active; }
    const operation = (async () => {
      const registration = this.store.read().registrations.find((entry) => entry.provider === account.provider);
      if (!registration) { throw new Error('The app registration is missing. Sign in again.'); }
      const next = await this.oauth.refresh(account.provider, registration, secret); const sealed = this.store.seal(next);
      this.store.change((record) => { const current = record.accounts.find((entry) => entry.id === account.id);
        if (!current || current.secret !== account.secret) { throw new Error('The account changed while refreshing.'); } current.secret = sealed; });
      return next;
    })(); this.refreshes.set(account.id, operation);
    try { return await operation; } finally { if (this.refreshes.get(account.id) === operation) { this.refreshes.delete(account.id); } }
  }
  private async read<T>(id: string, project: string | undefined, operation: (account: AccountRecord, secret: ConnectionSecret) => Promise<T>): Promise<T> {
    return this.run(async () => { const account = this.store.account(id, project, project ? 'read' : undefined); const secret = await this.credentials(account);
      const current = this.store.account(id, project, project ? 'read' : undefined); return operation(current, secret); });
  }
  folders(id: string, cursor?: string, project?: string) { return this.read(id, project, (account, secret) => this.providers.folders(account, secret, cursor)); }
  messages(id: string, folder: string, cursor?: string, project?: string) { return this.read(id, project, (account, secret) => this.providers.messages(account, secret, folder, cursor)); }
  message(id: string, folder: string, message: string, project?: string) { return this.read(id, project, (account, secret) => this.providers.message(account, secret, folder, message)); }
  async send(draft: ConnectionDraft, project?: string): Promise<ConnectionReceipt> {
    if (!draft || typeof draft !== 'object' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(draft.requestId)) { throw new Error('A unique send request ID is required.'); }
    connectionText(draft.account); connectionText(draft.destination, 2048); connectionText(draft.subject, 998, true); connectionText(draft.replyTo ?? '', 1024, true);
    if (typeof draft.text !== 'string' || !draft.text.trim() || draft.text.length > 65536 || draft.text.includes('\0')) { throw new Error('Enter a message up to 65,536 characters.'); }
    const account = this.store.account(draft.account, project, project ? 'send' : undefined);
    if (account.provider === 'teams' && draft.replyTo) { throw new Error('Teams replies are not available. Send a new chat message.'); }
    if (connectionPlugin(account.provider) === 'email') { emailRecipients(draft.destination); }
    if ((account.provider === 'discord' && draft.text.length > 2000) || (account.provider === 'slack' && draft.text.length > 40000)) { throw new Error('This message exceeds the provider text limit.'); }
    const fingerprint = createHash('sha256').update(JSON.stringify([draft.account, draft.destination, draft.subject, draft.text, draft.replyTo ?? ''])).digest('hex');
    const key = draft.requestId;
    const previous = this.store.read().sends[key];
    if (previous) {
      if (previous.fingerprint !== fingerprint) { throw new Error('This request ID belongs to a different message.'); }
      return { requestId: key, state: previous.state === 'sent' ? 'sent' : 'uncertain', messageId: previous.messageId };
    }
    return this.run(async () => {
      const secret = await this.credentials(account); this.store.account(draft.account, project, project ? 'send' : undefined);
      let duplicate = false;
      this.store.change((record) => {
        const entry = record.sends[key]; if (entry) { if (entry.fingerprint !== fingerprint) { throw new Error('Request ID conflict.'); } duplicate = true; return; }
        if (Object.keys(record.sends).length >= 10000) { throw new Error('Send history has reached this installation’s storage limit. Existing receipts are retained and sending is disabled.'); }
        record.sends[key] = { fingerprint, state: 'pending' };
      });
      if (duplicate) { const receipt = this.store.read().sends[key]; return { requestId: key, state: receipt.state === 'sent' ? 'sent' : 'uncertain', messageId: receipt.messageId }; }
      try {
        const messageId = await this.providers.send(account, secret, draft);
        this.store.change((record) => { record.sends[key] = { fingerprint, state: 'sent', ...(messageId ? { messageId } : {}) }; });
        return { requestId: key, state: 'sent', ...(messageId ? { messageId } : {}) };
      } catch {
        // A timeout or a crash after a provider accepted a message must never trigger an automatic resend.
        try { this.store.change((record) => { record.sends[key] = { fingerprint, state: 'uncertain' }; }); } catch { /* The durable pending receipt already blocks retries. */ }
        return { requestId: key, state: 'uncertain' };
      }
    });
  }
  receipt(requestId: string): ConnectionReceipt | null {
    if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(requestId)) { throw new Error('Invalid send request ID.'); }
    const entry = this.store.read().sends[requestId];
    return entry ? { requestId, state: entry.state === 'sent' ? 'sent' : 'uncertain', ...(entry.messageId ? { messageId: entry.messageId } : {}) } : null;
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> { if (this.active >= 8) { throw new Error('Too many connection requests. Wait for one to finish.'); } this.active++;
    try { return await operation(); } catch (error) { if (error instanceof TypeError) { throw new Error('The provider could not be reached. Check your connection and try again.'); } throw error; } finally { this.active--; } }
  busy(): boolean { return this.active > 0 || this.oauth.busy(); }
  dispose(): void { this.oauth.dispose(); }
}
