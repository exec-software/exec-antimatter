import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { ConnectionProvider } from '../../api/connections';
import { ConnectionHttp } from './http';
import type { ConnectionSecret, RegistrationRecord } from './store';

interface OAuthAttempt { id: string; provider: ConnectionProvider; registration: RegistrationRecord; redirect: string; state: string; verifier: string; server?: Server; used: boolean; controller: AbortController; timer: ReturnType<typeof setTimeout>; finish(secret: ConnectionSecret): void; error(message: string): void }
export function oauthEndpoints(provider: ConnectionProvider, tenant = 'common'): { authorize: string; token: string; scopes: string; pkce: boolean } {
  if (provider === 'outlook' || provider === 'teams') {
    if (!/^(common|organizations|consumers|[a-fA-F0-9-]{36})$/.test(tenant)) { throw new Error('Use a Microsoft tenant ID, common, organizations or consumers.'); }
    return { authorize: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`, token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, scopes: provider === 'outlook' ? 'offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send' : 'offline_access https://graph.microsoft.com/Chat.Read https://graph.microsoft.com/ChatMessage.Send', pkce: true };
  }
  if (provider === 'gmail') { return { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scopes: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send', pkce: true }; }
  if (provider === 'slack') { return { authorize: 'https://slack.com/oauth/v2/authorize', token: 'https://slack.com/api/oauth.v2.access', scopes: 'channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,chat:write', pkce: false }; }
  if (provider === 'yahoo') { return { authorize: 'https://api.login.yahoo.com/oauth2/request_auth', token: 'https://api.login.yahoo.com/oauth2/get_token', scopes: 'mail-r mail-w', pkce: false }; }
  throw new Error('Discord uses a bot token from your Discord application.');
}
export function registrationRedirect(provider: ConnectionProvider, value: string): URL {
  let uri: URL;
  try { uri = new URL(value); } catch { throw new Error('Use a valid registered callback URL.'); }
  if (uri.username || uri.password || uri.hash || uri.search || value.length > 2048) { throw new Error('Use a redirect URL without credentials, query or fragment.'); }
  if (['gmail', 'outlook', 'teams'].includes(provider)) {
    if (uri.protocol !== 'http:' || uri.hostname !== '127.0.0.1' || !uri.port) { throw new Error('Use a registered loopback redirect such as http://127.0.0.1:47831/callback.'); }
  } else if (uri.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname)) { throw new Error('This provider requires your registered HTTPS callback URL.'); }
  return uri;
}
const same = (left: string, right: string): boolean => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };

/** Desktop PKCE uses a single-use loopback listener; hosted callbacks remain bound to their exact URL and state. */
export class ConnectionsOAuth {
  private disposed = false;
  private exchanges = new Set<AbortController>();
  private attempts = new Map<string, OAuthAttempt>();
  constructor(private http: ConnectionHttp, private openBrowser: (url: string) => Promise<void>, private clientSecret: (registration: RegistrationRecord) => string) {}
  async start(provider: ConnectionProvider, registration: RegistrationRecord, finish: OAuthAttempt['finish'], error: OAuthAttempt['error']): Promise<{ id: string; manual: boolean }> {
    if (this.disposed) { throw new Error('Sign-in is shutting down.'); }
    if (registration.provider !== provider || typeof registration.clientId !== 'string' || !registration.clientId.trim() || registration.clientId.length > 500) { throw new Error('Invalid app registration.'); }
    if (this.attempts.size >= 4) { throw new Error('Finish or cancel an existing sign-in first.'); }
    const redirect = registrationRedirect(provider, registration.redirectUri);
    const endpoints = oauthEndpoints(provider, registration.tenant);
    if (!endpoints.pkce && !registration.secret) { throw new Error('Add your app client secret in the registration settings before signing in.'); }
    const id = randomUUID(); const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(48).toString('base64url');
    const attempt: OAuthAttempt = { id, provider, registration: structuredClone(registration), redirect: redirect.toString(), state, verifier, finish, error, used: false, controller: new AbortController(), timer: setTimeout(() => { this.cancel(id); error('Sign-in expired. Try again.'); }, 5 * 60 * 1000) };
    attempt.timer.unref(); this.attempts.set(id, attempt);
    try {
      if (redirect.protocol === 'http:') {
        const server = createServer((request, response) => {
          response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Security-Policy', "default-src 'none'");
          if (request.method !== 'GET' || request.headers.host !== redirect.host || (request.url?.length ?? 0) > 8192) { response.writeHead(400).end('Invalid sign-in request.'); return; }
          let callback: URL;
          try { callback = new URL(request.url ?? '/', redirect); } catch { response.writeHead(400).end('Invalid sign-in request.'); return; }
          if (callback.pathname !== redirect.pathname || !same(callback.searchParams.get('state') ?? '', state)) { response.writeHead(400).end('Invalid sign-in request.'); return; }
          void this.complete(id, callback.toString()).then(() => response.end('Signed in. Return to Antimatter.')).catch(() => response.writeHead(400).end('Sign-in failed. Return to Antimatter and try again.'));
        });
        server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxConnections = 8; attempt.server = server;
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(redirect.port), '127.0.0.1', () => { server.removeListener('error', reject); server.on('error', () => { this.cancel(id); error('The local sign-in listener stopped.'); }); resolve(); }); });
      }
      if (this.attempts.get(id) !== attempt || this.disposed) { throw new Error('Sign-in cancelled.'); }
      const url = new URL(endpoints.authorize);
      url.search = new URLSearchParams({ response_type: 'code', client_id: registration.clientId, redirect_uri: attempt.redirect, scope: endpoints.scopes, state,
        ...(endpoints.pkce ? { code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' } : {}),
        ...(provider === 'gmail' ? { access_type: 'offline', prompt: 'consent' } : {}) }).toString();
      await this.openBrowser(url.toString()); return { id, manual: !attempt.server };
    } catch { this.cancel(id); throw new Error('Could not start sign-in. Check the registration and whether the callback port is available.'); }
  }
  async complete(id: string, callbackUrl: string): Promise<void> {
    const attempt = this.attempts.get(id); if (!attempt || attempt.used) { throw new Error('Sign-in expired or was already completed.'); }
    if (typeof callbackUrl !== 'string' || callbackUrl.length > 8192) { throw new Error('Invalid callback URL.'); }
    let callback: URL;
    try { callback = new URL(callbackUrl); } catch { throw new Error('Invalid callback URL.'); }
    const expected = new URL(attempt.redirect);
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash || callback.searchParams.getAll('state').length !== 1 || callback.searchParams.getAll('code').length > 1 || callback.searchParams.getAll('error').length > 1 || !same(callback.searchParams.get('state') ?? '', attempt.state)) { throw new Error('This callback does not match the sign-in request.'); }
    attempt.used = true; attempt.server?.close(); attempt.server?.closeIdleConnections();
    try {
      if (callback.searchParams.has('error')) { throw new Error(); }
      const code = callback.searchParams.get('code'); if (!code || code.length > 4096) { throw new Error(); }
      const secret = await this.exchange(attempt.provider, attempt.registration, { grant_type: 'authorization_code', code, redirect_uri: attempt.redirect, ...(oauthEndpoints(attempt.provider).pkce ? { code_verifier: attempt.verifier } : {}) }, attempt.controller.signal);
      if (attempt.controller.signal.aborted || this.attempts.get(id) !== attempt) { throw new Error('Sign-in cancelled.'); }
      attempt.finish(secret);
    } catch { if (this.attempts.get(id) === attempt) { attempt.error('Sign-in failed. Check the app registration and permissions, then try again.'); } throw new Error('Sign-in failed or was cancelled. Check the app registration and try again.'); }
    finally { if (this.attempts.get(id) === attempt) { this.cancel(id); } }
  }
  async refresh(provider: ConnectionProvider, registration: RegistrationRecord, current: ConnectionSecret): Promise<ConnectionSecret> {
    if (!current.refreshToken) { throw new Error('Sign in again to refresh this connection.'); }
    const next = await this.exchange(provider, registration, { grant_type: 'refresh_token', refresh_token: current.refreshToken });
    return { ...next, refreshToken: next.refreshToken || current.refreshToken };
  }
  private async exchange(provider: ConnectionProvider, registration: RegistrationRecord, fields: Record<string, string>, signal?: AbortSignal): Promise<ConnectionSecret> {
    if (this.disposed) { throw new Error('Sign-in is shutting down.'); }
    const controller = new AbortController(); this.exchanges.add(controller);
    try {
      const endpoint = oauthEndpoints(provider, registration.tenant);
      const clientSecret = registration.secret ? this.clientSecret(registration) : '';
      const body = new URLSearchParams({ client_id: registration.clientId, ...fields, ...(clientSecret ? { client_secret: clientSecret } : {}) });
      const result = await this.http.request(endpoint.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
      if (controller.signal.aborted || signal?.aborted) { throw new Error('Sign-in cancelled.'); }
      const validToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 32000 && !/[\u0000-\u0020\u007f]/.test(value);
      if (!validToken(result.access_token) || result.refresh_token !== undefined && !validToken(result.refresh_token)) { throw new Error('Invalid token response.'); }
      const expires = result.expires_in === undefined ? null : Number(result.expires_in);
      if (expires !== null && (!Number.isFinite(expires) || expires <= 0 || expires > 315360000)) { throw new Error('Invalid token expiry.'); }
      return { accessToken: result.access_token, ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}), ...(expires !== null ? { expiresAt: Date.now() + expires * 1000 } : {}) };
    } catch { throw new Error('The provider could not authorize this connection. Sign in again and check the app registration.'); }
    finally { this.exchanges.delete(controller); }
  }
  cancel(id: string): void { const attempt = this.attempts.get(id); if (attempt) { this.attempts.delete(id); clearTimeout(attempt.timer); attempt.controller.abort(); attempt.server?.close(); attempt.server?.closeIdleConnections(); } }
  dispose(): void { this.disposed = true; for (const exchange of this.exchanges) { exchange.abort(); } for (const id of this.attempts.keys()) { this.cancel(id); } }
  busy(): boolean { return this.attempts.size > 0 || this.exchanges.size > 0; }
}
