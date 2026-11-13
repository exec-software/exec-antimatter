import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionHttp } from '../src/main/connections/http';
import { ConnectionsOAuth, registrationRedirect, oauthEndpoints } from '../src/main/connections/oauth';
import { ConnectionsStore, connectionProject, type ConnectionSecret, type RegistrationRecord } from '../src/main/connections/store';

const registration: RegistrationRecord = { provider: 'slack', clientId: 'test-client', secret: 'sealed-client-secret', redirectUri: 'https://fixture.example.test/callback', tenant: 'common' };
const scratch = (t: { after(fn: () => void): void }) => { const directory = mkdtempSync(join(tmpdir(), 'antimatter-connections-test-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; };
const freePort = () => new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; server.close(() => resolve(port)); }); });
const callback = (url: string, state: string, code = 'fixture-code') => { const result = new URL(url); result.searchParams.set('state', state); result.searchParams.set('code', code); return result.toString(); };
function oauthFixture(response: Record<string, unknown> = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 }) {
  const calls: Array<{ url: string; body: URLSearchParams; signal?: AbortSignal | null }> = []; const browsers: string[] = []; const finished: ConnectionSecret[] = []; const errors: string[] = [];
  const oauth = new ConnectionsOAuth(new ConnectionHttp(async (url, init) => { calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)), signal: init?.signal }); return Response.json(response); }), async url => { browsers.push(url); }, () => 'fixture-client-secret');
  return { oauth, calls, browsers, finished, errors, start: () => oauth.start('slack', registration, secret => { finished.push(secret); }, error => { errors.push(error); }) };
}

test('manual OAuth binds exact callback/state, consumes once, and never puts client secrets in browser URLs', async t => {
  const f = oauthFixture(); t.after(() => f.oauth.dispose()); const attempt = await f.start(); assert.equal(attempt.manual, true); assert.equal(f.oauth.busy(), true);
  const authorize = new URL(f.browsers[0]); const state = authorize.searchParams.get('state')!; assert.doesNotMatch(f.browsers[0], /fixture-client-secret/);
  await assert.rejects(f.oauth.complete(attempt.id, callback('https://evil.example.test/callback', state)), /does not match/);
  await assert.rejects(f.oauth.complete(attempt.id, callback(registration.redirectUri, 'wrong-state')), /does not match/);
  await assert.rejects(f.oauth.complete(attempt.id, callback(registration.redirectUri, state) + '&state=second'), /does not match/);
  assert.equal(f.calls.length, 0); await f.oauth.complete(attempt.id, callback(registration.redirectUri, state));
  assert.equal(f.finished.length, 1); assert.equal(f.finished[0].accessToken, 'fixture-access'); assert.equal(f.calls[0].body.get('client_secret'), 'fixture-client-secret'); assert.equal(f.oauth.busy(), false);
  await assert.rejects(f.oauth.complete(attempt.id, callback(registration.redirectUri, state)), /already completed/); assert.equal(f.calls.length, 1);
});

test('real loopback callback validates host/state and exchanges the matching PKCE verifier', async t => {
  const f = oauthFixture(); t.after(() => f.oauth.dispose()); const redirectUri = `http://127.0.0.1:${await freePort()}/callback`;
  const reg = { ...registration, provider: 'gmail' as const, secret: '', redirectUri };
  const attempt = await f.oauth.start('gmail', reg, secret => f.finished.push(secret), error => f.errors.push(error)); assert.equal(attempt.manual, false);
  const authorize = new URL(f.browsers[0]); assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal((await fetch(callback(redirectUri, 'wrong-state'))).status, 400); assert.equal(f.calls.length, 0);
  const response = await fetch(callback(redirectUri, authorize.searchParams.get('state')!)); assert.equal(response.status, 200); assert.match(await response.text(), /Signed in/);
  const verifier = f.calls[0].body.get('code_verifier')!;
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
  assert.equal(f.calls[0].body.get('redirect_uri'), redirectUri); assert.equal(f.calls[0].body.has('client_secret'), false); assert.equal(f.finished.length, 1);
});

test('cancel during token exchange blocks account creation and busy state includes the in-flight exchange', async t => {
  let release: (() => void) | undefined; let browser = ''; let finishCount = 0; let count = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const oauth = new ConnectionsOAuth(new ConnectionHttp(async () => { count++; await held; return Response.json({ access_token: 'late-token' }); }), async url => { browser = url; }, () => 'fixture-client-secret');
  t.after(() => oauth.dispose()); const attempt = await oauth.start('slack', registration, () => { finishCount++; }, () => {});
  const url = callback(registration.redirectUri, new URL(browser).searchParams.get('state')!); const pending = oauth.complete(attempt.id, url);
  await assert.rejects(oauth.complete(attempt.id, url), /already completed/); assert.equal(oauth.busy(), true); assert.equal(count, 1);
  oauth.cancel(attempt.id); release!(); await assert.rejects(pending, /cancelled/); assert.equal(finishCount, 0); assert.equal(oauth.busy(), false);
});

