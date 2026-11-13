import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { ConnectionHttp, providerPage } from '../src/main/connections/http';
import { ConnectionProviders, emailRecipients } from '../src/main/connections/providers';
import type { AccountRecord } from '../src/main/connections/store';
import type { ConnectionProvider, ConnectionDraft } from '../src/api/connections';

const account = (provider: ConnectionProvider): AccountRecord => ({ id: 'account', provider, label: 'Fixture', address: 'fixture@example.test', guild: '12345', secret: 'sealed', grants: {} });
const secret = { accessToken: 'fixture-credential' };
const draft: ConnectionDraft = { account: 'account', destination: 'recipient@example.test', subject: 'Subject', text: 'Test message', requestId: '11111111-2222-3333-4444-555555555555' };
function fixture(responses: unknown[]) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const http = new ConnectionHttp(async (url, init = {}) => { requests.push({ url: String(url), init }); return new Response(JSON.stringify(responses.shift() ?? {}), { status: 200 }); });
  return { provider: new ConnectionProviders(http), requests };
}
const body = (request: { init: RequestInit }) => JSON.parse(String(request.init.body));

test('HTTP never sends credentials to arbitrary origins or redirects and sanitizes transport/provider errors', async () => {
  let calls = 0;
  const http = new ConnectionHttp(async (_url, init) => { calls++; assert.equal(init?.redirect, 'error'); assert.ok(init?.signal); throw Error('fixture-credential echoed by transport'); });
  for (const url of ['http://slack.com/api/test', 'https://slack.com.evil.test/api/test', 'https://u:p@slack.com/api/test', 'https://slack.com:123/api/test', 'bad fixture-credential']) await assert.rejects(http.request(url), /Unsupported connection endpoint/);
  assert.equal(calls, 0); await assert.rejects(http.request('https://slack.com/api/test'), error => { assert.doesNotMatch(String(error), /fixture-credential/); return true; });
  for (const [status, message] of [[401, 'Sign in again'], [403, 'denied'], [429, 'rate limit']] as const) {
    await assert.rejects(new ConnectionHttp(async () => new Response('fixture-credential', { status })).request('https://slack.com/api/test'), new RegExp(message));
  }
  await assert.rejects(new ConnectionHttp(async () => Response.json({ ok: false, error: 'fixturecredential' })).request('https://slack.com/api/test'), error => { assert.doesNotMatch(String(error), /fixturecredential/); return true; });
});

test('HTTP bounds streamed responses and Graph pagination cannot move credentials to another resource', async () => {
  await assert.rejects(new ConnectionHttp(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))).request('https://graph.microsoft.com/v1.0/me/chats'), /too large/);
  await assert.rejects(new ConnectionHttp(async () => new Response('{bad')).request('https://graph.microsoft.com/v1.0/me/chats'), /invalid response/);
  const base = 'https://graph.microsoft.com/v1.0/me/chats?$top=50';
  assert.equal(providerPage(base, 'https://graph.microsoft.com/v1.0/me/chats?$skiptoken=next'), 'https://graph.microsoft.com/v1.0/me/chats?$skiptoken=next');
  for (const cursor of ['https://evil.test/me/chats', 'https://graph.microsoft.com/v1.0/users', 'https://graph.microsoft.com/v1.0/me/chats#x', 'invalid']) assert.throws(() => providerPage(base, cursor), /Invalid page cursor/);
});

test('Outlook replies use Mail.Send reply endpoint and retain explicitly reviewed recipients', async () => {
  const { provider, requests } = fixture([{}]);
  await provider.send(account('outlook'), secret, { ...draft, replyTo: 'message/id' });
  assert.equal(requests[0].url, 'https://graph.microsoft.com/v1.0/me/messages/message%2Fid/reply');
  assert.equal(body(requests[0]).message.body.contentType, 'Text'); assert.deepEqual(body(requests[0]).message.toRecipients, [{ emailAddress: { address: draft.destination } }]);
  assert.equal(body(requests[0]).message.internetMessageHeaders, undefined);
});

