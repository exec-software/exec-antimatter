import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import addressparser from 'nodemailer/lib/addressparser';
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { simpleParser } from 'mailparser';
import type { ConnectionDraft, ConnectionFolder, ConnectionMessage, ConnectionPage } from '../../api/connections';
import type { AccountRecord, ConnectionSecret } from './store';
import { ConnectionHttp, plainHtml, providerPage, textValue, type JsonObject } from './http';

const part = (value: string): string => { if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f]/.test(value)) { throw new Error('Invalid message or channel identifier.'); } return encodeURIComponent(value); };
const cursorValue = (value: string | undefined): void => { if (value !== undefined && (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f]/.test(value))) { throw new Error('Invalid page cursor.'); } };
const list = (value: unknown): JsonObject[] => Array.isArray(value) ? value.slice(0, 100).filter((entry) => entry && typeof entry === 'object') : [];
const header = (message: JsonObject, name: string): string => textValue(list(message.payload?.headers).find((entry) => String(entry.name).toLowerCase() === name.toLowerCase())?.value);
const graphMessage = (message: JsonObject): ConnectionMessage => ({ id: textValue(message.id, 1024), from: textValue(message.from?.emailAddress?.address ?? message.from?.user?.displayName), subject: textValue(message.subject),
  text: message.body?.contentType?.toLowerCase() === 'html' ? plainHtml(message.body?.content) : textValue(message.body?.content ?? message.bodyPreview), date: textValue(message.receivedDateTime ?? message.createdDateTime), replyTo: textValue(message.id, 1024) });
const mailFrom = (value: unknown): string => addressparser(textValue(value, 4096), { flatten: true }).map(item => item.address ?? '').filter(Boolean).slice(0, 20).join(', ');
const dateValue = (value: unknown): string => { const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toISOString() : ''; };
const slackMessage = (message: JsonObject): ConnectionMessage => ({ id: textValue(message.ts, 100), from: textValue(message.user ?? message.bot_id), subject: '', text: textValue(message.text), date: dateValue(Number(message.ts) * 1000), replyTo: textValue(message.thread_ts ?? message.ts, 100) });
const discordMessage = (message: JsonObject): ConnectionMessage => ({ id: textValue(message.id, 100), from: textValue(message.author?.global_name ?? message.author?.username), subject: '', text: textValue(message.content), date: textValue(message.timestamp), replyTo: textValue(message.id, 100) });

