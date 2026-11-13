import { useEffect, useRef, useState } from 'react';
import { Mail, MessagesSquare, Plus, RefreshCw, Send, Settings, X } from 'lucide-react';
import type { ConnectionDraft, ConnectionFolder, ConnectionMessage, ConnectionPlugin, ConnectionReceipt, ConnectionState, ConnectionsAPI } from '../../../../src/api/connections';
import { connectionPlugin } from '../../../../src/api/connections';
import { ConnectionSettings, connectionButton as button, connectionInput as input, connectionLabels } from './ConnectionSettings';

import { connectionDraftStore as drafts, type DraftState } from './connectionDrafts';
export { connectionDraftBlockers } from './connectionDrafts';
const cleanError = (error: unknown): string => (error instanceof Error ? error.message : 'Request failed.').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
export function ConnectionsPage({ api, plugin, threadId, workspace, onClose }: { api: ConnectionsAPI; plugin: ConnectionPlugin; threadId: string | null; workspace: string | null; onClose(): void }) {
  const [state, setState] = useState<ConnectionState | null>(null); const [accountId, setAccountId] = useState('');
  const [folders, setFolders] = useState<ConnectionFolder[]>([]); const [folder, setFolder] = useState(''); const [folderCursor, setFolderCursor] = useState<string | undefined>();
  const [messages, setMessages] = useState<ConnectionMessage[]>([]); const [cursor, setCursor] = useState<string | undefined>(); const [message, setMessage] = useState<ConnectionMessage | null>(null);
  const [error, setError] = useState(drafts.error); const [busy, setBusy] = useState(false); const [settings, setSettings] = useState(false); const [access, setAccess] = useState({ read: false, send: false });
  const [accessReady, setAccessReady] = useState(false);
  const [compose, setCompose] = useState<DraftState | null>(null); const [review, setReview] = useState(false); const [remove, setRemove] = useState(false); const [notice, setNotice] = useState('');
  const generation = useRef(0); const readGeneration = useRef(0); const busyRef = useRef(false);
  const latestRevision = useRef(-1); const modal = useRef<HTMLDivElement>(null);
  const accounts = state?.accounts.filter((entry) => connectionPlugin(entry.provider) === plugin) ?? [];
  const account = accounts.find((entry) => entry.id === accountId);
  const change = (next: ConnectionState) => {
    if (next.revision < latestRevision.current) { return; }
    latestRevision.current = next.revision;
    setState(next); setAccountId((id) => next.accounts.some((entry) => entry.id === id && connectionPlugin(entry.provider) === plugin) ? id : next.accounts.find((entry) => connectionPlugin(entry.provider) === plugin)?.id ?? '');
  };
  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) { return; } busyRef.current = true; setBusy(true); setError('');
    const current = generation.current;
    try { await work(); } catch (cause) { if (current === generation.current) { setError(cleanError(cause)); } }
    finally { busyRef.current = false; setBusy(false); }
  };
  useEffect(() => {
    let active = true; const refresh = () => { void api.get().then((next) => { if (active) { change(next); } }).catch((cause) => { if (active) { setError(cleanError(cause)); } }); };
    refresh(); const off = api.onChanged(refresh); return () => { active = false; generation.current++; readGeneration.current++; off(); };
  }, [api, plugin]);
  useEffect(() => {
    const current = ++generation.current; readGeneration.current++; setFolders([]); setFolder(''); setMessages([]); setMessage(null); setCursor(undefined); setFolderCursor(undefined); setAccess({ read: false, send: false }); setCompose(drafts.get(accountId) ?? null); setReview(false); setRemove(false); setError(drafts.error);
    if (!accountId || !state?.plugins[plugin]) { return; }
    void api.folders(accountId).then((page) => { if (current === generation.current) { setFolders(page.items); setFolder(page.items[0]?.id ?? ''); setFolderCursor(page.cursor); } }).catch((cause) => { if (current === generation.current) { setError(cleanError(cause)); } });
  }, [accountId, state?.plugins[plugin]]);
  useEffect(() => {
    let active = true; setAccess({ read: false, send: false }); setAccessReady(false);
    if (accountId && threadId && workspace && state?.plugins[plugin]) { void api.projectAccess(accountId, threadId).then((next) => { if (active) { setAccess(next); setAccessReady(true); } }).catch((cause) => { if (active) { setError(`Could not read project access. ${cleanError(cause)}`); } }); }
    return () => { active = false; };
  }, [accountId, threadId, workspace, state?.revision]);
  useEffect(() => {
    const current = ++readGeneration.current; setMessages([]); setMessage(null); setCursor(undefined);
    if (!accountId || !folder || !state?.plugins[plugin]) { return; }
    void api.messages(accountId, folder).then((page) => { if (current === readGeneration.current) { setMessages(page.items); setCursor(page.cursor); } }).catch((cause) => { if (current === readGeneration.current) { setError(cleanError(cause)); } });
  }, [accountId, folder, state?.plugins[plugin]]);
  useEffect(() => {
    if (!review && !remove) { return; }
    const prior = document.activeElement as HTMLElement | null;
    modal.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); setReview(false); setRemove(false); }
      if (event.key !== 'Tab') { return; }
      const elements = [...modal.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []];
      if (!elements.length) { event.preventDefault(); return; }
      const index = elements.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault(); elements[(index + (event.shiftKey ? elements.length - 1 : 1)) % elements.length].focus();
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); prior?.focus(); };
  }, [review, remove]);
  const startDraft = (reply?: ConnectionMessage) => {
    if (!account || drafts.has(account.id)) { setCompose(drafts.get(accountId) ?? null); return; }
    const replyAddress = reply?.from.match(/<([^<>]+)>/)?.[1] ?? reply?.from ?? '';
    const next: DraftState = { uncertain: false, draft: { account: account.id, destination: plugin === 'email' ? replyAddress.slice(0, 2048) : folder, subject: reply?.subject ? `Re: ${reply.subject.replace(/^Re:\s*/i, '')}`.slice(0, 998) : '', text: '', requestId: crypto.randomUUID(), ...(reply?.replyTo && account.provider !== 'teams' ? { replyTo: reply.replyTo } : {}) } };
    try { drafts.set(account.id, next); setCompose(next); setNotice(''); if (drafts.error) { setError(drafts.error); } }
    catch (cause) { setError(cleanError(cause)); }
  };
  const updateDraft = (patch: Partial<ConnectionDraft>) => {
    if (!compose || compose.uncertain || compose.submitted || busy || review) { return; }
    const next = { ...compose, draft: { ...compose.draft, ...patch } }; drafts.set(accountId, next); setCompose(next); setError(drafts.error);
  };
  const discard = () => { drafts.delete(accountId); setCompose(null); setReview(false); if (drafts.error) { setError(drafts.error); } };
  const applyReceipt = (saved: DraftState, receipt: ConnectionReceipt | null, current: number) => {
    if (receipt && receipt.requestId !== saved.draft.requestId) { throw new Error('Unexpected delivery receipt. Check the provider before continuing.'); }
    if (receipt?.state === 'sent') {
      drafts.delete(saved.draft.account);
      if (current === generation.current) { setCompose(null); setNotice('Message sent.'); }
    } else {
      const next = { ...saved, submitted: !!receipt, uncertain: !!receipt };
      drafts.set(saved.draft.account, next);
      if (current === generation.current) { setCompose(next); if (!receipt) { setNotice('No send was recorded. Review the draft before sending.'); } }
    }
    if (current === generation.current && drafts.error) { setError(drafts.error); }
  };
  const refresh = () => void run(async () => {
    const current = readGeneration.current; change(await api.get());
    if (account && folder) { const next = await api.messages(accountId, folder); if (current === readGeneration.current) { setMessages(next.items); setCursor(next.cursor); } }
  });
  return <div className="absolute inset-0 flex flex-col overflow-hidden bg-surface text-ink">
    <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-3">
      {plugin === 'email' ? <Mail size={16} /> : <MessagesSquare size={16} />}<h1 className="text-sm font-semibold">{plugin === 'email' ? 'Email' : 'Comms'}</h1>
      <select aria-label="Connected account" className={`${input} max-w-64`} value={accountId} disabled={busy} onChange={(event) => setAccountId(event.target.value)}><option value="">Choose account</option>{accounts.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {connectionLabels[entry.provider]}</option>)}</select>
      <button className={button} disabled={busy} onClick={() => setSettings(!settings)}><Settings size={13} className="inline" /> Accounts</button>
      <button className={button} disabled={busy || !account || !state?.plugins[plugin]} onClick={() => startDraft()}><Plus size={13} className="inline" /> Compose</button>
      <button className={`${button} ml-auto`} aria-label="Refresh connections" disabled={busy} onClick={refresh}><RefreshCw size={13} /></button><button className={button} onClick={onClose} aria-label="Close connections"><X size={13} /></button>
    </header>
    {(error || drafts.error || state?.error) && <p role="alert" className="shrink-0 border-b border-line px-4 py-2 text-xs text-danger">{error || drafts.error || state?.error}</p>}
    {drafts.corrupt && <div className="flex flex-wrap gap-2 px-4 py-2">
      <button className={button} onClick={() => { try { const url = URL.createObjectURL(new Blob([drafts.download()], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'antimatter-drafts-recovery.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (cause) { setError(cleanError(cause)); } }}>Download saved drafts</button>
      <button className={button} onClick={() => { if (window.confirm('Reset unreadable draft storage? Download a recovery copy first.')) { try { drafts.reset(); setCompose(null); setError(''); } catch (cause) { setError(cleanError(cause)); } } }}>Reset draft storage</button>
    </div>}
    {notice && <p role="status" className="px-4 py-2 text-xs text-ink-2">{notice}</p>}
    <div className="min-h-0 flex-1 overflow-y-auto">
      {state && <div className="border-b border-line px-4 py-3">
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={state.plugins[plugin]} disabled={busy} onChange={(event) => { const enabled = event.target.checked; void run(async () => change(await api.enable(plugin, enabled))); }} />Enable {plugin === 'comms' ? 'Comms' : 'Email'} plugin</label>
        {account && <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-2"><span>Agent access {workspace ? 'for this project' : '· choose a project to configure'}</span>
          <label className="flex items-center gap-1"><input type="checkbox" disabled={busy || !accessReady || !workspace || !threadId || !state.plugins[plugin]} checked={access.read} onChange={(event) => { const checked = event.target.checked; void run(async () => change(await api.access(accountId, threadId!, checked, access.send))); }} />Read</label>
          <label className="flex items-center gap-1"><input type="checkbox" disabled={busy || !accessReady || !workspace || !threadId || !state.plugins[plugin]} checked={access.send} onChange={(event) => { const checked = event.target.checked; void run(async () => change(await api.access(accountId, threadId!, access.read, checked))); }} />Send with approval</label>
          <button className={`${button} ml-auto`} onClick={() => setRemove(true)} disabled={busy}>Disconnect</button></div>}
      </div>}
      {state && (settings || !accounts.length) && <div className="mx-auto max-w-3xl p-4"><ConnectionSettings key={plugin} api={api} plugin={plugin} state={state} onChange={change} /></div>}
      {account && state?.plugins[plugin] && <div className="grid min-h-[22rem] grid-cols-1 divide-y divide-line lg:grid-cols-[12rem_18rem_1fr] lg:divide-x lg:divide-y-0">
        <nav aria-label={plugin === 'email' ? 'Mail folders' : 'Channels'} className="space-y-1 p-2"><h2 className="px-2 py-1 text-xs text-ink-3">{plugin === 'email' ? 'Folders' : 'Chats and channels'}</h2>
          {folders.map((entry) => <button key={entry.id} className={`block w-full truncate rounded px-2 py-2 text-left text-xs ${folder === entry.id ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:bg-surface-2'}`} title={entry.name} onClick={() => setFolder(entry.id)}>{entry.name}</button>)}
          {folderCursor && <button className={button} disabled={busy} onClick={() => void run(async () => { const current = generation.current; const page = await api.folders(accountId, folderCursor); if (current === generation.current) { setFolders((previous) => [...previous, ...page.items.filter((item) => !previous.some((existing) => existing.id === item.id))]); setFolderCursor(page.cursor); } })}>More folders</button>}
        </nav>
        <div className="max-h-[65vh] space-y-1 overflow-y-auto p-2" aria-label="Messages">
          {messages.map((entry) => <button key={entry.id} className={`block w-full rounded px-3 py-2 text-left ${message?.id === entry.id ? 'bg-surface-3' : 'hover:bg-surface-2'}`} onClick={() => void run(async () => { const current = readGeneration.current; const full = await api.message(accountId, folder, entry.id); if (current === readGeneration.current) { setMessage(full); } })}><p className="truncate text-xs font-medium">{entry.subject || entry.from || 'Message'}</p><p className="truncate text-xs text-ink-3">{entry.subject ? entry.from : entry.text}</p><p className="mt-1 truncate text-[10px] text-ink-3">{entry.date}</p></button>)}
          {!messages.length && <p className="p-3 text-xs text-ink-3">No messages loaded.</p>}
          {cursor && <button className={button} disabled={busy} onClick={() => void run(async () => { const current = readGeneration.current; const page = await api.messages(accountId, folder, cursor); if (current === readGeneration.current) { setMessages((previous) => [...previous, ...page.items.filter((item) => !previous.some((existing) => existing.id === item.id))]); setCursor(page.cursor); } })}>Older messages</button>}
        </div>
        <article className="min-w-0 p-4">{message ? <><p className="break-words text-xs text-ink-3">{message.from} · {message.date}</p>{message.subject && <h2 className="my-3 break-words text-sm font-semibold">{message.subject}</h2>}<pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-6">{message.text || '(No text body)'}</pre>{account.provider !== 'teams' && <button className={`${button} mt-4`} disabled={busy} onClick={() => startDraft(message)}>Reply</button>}</> : <p className="text-xs text-ink-3">Select a message. Remote images and active HTML are not loaded.</p>}</article>
      </div>}
    </div>
    {compose && compose.draft.account === accountId && <section aria-label="Message draft" className="max-h-[48vh] shrink-0 space-y-2 overflow-y-auto border-t border-line bg-surface-2 p-4">
      <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-medium">From {account?.label}</span><button className={`${button} ml-auto`} disabled={busy} onClick={() => { if (!compose.draft.text.trim() || window.confirm('Discard this message draft?')) { discard(); } }}>Discard</button></div>
      {(compose.uncertain || compose.submitted) && <><p role="alert" className="text-xs text-warning">Delivery is unconfirmed. Check the conversation or Sent folder before creating a new message. This draft will not resend.</p><button className={button} disabled={busy} onClick={() => void run(async () => { const current = generation.current; applyReceipt(compose, await api.receipt(compose.draft.requestId), current); })}>Check delivery</button></>}
      <label className="flex items-center gap-2 text-xs">To<input aria-label="Message destination" maxLength={2048} className={`${input} flex-1`} value={compose.draft.destination} readOnly={compose.uncertain || compose.submitted || busy || review} onChange={(event) => updateDraft({ destination: event.target.value })} /></label>
      {plugin === 'email' && <label className="flex items-center gap-2 text-xs">Subject<input aria-label="Message subject" maxLength={998} className={`${input} flex-1`} value={compose.draft.subject} readOnly={compose.uncertain || compose.submitted || busy || review} onChange={(event) => updateDraft({ subject: event.target.value })} /></label>}
      <textarea aria-label="Message text" className={`${input} w-full resize-y`} rows={4} maxLength={account?.provider === 'discord' ? 2000 : account?.provider === 'slack' ? 40000 : 65536} value={compose.draft.text} readOnly={compose.uncertain || compose.submitted || busy || review} onChange={(event) => updateDraft({ text: event.target.value })} />
      <button className={button} disabled={busy || compose.uncertain || compose.submitted || !!drafts.error || !state?.plugins[plugin] || !compose.draft.destination.trim() || !compose.draft.text.trim()} onClick={() => setReview(true)}><Send size={12} className="mr-1 inline" />Review send</button>
    </section>}
    {(review || remove) && <div ref={modal} role="dialog" aria-modal="true" aria-label={remove ? 'Disconnect account' : 'Review message'} className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-4"><div className="max-h-full w-full max-w-xl space-y-3 overflow-y-auto rounded border border-line bg-surface p-4">
      {remove ? <><h2 className="text-sm font-semibold">Disconnect {account?.label}?</h2><p className="text-xs text-ink-2">This removes locally stored credentials and agent grants. Revoke the app at the provider to remove its consent there.</p></> : <><h2 className="text-sm font-semibold">Send as {account?.label}?</h2><p className="break-words text-xs">To: {compose?.draft.destination}</p>{compose?.draft.subject && <p className="break-words text-xs">Subject: {compose.draft.subject}</p>}<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">{compose?.draft.text}</pre></>}
      <div className="flex justify-end gap-2"><button className={button} disabled={busy} onClick={() => { setReview(false); setRemove(false); }}>Cancel</button><button className={button} disabled={busy} onClick={() => void run(async () => {
        if (remove) { change(await api.disconnect(accountId)); drafts.delete(accountId); setCompose(null); setRemove(false); return; }
        if (!compose || compose.submitted || compose.uncertain || compose.draft.account !== accountId || !state?.plugins[plugin] || drafts.error) { return; }
        const current = generation.current; const saved = { ...compose, submitted: true };
        setCompose(saved);
        if (!drafts.set(accountId, saved)) { setReview(false); throw new Error(drafts.error); }
        try { applyReceipt(saved, await api.send(saved.draft), current); }
        catch (cause) { drafts.set(saved.draft.account, { ...saved, uncertain: true }); if (current === generation.current) { setCompose({ ...saved, uncertain: true }); } throw cause; }
        finally { if (current === generation.current) { setReview(false); } }
      })}>{busy ? 'Working…' : remove ? 'Disconnect' : 'Send message'}</button></div>
    </div></div>}
  </div>;
}