test('Gmail replies preserve API thread identity and RFC MIME reply headers without executing attachments', async () => {
  const { provider, requests } = fixture([{ threadId: 'thread-id', payload: { headers: [{ name: 'Message-ID', value: '<original@example.test>' }] } }, { id: 'sent-id' }]);
  assert.equal(await provider.send(account('gmail'), secret, { ...draft, replyTo: 'api-message-id' }), 'sent-id');
  assert.match(requests[0].url, /messages\/api-message-id\?format=metadata/);
  const sent = body(requests[1]); assert.equal(sent.threadId, 'thread-id'); const mime = Buffer.from(sent.raw, 'base64url').toString();
  assert.match(mime, /In-Reply-To: <original@example.test>/); assert.match(mime, /References: <original@example.test>/); assert.match(mime, /Test message/);
});

test('Gmail MIME reader ignores attachments, strips HTML, and exposes a replyable sender address', async () => {
  const { provider } = fixture([{ id: 'api-id', payload: { headers: [{ name: 'From', value: 'Fixture Name <sender@example.test>' }], parts: [
    { mimeType: 'text/html', body: { data: Buffer.from('<script>bad()</script><p>Hello &amp; goodbye</p>').toString('base64url') } },
    { mimeType: 'text/plain', filename: 'attachment.txt', body: { data: Buffer.from('attachment').toString('base64url') } },
  ] } }]);
  const message = await provider.message(account('gmail'), secret, 'INBOX', 'api-id');
  assert.equal(message.from, 'sender@example.test'); assert.equal(message.replyTo, 'api-id'); assert.match(message.text, /Hello & goodbye/); assert.doesNotMatch(message.text, /bad|attachment|script/);
});

test('communication sends are scoped and keep idempotency/thread hints; Teams never silently drops a reply', async () => {
  const { provider, requests } = fixture([{ id: 'sent' }, { ts: '100.1' }]);
  await provider.send(account('discord'), secret, { ...draft, destination: 'channel', replyTo: 'parent' });
  assert.deepEqual(body(requests[0]).allowed_mentions, { parse: [] }); assert.equal(body(requests[0]).enforce_nonce, true); assert.equal(body(requests[0]).message_reference.message_id, 'parent');
  await provider.send(account('slack'), secret, { ...draft, destination: 'C123', replyTo: '100.0' });
  assert.equal(body(requests[1]).thread_ts, '100.0'); assert.equal(body(requests[1]).client_msg_id, draft.requestId); assert.equal(body(requests[1]).unfurl_links, false);
  await assert.rejects(provider.send(account('teams'), secret, { ...draft, replyTo: 'unsupported' }), /not supported/); assert.equal(requests.length, 2);
});

type ImapFactory = NonNullable<ConstructorParameters<typeof ConnectionProviders>[1]>;
function yahooFixture(ids: number[] = []) {
  const seen: { options?: unknown; search?: unknown; fetch?: unknown; readOnly?: unknown; closed: boolean } = { closed: false };
  let download: unknown = { content: Readable.from(['From: Fixture <sender@example.test>\r\nSubject: Test\r\nMessage-ID: <mail-id>\r\n\r\nHello']) };
  const imap: ImapFactory = options => {
    seen.options = options;
    return { on() {}, connect: async () => {}, close: () => { seen.closed = true; }, list: async () => [],
      mailboxOpen: async (_folder: string, options: unknown) => { seen.readOnly = options; return { uidNext: 1_000_001 }; },
      search: async (query: unknown) => { seen.search = query; return ids; },
      fetch: async function* (range: string) { seen.fetch = range; for (const uid of range.split(',').map(Number)) yield { uid, envelope: { date: '2026-11-13T12:00:00Z', from: [{ address: 'sender@example.test' }], subject: 'Test' } }; },
      fetchOne: async () => ({ size: 100 }), download: async () => download,
    } as unknown as ReturnType<ImapFactory>;
  };
  return { provider: new ConnectionProviders(new ConnectionHttp(async () => { throw Error('Unexpected HTTP'); }), imap), seen, download: (value: unknown) => { download = value; } };
}

