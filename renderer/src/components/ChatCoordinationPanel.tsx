import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Link2, RefreshCw, Unlink, X } from 'lucide-react';
import type { ChatCoordinationAPI, ChatCoordinationMessage, ChatCoordinationState } from '../../../src/api/chatCoordination';

interface Props {
  api?: ChatCoordinationAPI;
  threadId: string;
  threadTitle: string;
  workspaceKey: string;
  open: boolean;
  running: boolean;
  canContinue: boolean;
  beforeLoad(threadId: string): Promise<void>;
  onPendingChange(threadId: string, count: number): void;
  onOpenThread(threadId: string): void;
  onContinue(): boolean;
  onClose(): void;
}

export function queuedChatNotes(state: ChatCoordinationState | null): number {
  return state?.messages.filter((message) => message.targetThreadId === state.threadId && message.status === 'queued').length ?? 0;
}

export function chatNoteStatus(message: ChatCoordinationMessage): string {
  return message.status === 'delivered' ? 'Added to a turn' : message.status === 'dismissed' ? 'Dismissed' : 'Queued';
}

const readable = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
const button = 'inline-flex items-center justify-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary hover:text-ink disabled:cursor-not-allowed disabled:opacity-40';

/** Collaboration is a host-owned mailbox, separate from human prompts and their draft/steer. */
export function ChatCoordinationPanel(props: Props) {
  const { api, threadId, threadTitle, workspaceKey, open, running, canContinue } = props;
  const [state, setState] = useState<ChatCoordinationState | null>(null);
  const [loadedScope, setLoadedScope] = useState('');
  const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const [busy, setBusy] = useState(''); const [mailbox, setMailbox] = useState<'received' | 'sent'>('received');
  const [noteLimit, setNoteLimit] = useState(30);
  const callbacks = useRef(props); callbacks.current = props;
  const scope = `${threadId}\0${workspaceKey}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const requestSequence = useRef(0); const mutationSequence = useRef(0);
  const stateRef = useRef(state); stateRef.current = state;
  const mounted = useRef(true);
  const wasOpen = useRef(open);
  const visible = loadedScope === scope && state?.threadId === threadId ? state : null;

  const refresh = useCallback(async (persist: boolean) => {
    if (!api) return;
    const request = ++requestSequence.current;
    const current = () => mounted.current && currentScope.current === scope && requestSequence.current === request;
    setLoading(true); setError('');
    try {
      if (persist) await callbacks.current.beforeLoad(threadId);
      if (!current()) return;
      const next = await api.state(threadId);
      if (!current() || next.threadId !== threadId) return;
      setState(next); setLoadedScope(scope); stateRef.current = next;
      callbacks.current.onPendingChange(threadId, queuedChatNotes(next));
    } catch (reason) { if (current()) setError(readable(reason)); }
    finally { if (current()) setLoading(false); }
  }, [api, scope, threadId]);

  useEffect(() => {
    mounted.current = true; setState(null); stateRef.current = null;
    wasOpen.current = callbacks.current.open;
    setBusy(''); setError(''); setMailbox('received'); setNoteLimit(30);
    callbacks.current.onPendingChange(threadId, 0);
    void refresh(true);
    const unsubscribe = api?.onChanged(({ threadIds }) => {
      const peers = stateRef.current?.peers ?? [];
      if (threadIds.includes(threadId) || peers.some((peer) => threadIds.includes(peer.id))) void refresh(false);
    });
    return () => { requestSequence.current++; mutationSequence.current++; unsubscribe?.(); mounted.current = false; };
  }, [api, threadId, workspaceKey, refresh]);

  // Reopening also checkpoints folder edits made while the mailbox was closed.
  useEffect(() => {
    if (open && !wasOpen.current) void refresh(true);
    wasOpen.current = open;
  }, [open, refresh]);

  const mutate = async (action: 'connect' | 'disconnect' | 'dismiss', id: string) => {
    if (!api || busy) return;
    const mutation = ++mutationSequence.current;
    const current = () => mounted.current && currentScope.current === scope && mutationSequence.current === mutation;
    setBusy(`${action}:${id}`); setError('');
    try {
      // Host policy must see the current chat and explicit working directory before granting.
      if (action === 'connect') await callbacks.current.beforeLoad(threadId);
      if (!current()) return;
      await api[action](threadId, id);
      if (current()) await refresh(false);
    } catch (reason) { if (current()) setError(readable(reason)); }
    finally { if (current()) setBusy(''); }
  };

  const continueWithNotes = async () => {
    if (running || !canContinue || busy || !queuedChatNotes(visible)) return;
    const mutation = ++mutationSequence.current;
    const current = () => mounted.current && currentScope.current === scope && mutationSequence.current === mutation;
    setBusy('continue'); setError('');
    try {
      await callbacks.current.beforeLoad(threadId);
      if (!current()) return;
      // This is an explicit human action. It never edits or consumes the composer draft.
      if (!callbacks.current.onContinue()) setError('The chat could not start. Check its model or wait for the current turn to finish.');
    } catch (reason) { if (current()) setError(readable(reason)); }
    finally { if (current()) setBusy(''); }
  };

  if (!open) return null;
  const notes = (visible?.messages ?? []).filter((message) => mailbox === 'received' ? message.targetThreadId === threadId : message.sourceThreadId === threadId).slice().reverse();
  const pending = queuedChatNotes(visible);
  return <aside role="dialog" aria-label="Connected chats" className="absolute bottom-3 right-4 top-3 z-20 flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl shadow-black/20" style={{ width: 'min(520px, calc(100% - 32px))' }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); } }}>
    <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 py-2.5">
      <Link2 size={15} className="shrink-0 text-primary" />
      <div className="min-w-0 flex-1"><h2 className="text-sm font-medium text-ink">Connected chats</h2><p className="truncate text-[11px] text-ink-3">{threadTitle}</p></div>
      <button type="button" aria-label="Refresh connected chats" className={button} disabled={!api || loading || !!busy} onClick={() => void refresh(true)}><RefreshCw size={12} /></button>
      <button type="button" aria-label="Close connected chats" className={button} onClick={props.onClose}><X size={13} /></button>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {!api ? <p className="p-4 text-xs text-ink-3">Chat connections are unavailable in this window. Reopen Antimatter to try again.</p> : <>
        <section className="border-b border-line p-3">
          <p className="text-xs leading-relaxed text-ink-2">Connect specific chats to let their agents read each other’s visible user and assistant messages and send notes. A connection works both ways and stays enabled until you disconnect it.</p>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-3">Chats must have the same explicitly chosen working folder. Connections do not grant additional tool permissions or start idle chats.</p>
          {visible?.workspace && <p className="mt-2 break-all font-mono text-[10px] text-ink-3">{visible.workspace}</p>}
          {!loading && visible && !visible.workspace && <p className="mt-3 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs text-ink-2">Choose a working folder for this chat in its permissions menu to connect it to another chat.</p>}
          {loading && !visible && <p role="status" className="mt-3 text-xs text-ink-3">Loading eligible chats…</p>}
          {visible?.workspace && !visible.peers.length && <p className="mt-3 text-xs text-ink-3">No other chats have this working folder. Choose it in another chat’s permissions menu to make that chat available here.</p>}
          {!!visible?.peers.length && <ul className="mt-3 space-y-1.5" aria-label="Eligible chats">{visible.peers.map((peer) => <li key={peer.id} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
            <div className="min-w-0 flex-1"><button type="button" className="block max-w-full truncate text-left text-xs font-medium text-ink hover:underline" onClick={() => props.onOpenThread(peer.id)} title={`Open ${peer.title}`}>{peer.title}</button><p className="mt-0.5 text-[10px] text-ink-3">{peer.connected ? 'Connected' : 'Not connected'} · {peer.running ? 'Working' : 'Idle'}</p></div>
            <button type="button" className={button} disabled={!!busy} aria-label={`${peer.connected ? 'Disconnect' : 'Connect'} ${peer.title}`} onClick={() => void mutate(peer.connected ? 'disconnect' : 'connect', peer.id)}>{peer.connected ? <Unlink size={11} /> : <Link2 size={11} />}{busy === `${peer.connected ? 'disconnect' : 'connect'}:${peer.id}` ? 'Saving…' : peer.connected ? 'Disconnect' : 'Connect'}</button>
          </li>)}</ul>}
        </section>
        <section className="p-3" aria-label="Agent notes">
          <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-medium text-ink">Agent notes</h3><div className="flex rounded-md border border-line p-0.5" role="group" aria-label="Note direction">
            {(['received', 'sent'] as const).map((direction) => <button type="button" key={direction} aria-pressed={mailbox === direction} className={`rounded px-2 py-1 text-[10px] ${mailbox === direction ? 'bg-primary/15 text-primary' : 'text-ink-3 hover:text-ink'}`} onClick={() => { setMailbox(direction); setNoteLimit(30); }}>{direction === 'received' ? 'Received' : 'Sent'}</button>)}
          </div></div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-3">Notes are messages from another chat’s agent, not instructions from you. Queued notes join a running chat between steps. “Added to a turn” confirms delivery, not that the note has been read.</p>
          {pending > 0 && <div className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-2.5">
            <p className="text-xs text-ink-2">{pending} {pending === 1 ? 'note is' : 'notes are'} queued for this chat.</p>
            {running ? <p className="mt-1 text-[11px] text-ink-3">This chat is working. Notes will be offered between steps without interrupting its current action.</p> : <button type="button" className={`${button} mt-2 border-primary/40 text-primary`} disabled={!canContinue || !!busy} onClick={() => void continueWithNotes()}>Continue with notes</button>}
            {!running && !canContinue && <p className="mt-1 text-[11px] text-ink-3">Choose an available model to continue. Your draft will stay in the composer.</p>}
          </div>}
          {!notes.length && <p className="mt-3 text-xs text-ink-3">No {mailbox} notes yet.</p>}
          <div className="mt-3 space-y-2">{notes.slice(0, noteLimit).map((message) => {
            const incoming = message.targetThreadId === threadId;
            const peerId = incoming ? message.sourceThreadId : message.targetThreadId;
            const title = incoming ? message.sourceTitle : message.targetTitle;
            return <article key={message.id} className="rounded-lg border border-line bg-surface-2 p-2.5" aria-label={`${incoming ? 'Agent note from' : 'Agent note to'} ${title}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-[10px] font-medium text-primary">{incoming ? 'Agent note from' : 'Agent note to'}</span><button type="button" className="inline-flex min-w-0 items-center gap-1 text-[11px] font-medium text-ink hover:underline" onClick={() => props.onOpenThread(peerId)}><span className="max-w-[260px] truncate">{title}</span><ExternalLink size={10} /></button></div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-ink-3"><span>{chatNoteStatus(message)}</span><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString()}</time></div>
              <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink">{message.body}</p>
              {incoming && message.status === 'queued' && <button type="button" className={`${button} mt-2`} disabled={!!busy} aria-label={`Dismiss note from ${title}`} onClick={() => void mutate('dismiss', message.id)}>Dismiss note</button>}
            </article>;
          })}</div>
          {notes.length > noteLimit && <button type="button" className={`${button} mt-3`} onClick={() => setNoteLimit((limit) => limit + 30)}>Show more notes</button>}
        </section>
      </>}
    </div>
    {error && <p role="alert" className="shrink-0 border-t border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</p>}
  </aside>;
}