test('refresh rotates credentials, retains omitted refresh token, and rejects malformed/oversized tokens without echoing them', async t => {
  const f = oauthFixture({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 }); t.after(() => f.oauth.dispose());
  const refreshed = await f.oauth.refresh('slack', registration, { accessToken: 'old-access', refreshToken: 'old-refresh' }); assert.equal(refreshed.refreshToken, 'rotated-refresh'); assert.equal(f.calls[0].body.get('grant_type'), 'refresh_token');
  const without = oauthFixture({ access_token: 'new-access' }); t.after(() => without.oauth.dispose()); assert.equal((await without.oauth.refresh('slack', registration, { accessToken: 'old-access', refreshToken: 'old-refresh' })).refreshToken, 'old-refresh');
  for (const response of [{ access_token: 'token\nheader' }, { access_token: 'a'.repeat(32001) }, { access_token: 'good', expires_in: 'Infinity' }, { access_token: 'good', refresh_token: 'b'.repeat(32001) }]) {
    const invalid = oauthFixture(response); t.after(() => invalid.oauth.dispose()); await assert.rejects(invalid.oauth.refresh('slack', registration, { accessToken: 'old', refreshToken: 'refresh' }), /could not authorize/);
  }
});

test('OAuth endpoint/registration restrictions and shutdown refuse unsupported or unsafe flows', async t => {
  for (const uri of ['https://127.0.0.1:4000/callback', 'http://localhost:4000/callback', 'http://127.0.0.1:4000/callback?x=y']) assert.throws(() => registrationRedirect('gmail', uri));
  assert.throws(() => registrationRedirect('slack', 'http://127.0.0.1:4000/callback')); assert.throws(() => oauthEndpoints('outlook', '../../tenant'));
  const f = oauthFixture(); t.after(() => f.oauth.dispose()); f.oauth.dispose(); await assert.rejects(f.start(), /shutting down/);
  assert.match(oauthEndpoints('outlook').scopes, /Mail.Send/); assert.doesNotMatch(oauthEndpoints('outlook').scopes, /Mail.ReadWrite/);
});

function storeFixture(t: { after(fn: () => void): void }) {
  const directory = scratch(t); const file = join(directory, 'state', 'connections.json'); const protectedValues = new Map<string, string>(); let serial = 0; let available = true;
  const protector = { available: () => available, seal: (value: string) => { const id = `sealed-${++serial}`; protectedValues.set(id, value); return id; }, open: (value: string) => { if (!protectedValues.has(value)) throw Error('private protector failure'); return protectedValues.get(value)!; } };
  const store = new ConnectionsStore(file, protector); const root = join(directory, 'project'); mkdirSync(root);
  return { directory, file, store, root, protector, lock: () => { available = false; } };
}
const accountInput = { provider: 'slack' as const, label: 'Fixture', address: '', guild: '' };

test('store encrypts credentials, exposes only public fields, and rejects grants until explicitly enabled for this project', t => {
  const f = storeFixture(t); const id = f.store.add(accountInput, { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' });
  assert.doesNotMatch(readFileSync(f.file, 'utf8'), /fixture-access|fixture-refresh/); assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.throws(() => f.store.account(id, f.root, 'read'), /unavailable/);
  f.store.change(record => { record.plugins.comms = true; }); assert.throws(() => f.store.account(id, f.root, 'read'), /disabled/);
  f.store.change(record => { record.accounts[0].grants[connectionProject(f.root)] = { read: true, send: false }; });
  assert.equal(f.store.account(id, f.root, 'read').id, id); assert.throws(() => f.store.account(id, f.root, 'send'), /disabled/);
  const alias = join(f.directory, 'alias'); symlinkSync(f.root, alias); assert.equal(f.store.account(id, alias, 'read').id, id);
  assert.equal(new ConnectionsStore(f.file, f.protector).secret(f.store.account(id)).accessToken, 'fixture-access');
  assert.doesNotMatch(JSON.stringify(f.store.public()), /sealed-|fixture-access|fixture-refresh/);
  f.lock(); assert.throws(() => f.store.secret(f.store.account(id)), /Unlock/); assert.throws(() => f.store.add(accountInput, { accessToken: 'new-token' }), /keyring/);
});

test('store validates registration/receipt records and strips unknown fields before public projection', t => {
  const f = storeFixture(t); f.store.change(record => { record.registrations = [registration]; });
  const raw = JSON.parse(readFileSync(f.file, 'utf8')); raw.registrations[0].accessToken = 'injected-secret'; writeFileSync(f.file, JSON.stringify(raw));
  assert.doesNotMatch(JSON.stringify(f.store.public()), /injected-secret|sealed-client-secret/);
  raw.sends = { '11111111-2222-3333-4444-555555555555': { fingerprint: 'a'.repeat(64), state: 'surprise' } }; writeFileSync(f.file, JSON.stringify(raw));
  assert.throws(() => f.store.read(), /could not be read/); const before = readFileSync(f.file, 'utf8'); assert.throws(() => f.store.change(record => { record.plugins.email = true; })); assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('store refuses symlink/corrupt files and malformed secrets without silently resetting data', t => {
  const f = storeFixture(t); assert.throws(() => f.store.add(accountInput, { accessToken: 'token\r\nheader' }), /Invalid/);
  assert.throws(() => f.store.add(accountInput, { accessToken: 'token', expiresAt: Infinity }), /expiry/);
  f.store.add(accountInput, { accessToken: 'token' }); const before = readFileSync(f.file, 'utf8'); writeFileSync(f.file, '{broken'); assert.throws(() => f.store.read()); assert.equal(readFileSync(f.file, 'utf8'), '{broken');
  rmSync(f.file); const outside = join(f.directory, 'outside.json'); writeFileSync(outside, before); symlinkSync(outside, f.file); assert.throws(() => f.store.read()); assert.equal(readFileSync(outside, 'utf8'), before);
});