test('Yahoo searches a bounded UID window and paginates sparse mailboxes without losing older results', async () => {
  const { provider, seen } = yahooFixture(Array.from({ length: 50 }, (_, i) => 999_950 + i));
  const page = await provider.messages(account('yahoo'), { ...secret, password: true }, 'INBOX');
  assert.deepEqual(seen.search, { uid: '999001:1000000' }); assert.equal(String(seen.fetch).split(',').length, 25); assert.equal(page.items.length, 25); assert.equal(page.cursor, '999974');
  assert.deepEqual(seen.readOnly, { readOnly: true }); assert.equal(seen.closed, true); assert.equal(page.items[0].date, '2026-11-13T12:00:00.000Z');
  const sparse = yahooFixture(); assert.equal((await sparse.provider.messages(account('yahoo'), secret, 'INBOX')).cursor, '999000');
});

test('Yahoo MIME reads are bounded, missing streams fail safely, and sender headers become addresses', async () => {
  const { provider, download, seen } = yahooFixture();
  const message = await provider.message(account('yahoo'), secret, 'INBOX', '5'); assert.equal(message.from, 'sender@example.test'); assert.equal(message.text.trim(), 'Hello'); assert.equal(message.replyTo, '<mail-id>'); assert.equal(seen.closed, true);
  download({}); await assert.rejects(provider.message(account('yahoo'), secret, 'INBOX', '5'), /Yahoo Mail could not/);
  download({ content: Readable.from([Buffer.alloc(1024 * 1024 + 1)]) }); await assert.rejects(provider.message(account('yahoo'), secret, 'INBOX', '5'), /Yahoo Mail could not/);
  await assert.rejects(provider.message(account('yahoo'), secret, 'INBOX', '4294967296'), /Yahoo Mail could not/);
});

test('email recipients reject header injection and recipient expansion', () => {
  assert.deepEqual(emailRecipients('one@example.test, two@example.test'), ['one@example.test', 'two@example.test']);
  for (const value of ['one@example.test\r\nBcc: hidden@example.test', 'Name <one@example.test>', 'one@example.test;two@example.test']) assert.throws(() => emailRecipients(value), /email addresses/);
});

test('Yahoo SMTP stays on its TLS endpoint, disables file/URL access, and never echoes server credentials', async () => {
  type SmtpFactory = NonNullable<ConstructorParameters<typeof ConnectionProviders>[2]>;
  let options: Parameters<SmtpFactory>[0] | undefined; let closed = 0; let rejected = false; let message: unknown;
  const smtp: SmtpFactory = configuration => { options = configuration; return { sendMail: async (input: unknown) => { message = input; if (rejected) throw Error('fixture-credential reflected'); return { messageId: 'fixture-id', rejected: [] }; }, close: () => { closed++; } } as unknown as ReturnType<SmtpFactory>; };
  const provider = new ConnectionProviders(new ConnectionHttp(async () => { throw Error('Unexpected external HTTP'); }), undefined, smtp);
  assert.equal(await provider.send(account('yahoo'), { ...secret, password: true }, draft), 'fixture-id');
  assert.equal(options?.host, 'smtp.mail.yahoo.com'); assert.equal(options?.port, 465); assert.equal(options?.secure, true); assert.equal(options?.disableFileAccess, true); assert.equal(options?.disableUrlAccess, true); assert.equal(closed, 1);
  assert.equal((message as { to: string[] }).to[0], draft.destination);
  rejected = true; await assert.rejects(provider.send(account('yahoo'), secret, draft), error => { assert.doesNotMatch(String(error), /fixture-credential/); return true; }); assert.equal(closed, 2);
});
