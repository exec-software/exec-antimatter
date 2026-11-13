export type JsonObject = Record<string, any>;
const HOSTS = new Set(['slack.com', 'discord.com', 'graph.microsoft.com', 'gmail.googleapis.com', 'oauth2.googleapis.com', 'login.microsoftonline.com', 'api.login.yahoo.com']);

/** Credentials only travel to provider-owned HTTPS endpoints, never redirects or response links. */
export class ConnectionHttp {
  constructor(private fetcher: typeof fetch = fetch) {}
  async request(url: string, init: RequestInit = {}): Promise<JsonObject> {
    let target: URL;
    try { target = new URL(url); } catch { throw new Error('Unsupported connection endpoint.'); }
    if (target.protocol !== 'https:' || !HOSTS.has(target.hostname) || target.port || target.username || target.password) { throw new Error('Unsupported connection endpoint.'); }
    let response: Response;
    try { response = await this.fetcher(target, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }); }
    catch { throw new Error('The provider could not be reached. Check your connection and try again.'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401) { throw new Error('Sign in again to refresh this connection.'); }
      if (response.status === 403) { throw new Error('The provider denied access. Check the app permissions and account membership.'); }
      if (response.status === 429) { throw new Error('The provider rate limit was reached. Wait before refreshing.'); }
      throw new Error(`Provider request failed (${response.status}).`);
    }
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) {
      try { for (;;) { const item = await reader.read(); if (item.done) { break; } size += item.value.length;
        if (size > 2 * 1024 * 1024) { throw new Error('The provider response is too large.'); } chunks.push(item.value); } }
      catch { await reader.cancel().catch(() => undefined); throw new Error(size > 2 * 1024 * 1024 ? 'The provider response is too large.' : 'The provider response could not be read.'); }
      finally { reader.releaseLock(); }
    }
    if (!size) { return {}; }
    let result: JsonObject;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('The provider returned an invalid response.'); }
    if (!result || typeof result !== 'object') { throw new Error('The provider returned an invalid response.'); }
    if (result.ok === false) { throw new Error(['invalid_auth', 'token_revoked', 'token_expired'].includes(result.error) ? 'Sign in again to refresh this Slack connection.' : result.error === 'ratelimited' ? 'Slack rate limit reached. Wait before refreshing.' : 'Slack denied the request. Check app permissions and channel membership.'); }
    return result;
  }
}
export function providerPage(base: string, cursor?: string): string {
  if (!cursor) { return base; }
  if (cursor.length > 8192) { throw new Error('Invalid page cursor.'); }
  let target: URL; let expected: URL;
  try { target = new URL(cursor); expected = new URL(base); } catch { throw new Error('Invalid page cursor.'); }
  if (target.origin !== expected.origin || target.pathname !== expected.pathname || target.username || target.password || target.hash) { throw new Error('Invalid page cursor.'); }
  return target.toString();
}
export const textValue = (value: unknown, max = 65536): string => typeof value === 'string' ? value.slice(0, max) : '';
export const plainHtml = (value: unknown): string => textValue(value).replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '').replace(/<\s*(?:br|\/p|\/div)\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&(?:lt|gt|amp|quot|#39|nbsp);/g, (entity) => ({ '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' })[entity] ?? entity);