export class ConnectionProviders {
  constructor(readonly http = new ConnectionHttp(), private imap: (options: ImapFlowOptions) => Pick<ImapFlow, 'on' | 'connect' | 'close' | 'list' | 'mailboxOpen' | 'fetchOne' | 'download' | 'search' | 'fetch'> = options => new ImapFlow(options),
    private smtp: (options: SMTPTransport.Options) => Pick<Transporter<SMTPTransport.SentMessageInfo>, 'sendMail' | 'close'> = options => nodemailer.createTransport(options)) {}
  private request(account: AccountRecord, secret: ConnectionSecret, path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<JsonObject> {
    const base = account.provider === 'discord' ? 'https://discord.com/api/v10/' : account.provider === 'slack' ? 'https://slack.com/api/' : account.provider === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/me/' : 'https://graph.microsoft.com/v1.0/';
    const url = path.startsWith('https://') ? path : base + path;
    if (!url.startsWith(base)) { throw new Error('Invalid provider path.'); }
    return this.http.request(url, { method, headers: { Authorization: `${account.provider === 'discord' ? 'Bot' : 'Bearer'} ${secret.accessToken}`, 'Content-Type': 'application/json', ...(account.provider === 'outlook' ? { Prefer: 'outlook.body-content-type="text"' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async folders(account: AccountRecord, secret: ConnectionSecret, cursor?: string): Promise<ConnectionPage<ConnectionFolder>> {
    cursorValue(cursor);
    if (account.provider === 'yahoo') { return this.yahoo(account, secret, async (client) => ({ items: (await client.list()).slice(0, 100).filter((folder) => !folder.flags.has('\\Noselect')).map((folder) => ({ id: folder.path, name: folder.name })) })); }
    if (account.provider === 'gmail') { const result = await this.request(account, secret, 'labels'); return { items: list(result.labels).map((folder) => ({ id: textValue(folder.id), name: textValue(folder.name) })) }; }
    if (account.provider === 'discord') { const result = await this.request(account, secret, `guilds/${part(account.guild)}/channels`); return { items: list(result).filter((channel) => [0, 5, 11, 12].includes(channel.type)).map((channel) => ({ id: textValue(channel.id), name: textValue(channel.name) })) }; }
    if (account.provider === 'slack') {
      const query = new URLSearchParams({ limit: '100', exclude_archived: 'true', types: 'public_channel,private_channel,im,mpim', ...(cursor ? { cursor: cursor.slice(0, 1024) } : {}) });
      const result = await this.request(account, secret, `conversations.list?${query}`);
      return { items: list(result.channels).map((channel) => ({ id: textValue(channel.id), name: textValue(channel.name ?? channel.user ?? channel.id) })), cursor: textValue(result.response_metadata?.next_cursor, 1024) || undefined };
    }
    const base = `https://graph.microsoft.com/v1.0/me/${account.provider === 'teams' ? 'chats?$top=50' : 'mailFolders?$top=50'}`;
    const result = await this.request(account, secret, providerPage(base, cursor));
    return { items: list(result.value).map((folder) => ({ id: textValue(folder.id), name: textValue(folder.displayName ?? folder.topic ?? `${folder.chatType || 'Chat'} · ${folder.id}`) })), cursor: typeof result['@odata.nextLink'] === 'string' ? providerPage(base, result['@odata.nextLink']) : undefined };
  }
  async messages(account: AccountRecord, secret: ConnectionSecret, folder: string, cursor?: string): Promise<ConnectionPage<ConnectionMessage>> {
    part(folder); cursorValue(cursor);
    if (account.provider === 'yahoo') { return this.yahooMessages(account, secret, folder, cursor); }
    if (account.provider === 'gmail') {
      const query = new URLSearchParams({ labelIds: folder, maxResults: '25', ...(cursor ? { pageToken: cursor.slice(0, 1024) } : {}) });
      const result = await this.request(account, secret, `messages?${query}`); const items: ConnectionMessage[] = [];
      // Sequential metadata reads avoid bursts against a user's quota.
      for (const message of list(result.messages).slice(0, 25)) { const metadata = await this.request(account, secret, `messages/${part(message.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`); items.push({ id: metadata.id, from: mailFrom(header(metadata, 'from')), subject: header(metadata, 'subject'), text: textValue(metadata.snippet), date: header(metadata, 'date') }); }
      return { items, cursor: textValue(result.nextPageToken, 1024) || undefined };
    }
    if (account.provider === 'discord') { const result = await this.request(account, secret, `channels/${part(folder)}/messages?limit=50${cursor ? `&before=${part(cursor)}` : ''}`); const items = list(result).map(discordMessage); return { items, cursor: items.length === 50 ? items[items.length - 1].id : undefined }; }
    if (account.provider === 'slack') {
      const query = new URLSearchParams({ channel: folder, limit: '15', ...(cursor ? { cursor: cursor.slice(0, 1024) } : {}) });
      const result = await this.request(account, secret, `conversations.history?${query}`);
      return { items: list(result.messages).map(slackMessage), cursor: textValue(result.response_metadata?.next_cursor, 1024) || undefined };
    }
    const base = account.provider === 'teams' ? `https://graph.microsoft.com/v1.0/me/chats/${part(folder)}/messages?$top=50` : `https://graph.microsoft.com/v1.0/me/mailFolders/${part(folder)}/messages?$top=25&$select=id,from,subject,bodyPreview,receivedDateTime`;
    const result = await this.request(account, secret, providerPage(base, cursor));
    return { items: list(result.value).map(graphMessage), cursor: typeof result['@odata.nextLink'] === 'string' ? providerPage(base, result['@odata.nextLink']) : undefined };
  }
  async message(account: AccountRecord, secret: ConnectionSecret, folder: string, id: string): Promise<ConnectionMessage> {
    part(folder); part(id);
    if (account.provider === 'yahoo') {
      return this.yahoo(account, secret, async (client) => {
        part(folder); await client.mailboxOpen(folder, { readOnly: true }); const metadata = await client.fetchOne(this.uid(id), { size: true, envelope: true }, { uid: true });
        if (!metadata) { throw new Error('Message not found.'); }
        if ((metadata.size ?? 0) > 1024 * 1024) { throw new Error('This message exceeds the 1 MiB text reader limit. Open it in your mail provider.'); }
        const download = await client.download(this.uid(id), undefined, { uid: true, maxBytes: 1024 * 1024 });
        const content = download.content; if (!content) { throw new Error('Message not found.'); }
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of content) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length; if (bytes > 1024 * 1024) { content.destroy(); throw new Error('Message is too large.'); } chunks.push(buffer); }
        const parsed = await simpleParser(Buffer.concat(chunks), { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
        return { id, from: parsed.from?.value.map(address => address.address).filter(Boolean).join(', ') ?? '', subject: parsed.subject ?? '', text: (parsed.text || plainHtml(parsed.html)).slice(0, 65536), date: dateValue(parsed.date), replyTo: parsed.messageId };
      });
    }
    if (account.provider === 'gmail') {
      const result = await this.request(account, secret, `messages/${part(id)}?format=full`);
      const texts: string[] = []; const html: string[] = []; let parts = 0;
      const walk = (payload: JsonObject, depth: number) => { if (++parts > 100 || depth > 10 || !payload) { return; }
        if (typeof payload.body?.data === 'string' && !payload.filename) { const content = Buffer.from(payload.body.data.slice(0, 131072), 'base64url').toString('utf8'); if (payload.mimeType === 'text/plain') { texts.push(content); } else if (payload.mimeType === 'text/html') { html.push(plainHtml(content)); } }
        for (const child of list(payload.parts)) { walk(child, depth + 1); } };
      walk(result.payload, 0);
      return { id: result.id, from: mailFrom(header(result, 'From')), subject: header(result, 'Subject'), date: header(result, 'Date'), text: (texts.length ? texts : html).join('\n').slice(0, 65536), replyTo: textValue(result.id, 1024) };
    }
    if (account.provider === 'discord') { return discordMessage(await this.request(account, secret, `channels/${part(folder)}/messages/${part(id)}`)); }
    if (account.provider === 'slack') { const query = new URLSearchParams({ channel: folder, ts: id, limit: '15' }); const result = await this.request(account, secret, `conversations.replies?${query}`); return { id, from: 'Thread', subject: '', text: (list(result.messages).map((message) => `${textValue(message.user)}: ${textValue(message.text)}`).join('\n\n').slice(0, 65000) + (result.has_more || result.response_metadata?.next_cursor ? '\n\n[More replies are available in Slack.]' : '')), date: '', replyTo: id }; }
    return graphMessage(await this.request(account, secret, account.provider === 'teams' ? `chats/${part(folder)}/messages/${part(id)}` : `me/messages/${part(id)}`));
  }
  async send(account: AccountRecord, secret: ConnectionSecret, draft: ConnectionDraft): Promise<string | undefined> {
    if (account.provider === 'discord') { const result = await this.request(account, secret, `channels/${part(draft.destination)}/messages`, { content: draft.text, nonce: draft.requestId.replace(/-/g, '').slice(0, 25), enforce_nonce: true, allowed_mentions: { parse: [] }, ...(draft.replyTo ? { message_reference: { message_id: draft.replyTo } } : {}) }); return textValue(result.id); }
    if (account.provider === 'slack') { const result = await this.request(account, secret, 'chat.postMessage', { channel: draft.destination, text: draft.text, client_msg_id: draft.requestId, unfurl_links: false, unfurl_media: false, parse: 'none', link_names: false, ...(draft.replyTo ? { thread_ts: draft.replyTo } : {}) }); return textValue(result.ts); }
    if (account.provider === 'teams') { if (draft.replyTo) { throw new Error('Threaded replies are not supported for Teams chats. Send a new chat message.'); } const result = await this.request(account, secret, `chats/${part(draft.destination)}/messages`, { body: { contentType: 'text', content: draft.text } }); return textValue(result.id); }
    const to = emailRecipients(draft.destination);
    if (account.provider === 'outlook') {
      const message = { subject: draft.subject, body: { contentType: 'Text', content: draft.text }, toRecipients: to.map((address) => ({ emailAddress: { address } })) };
      if (draft.replyTo) { await this.request(account, secret, `me/messages/${part(draft.replyTo)}/reply`, { message }); }
      else { await this.request(account, secret, 'me/sendMail', { message, saveToSentItems: true }); }
      return undefined;
    }
    let replyTo = draft.replyTo; let threadId: string | undefined; let references: string[] = [];
    if (account.provider === 'gmail' && draft.replyTo) {
      const original = await this.request(account, secret, `messages/${part(draft.replyTo)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`);
      replyTo = header(original, 'Message-ID'); threadId = textValue(original.threadId, 1024);
      references = (header(original, 'References').match(/<[^<>\r\n]{1,998}>/g) ?? []).slice(-20);
      if (!replyTo || !threadId) { throw new Error('The original message is unavailable for a threaded reply.'); }
    }
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows', disableFileAccess: true, disableUrlAccess: true });
    const message = { from: account.address, to, subject: draft.subject, text: draft.text, messageId: `<${draft.requestId}@antimatter.local>`, ...(replyTo ? { inReplyTo: replyTo, references: [...references, replyTo] } : {}) };
    if (account.provider === 'gmail') { const built = await transport.sendMail(message); const result = await this.request(account, secret, 'messages/send', { raw: (built.message as Buffer).toString('base64url'), ...(threadId ? { threadId } : {}) }); return textValue(result.id); }
    const smtp = this.smtp({ host: 'smtp.mail.yahoo.com', port: 465, secure: true, auth: secret.password ? { user: account.address, pass: secret.accessToken } : { type: 'OAuth2', user: account.address, accessToken: secret.accessToken }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000, logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true });
    try { const result = await smtp.sendMail(message); if (result.rejected?.length) { throw new Error('The provider rejected one or more recipients.'); } return result.messageId; }
    catch { throw new Error('Yahoo Mail could not confirm the send. Check the Sent folder before retrying.'); }
    finally { smtp.close(); }
  }
  private uid(value: string): number { if (!/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 0xffffffff) { throw new Error('Invalid mail identifier.'); } return Number(value); }
  private async yahoo<T>(account: AccountRecord, secret: ConnectionSecret, work: (client: ReturnType<ConnectionProviders['imap']>) => Promise<T>): Promise<T> {
    const client = this.imap({ host: 'imap.mail.yahoo.com', port: 993, secure: true, auth: { user: account.address, ...(secret.password ? { pass: secret.accessToken } : { accessToken: secret.accessToken }) }, logger: false, disableAutoIdle: true, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
    client.on('error', () => {});
    try { await client.connect(); return await work(client); }
    catch { throw new Error('Yahoo Mail could not complete the request. Check the app password or OAuth permissions.'); }
    finally { client.close(); }
  }
  private async yahooMessages(account: AccountRecord, secret: ConnectionSecret, folder: string, cursor?: string): Promise<ConnectionPage<ConnectionMessage>> {
    part(folder);
    return this.yahoo(account, secret, async (client) => {
      const mailbox = await client.mailboxOpen(folder, { readOnly: true });
      const end = cursor ? Math.min(this.uid(cursor), mailbox.uidNext - 1) : mailbox.uidNext - 1;
      if (end < 1) { return { items: [] }; }
      const start = Math.max(1, end - 999);
      const ids = await client.search({ uid: `${start}:${end}` }, { uid: true });
      const found = Array.isArray(ids) ? ids.filter(id => Number.isInteger(id) && id >= start && id <= end).slice(0, 1000).sort((a, b) => a - b) : [];
      const selected = found.slice(-25);
      const next = found.length > 25 ? selected[0] - 1 : start - 1;
      if (!selected.length) { return { items: [], ...(next > 0 ? { cursor: String(next) } : {}) }; }
      const items: ConnectionMessage[] = [];
      for await (const message of client.fetch(selected.join(','), { envelope: true }, { uid: true })) {
        items.push({ id: String(message.uid), from: message.envelope?.from?.map((sender) => sender.address || sender.name || '').join(', ') ?? '', subject: message.envelope?.subject ?? '', text: '', date: dateValue(message.envelope?.date), replyTo: message.envelope?.messageId });
      }
      return { items: items.sort((a, b) => Number(b.id) - Number(a.id)), cursor: next > 0 ? String(next) : undefined };
    });
  }
}
export function emailRecipients(value: string): string[] {
  const recipients = value.split(',').map((entry) => entry.trim());
  if (!recipients.length || recipients.length > 20 || recipients.some((address) => !/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/.test(address) || address.length > 320)) { throw new Error('Enter up to 20 email addresses separated by commas.'); }
  return recipients;
}
