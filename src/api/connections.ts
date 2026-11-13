export type ConnectionProvider = 'discord' | 'slack' | 'teams' | 'outlook' | 'gmail' | 'yahoo';
export type ConnectionPlugin = 'comms' | 'email';
export interface ConnectionRegistration { provider: ConnectionProvider; clientId: string; redirectUri: string; tenant: string; hasSecret: boolean }
export interface ConnectionAccount {
  id: string; provider: ConnectionProvider; label: string; address: string; guild: string;
  connected: boolean; agentRead: boolean; agentSend: boolean; projectCount: number;
}
export interface ConnectionState {
  revision: number; secureStorage: boolean; plugins: Record<ConnectionPlugin, boolean>;
  accounts: ConnectionAccount[]; registrations: ConnectionRegistration[];
  error?: string | null;
}
export interface ConnectionFolder { id: string; name: string }
export interface ConnectionMessage { id: string; from: string; subject: string; text: string; date: string; replyTo?: string }
export interface ConnectionPage<T> { items: T[]; cursor?: string }
export interface ConnectionDraft { account: string; destination: string; subject: string; text: string; replyTo?: string; requestId: string }
export interface ConnectionReceipt { requestId: string; state: 'sent' | 'uncertain'; messageId?: string }
export interface ConnectionInput { provider: ConnectionProvider; label: string; address?: string; guild?: string; credential: string }
export interface ConnectionsAPI {
  get(): Promise<ConnectionState>;
  enable(plugin: ConnectionPlugin, enabled: boolean): Promise<ConnectionState>;
  registration(input: Omit<ConnectionRegistration, 'hasSecret'> & { clientSecret?: string }): Promise<ConnectionState>;
  connect(input: ConnectionInput): Promise<ConnectionState>;
  disconnect(account: string): Promise<ConnectionState>;
  authorize(input: { provider: ConnectionProvider; label: string; address?: string }): Promise<{ id: string; manual: boolean }>;
  complete(id: string, callbackUrl: string): Promise<ConnectionState>;
  cancelAuthorization(id: string): Promise<void>;
  access(account: string, threadId: string, read: boolean, send: boolean): Promise<ConnectionState>;
  projectAccess(account: string, threadId: string): Promise<{ read: boolean; send: boolean }>;
  folders(account: string, cursor?: string): Promise<ConnectionPage<ConnectionFolder>>;
  messages(account: string, folder: string, cursor?: string): Promise<ConnectionPage<ConnectionMessage>>;
  message(account: string, folder: string, id: string): Promise<ConnectionMessage>;
  send(draft: ConnectionDraft): Promise<ConnectionReceipt>;
  receipt(requestId: string): Promise<ConnectionReceipt | null>;
  onChanged(callback: () => void): () => void;
}
export const CONNECTION_PROVIDERS: ConnectionProvider[] = ['discord', 'slack', 'teams', 'outlook', 'gmail', 'yahoo'];
export const connectionPlugin = (provider: ConnectionProvider): ConnectionPlugin => ['discord', 'slack', 'teams'].includes(provider) ? 'comms' : 'email';
