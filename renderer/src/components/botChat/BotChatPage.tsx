import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Archive, AtSign, Bot, ExternalLink, Hash, Pause, Pencil, Play, Plus, RefreshCw, Reply, Send, Settings, Shield, UserRound, Users, X } from 'lucide-react';
import { BOT_CHAT_LIMITS as limits, type BotChatAPI, type BotChatChannel, type BotChatMessage, type BotChatPage as ChannelPage } from '../../../../src/api/botChat';
import { botChatError, useBotChatState } from '../../lib/useBotChat';
import { ConfirmDialog } from '../ConfirmDialog';

const button = 'inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:cursor-default disabled:opacity-50';
const field = 'rounded-md border border-line bg-surface-2 px-2.5 py-2 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';
const channelNameValid = (name: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
// An outside agent has a name but no thread and no title, so the two-way test
// this replaced read an undefined title for it.
const authorName = (message: BotChatMessage) =>
  message.sender.kind === 'agent' ? message.sender.title : message.sender.name;
export interface PublicBotChatDraft { body: string; clientMessageId: string; replyTo?: string; mentionThreadIds: string[] }
type DraftState = [Record<string, PublicBotChatDraft>, Dispatch<SetStateAction<Record<string, PublicBotChatDraft>>>];

function ChannelForm({ channel, pending, onSave, onCancel }: { channel?: BotChatChannel; pending: boolean; onSave(name: string, description: string): void; onCancel(): void }) {
  const [name, setName] = useState(channel?.name ?? ''); const [description, setDescription] = useState(channel?.description ?? '');
  return <form aria-label={channel ? 'Edit public channel' : 'Create public channel'} className="rounded-lg border border-line bg-surface-2 p-3" onSubmit={(event) => { event.preventDefault(); if (channelNameValid(name)) onSave(name, description); }}>
    <label className="block text-[11px] text-ink-2">Channel name<input autoFocus aria-label="Public channel name" value={name} onChange={(event) => setName(event.target.value)} maxLength={limits.nameLength} placeholder="engineering" className={`${field} mt-1 w-full`} disabled={pending} /></label>
    <p className="mt-1 text-[10px] text-ink-3">Lowercase letters, numbers, hyphens and underscores.</p>
    <label className="mt-2 block text-[11px] text-ink-2">Description<textarea aria-label="Public channel description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={limits.descriptionLength} rows={2} className={`${field} mt-1 w-full resize-y`} disabled={pending} /></label>
    <div className="mt-2 flex gap-2"><button type="submit" disabled={pending || !channelNameValid(name)} className={`${button} border-primary/40 text-primary`}>{pending ? 'Saving…' : channel ? 'Save channel' : 'Create channel'}</button><button type="button" onClick={onCancel} className={button} disabled={pending}>Cancel</button></div>
  </form>;
}

function PublicPost({ message, reply, mentions, canReply, canModerate, onReply, onRedact, onOpenThread }: {
  message: BotChatMessage; reply?: BotChatMessage; mentions: string[]; canReply: boolean; canModerate: boolean;
  onReply(): void; onRedact(): void; onOpenThread(id: string): void;
}) {
  const agent = message.sender.kind === 'agent' ? message.sender : null;
  // An outside agent is labelled as such: its name is self-declared and nothing
  // here verifies it, so a reader should not mistake it for a local agent whose
  // thread they could open, nor for the person at the keyboard.
  const outside = message.sender.kind === 'external';
  return <article id={`bot-post-${message.id}`} aria-label={`Public post by ${authorName(message)}`} className="rounded-xl border border-line bg-surface-2 p-3">
    <div className="flex items-start gap-2.5">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">{agent ? <Bot size={15} /> : <UserRound size={14} />}</div>
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {agent ? <button type="button" className="inline-flex max-w-full items-center gap-1 text-xs font-medium text-ink hover:underline" aria-label={`Open source chat ${agent.title}`} onClick={() => onOpenThread(agent.threadId)}><span className="truncate">{agent.title}</span><ExternalLink size={10} className="shrink-0" /></button> : <span className="text-xs font-medium text-ink">{authorName(message)}{outside ? <span className="ml-1 text-[10px] font-normal text-ink-faint">outside</span> : null}</span>}
        <span className="text-[10px] text-primary">{agent ? 'Agent' : 'Human'}</span>
        <time className="ml-auto text-[10px] text-ink-3" dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString()}</time>
      </div><p className="mt-0.5 break-words text-[10px] text-ink-3">{agent ? `Project: ${agent.workspace ?? 'No project label'}` : 'Posted from this desktop'}</p></div>
    </div>
    {message.replyTo && <blockquote className="mt-2 border-l-2 border-primary/40 pl-2 text-[11px] text-ink-3">{reply ? <><span className="font-medium">Reply to {authorName(reply)}</span><p className="mt-0.5 whitespace-pre-wrap break-words">{reply.redactedAt ? 'Post redacted' : `${reply.body.slice(0, 220)}${reply.body.length > 220 ? '…' : ''}`}</p></> : 'Reply to an earlier post. Use Older posts to view its context.'}</blockquote>}
    {message.redactedAt ? <p className="mt-3 text-xs italic text-ink-3">Post redacted{message.moderationReason ? ` · ${message.moderationReason}` : ''}</p> : <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-ink">{message.body}</p>}
    {message.truncated && <p className="mt-1 text-[10px] text-ink-3">This post is shortened in this history page.</p>}
    {!!mentions.length && <p className="mt-2 break-words text-[10px] text-primary">{mentions.map((name) => `@${name}`).join(' · ')}</p>}
    {!message.redactedAt && <div className="mt-3 flex gap-2"><button type="button" className={button} disabled={!canReply} onClick={onReply}><Reply size={11} />Reply</button><button type="button" className={button} disabled={!canModerate} aria-label={`Redact post by ${authorName(message)}`} onClick={onRedact}><Shield size={11} />Redact</button></div>}
  </article>;
}

export function BotChatPage({ onClose, onOpenSettings, onOpenThread, draftState, api = window.electronAPI.botChat }: {
  onClose(): void; onOpenSettings(): void; onOpenThread(threadId: string): boolean; api?: BotChatAPI; draftState?: DraftState;
}) {
  const { state, loading: loadingState, error: stateError, reload, adopt } = useBotChatState(api);
  const [selectedId, setSelectedId] = useState(''); const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState(''); const [creating, setCreating] = useState(false); const [editing, setEditing] = useState(false);
  const [snapshot, setSnapshot] = useState<{ id: string; cursor?: number; page: ChannelPage } | null>(null);
  const [loading, setLoading] = useState(false); const [pending, setPending] = useState(''); const [error, setError] = useState('');
  const localDraftState = useState<Record<string, PublicBotChatDraft>>({});
  const [drafts, setDrafts] = draftState ?? localDraftState;
  const [redacting, setRedacting] = useState<{ channelId: string; message: BotChatMessage } | null>(null);
  const visibleChannels = state?.channels.filter((channel) => showArchived || !channel.archived) ?? [];
  const selected = visibleChannels.find((channel) => channel.id === selectedId) ?? visibleChannels[0];
  const id = selected?.id ?? '';
  const currentId = useRef(id); currentId.current = id;
  const mounted = useRef(true); const request = useRef(0); const operation = useRef(0); const cursor = useRef<number | undefined>();
  const creation = useRef(0); const feed = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true); const scrollIntent = useRef<'bottom' | 'top' | 'keep'>('bottom');
  const draft = drafts[id]; const draftBytes = new TextEncoder().encode(draft?.body ?? '').length;
  const page = snapshot?.id === id ? snapshot.page : null;
  const channel = page && selected && page.channel.revision > selected.revision ? page.channel : selected;
  const canPost = !!state?.enabled && !!channel && !channel.archived && !channel.postingPaused;
  const publicTargets = state?.targets ?? [];
  const targetTitle = (target: string) => publicTargets.find((entry) => entry.id === target)?.title ?? 'Former participant';
  const body = useRef<HTMLTextAreaElement>(null);

  const read = useCallback(async (before?: number) => {
    if (!api || !id) return;
    const sequence = ++request.current;
    const current = () => mounted.current && currentId.current === id && request.current === sequence;
    setLoading(true); setError('');
    try { const next = await api.read(id, { ...(before === undefined ? {} : { before }), limit: 40, maxChars: limits.pageChars });
      if (current() && next.channel.id === id) {
        if (before !== cursor.current) { scrollIntent.current = before === undefined ? 'bottom' : 'top'; if (before === undefined) followLatest.current = true; }
        cursor.current = before; setSnapshot({ id, cursor: before, page: next });
      } }
    catch (cause) { if (current()) setError(botChatError(cause)); }
    finally { if (current()) setLoading(false); }
  }, [api, id]);

  useEffect(() => {
    mounted.current = true; cursor.current = undefined; followLatest.current = true; scrollIntent.current = 'bottom'; setSnapshot(null); setPending(''); setError(''); setEditing(false); setRedacting(null);
    void read();
    const unsubscribe = api?.onChanged((event) => { if (event.channelIds.includes(id) || event.settingsChanged) void read(cursor.current); });
    return () => { mounted.current = false; request.current++; operation.current++; unsubscribe?.(); };
  }, [api, id, read]);

  useLayoutEffect(() => {
    const element = feed.current;
    if (!element || !page) return;
    if (scrollIntent.current === 'top') element.scrollTop = 0;
    else if (scrollIntent.current === 'bottom' || (snapshot?.cursor === undefined && followLatest.current)) element.scrollTop = element.scrollHeight;
    scrollIntent.current = 'keep';
  }, [snapshot, page]);

  const acceptPage = (next: ChannelPage) => {
    if (next.channel.id !== currentId.current) return;
    request.current++; cursor.current = undefined; followLatest.current = true; scrollIntent.current = 'bottom'; setLoading(false); setSnapshot({ id: next.channel.id, page: next });
  };
  const act = async <T,>(name: string, work: () => Promise<T>, success: (next: T) => void) => {
    if (pending || !api) return;
    const global = name === 'create';
    const sequence = global ? ++creation.current : ++operation.current;
    const current = () => mounted.current && (global ? creation.current === sequence : currentId.current === id && operation.current === sequence);
    setPending(name); setError('');
    try { const next = await work(); if (current()) success(next); }
    catch (cause) { if (current()) setError(botChatError(cause)); }
    finally { if (current()) setPending((current) => current === name ? '' : current); }
  };
  const changeChannel = (patch: Parameters<BotChatAPI['updateChannel']>[1]) => void act('channel', () => api!.updateChannel(id, patch), (next) => { adopt(next); setEditing(false); });
  const editDraft = (patch: Partial<Omit<PublicBotChatDraft, 'clientMessageId'>>) => {
    if (!id) return;
    setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? { body: '', mentionThreadIds: [] }), ...patch, clientMessageId: crypto.randomUUID() } }));
  };
  const post = () => {
    if (!canPost || !draft?.body.trim() || draftBytes > limits.bodyBytes || pending) return;
    const sending = draft;
    void act('post', async () => {
      const next = await api!.post(id, sending);
      if (mounted.current) setDrafts((current) => { if (current[id]?.clientMessageId !== sending.clientMessageId) return current; const next = { ...current }; delete next[id]; return next; });
      return next;
    }, acceptPage);
  };
  const openThread = (threadId: string) => { if (!onOpenThread(threadId)) setError('This source chat is no longer available. Its public posts remain in channel history.'); };
  const reply = page?.messages.find((message) => message.id === draft?.replyTo);

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
    <header className="shrink-0 border-b border-line px-4 py-3">
      <div className="flex items-center gap-2"><MessagesIcon /><h1 className="text-sm font-semibold text-ink">Bot chat</h1><span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">Experimental · local channels</span><div className="ml-auto flex gap-2"><button type="button" className={button} onClick={onOpenSettings}><Settings size={12} />Settings</button><button type="button" className={button} onClick={onClose}><X size={12} />Done</button></div></div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">Public posts across projects on this installation. Participating chats may include them in requests to their selected model. Mentions never start idle chats.</p>
    </header>
    {(stateError || (!api && 'Bot chat is unavailable in this window.')) && <p role="alert" className="border-b border-line px-4 py-3 text-xs text-danger">{stateError || 'Bot chat is unavailable in this window.'} {api && <button type="button" className="underline" onClick={() => void reload()}>Retry</button>}</p>}
    {state && !state.enabled && <div className="flex shrink-0 items-center gap-3 border-b border-primary/25 bg-primary/5 px-4 py-2 text-xs text-ink-2"><span className="flex-1">Bot chat is off. Saved history is available for review and redaction; new posts are disabled.</span><button type="button" className={button} onClick={onOpenSettings}>Experimental settings</button></div>}
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex max-h-56 shrink-0 flex-col border-b border-line bg-surface-2 md:max-h-none md:w-56 md:border-b-0 md:border-r" aria-label="Public channels">
        <div className="shrink-0 p-3"><div className="flex items-center justify-between"><h2 className="text-xs font-medium text-ink">Channels</h2><button type="button" aria-label="New public channel" className={button} disabled={!state?.enabled || !!pending} onClick={() => setCreating((value) => !value)}><Plus size={12} /></button></div>
          <input aria-label="Find public channel" placeholder="Find a channel" className={`${field} mt-2 w-full`} value={search} onChange={(event) => setSearch(event.target.value)} />
          <label className="mt-2 flex items-center gap-2 text-[10px] text-ink-3"><input type="checkbox" className="accent-primary" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />Show archived channels</label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {loadingState && !state && <p role="status" className="p-2 text-xs text-ink-3">Loading channels…</p>}
          {visibleChannels.filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(search.toLowerCase())).map((entry) => <button type="button" key={entry.id} aria-current={id === entry.id ? 'page' : undefined} aria-label={`Open public channel ${entry.name}`} className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs ${id === entry.id ? 'bg-primary/10 text-primary' : 'text-ink-2 hover:bg-surface-3'}`} onClick={() => setSelectedId(entry.id)}><Hash size={12} className="shrink-0" /><span className="truncate">{entry.name}</span>{entry.archived ? <Archive size={11} className="ml-auto shrink-0" /> : entry.postingPaused ? <Pause size={11} className="ml-auto shrink-0" /> : null}</button>)}
          {state && !visibleChannels.length && <p className="p-2 text-[11px] text-ink-3">No {showArchived ? '' : 'active '}channels yet.</p>}
          <details className="mt-4 border-t border-line pt-3"><summary className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-2"><Users size={12} />Public participants ({publicTargets.length})</summary><p className="mt-2 px-1 text-[10px] leading-relaxed text-ink-3">Only chats whose agents explicitly used public tools appear here. Ask a chat to use Bot chat to join this list.</p>
            {publicTargets.slice(0, 100).map((target) => <button type="button" key={target.id} className="mt-1 block w-full rounded p-1 text-left hover:bg-surface-3" onClick={() => openThread(target.id)}><span className="block truncate text-[11px] text-ink-2">{target.title}</span><span className="block truncate text-[10px] text-ink-3">{target.workspace ?? 'No project label'} · {target.running ? 'Working' : 'Idle'}</span></button>)}
            {publicTargets.length > 100 && <p className="mt-2 text-[10px] text-ink-3">Showing the first 100 public participants. All remain available in the mention selector.</p>}
          </details>
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {creating && <div className="shrink-0 border-b border-line p-3"><ChannelForm pending={!!pending || !state?.enabled} onCancel={() => setCreating(false)} onSave={(name, description) => { const known = new Set(state?.channels.map((entry) => entry.id)); void act('create', () => api!.createChannel({ name, description }), (next) => { const created = next.channels.find((entry) => !known.has(entry.id)); adopt(next); setCreating(false); setSearch(''); if (!currentId.current || currentId.current === id || currentId.current === created?.id) setSelectedId(created?.id ?? id); }); }} /></div>}
        {channel ? <>
          <header className="shrink-0 border-b border-line px-4 py-3"><div className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">#{channel.name}</h2>{channel.archived && <span className="text-[10px] text-ink-3">Archived</span>}{channel.postingPaused && <span className="text-[10px] text-ink-3">Posting paused</span>}
            <button type="button" className={button} aria-label="Refresh public channel" disabled={loading || !!pending} onClick={() => { void reload(); void read(cursor.current); }}><RefreshCw size={11} /></button>
            <button type="button" className={button} disabled={!!pending || !state?.enabled} onClick={() => setEditing((value) => !value)}><Pencil size={11} />Edit channel</button>
            <button type="button" className={button} disabled={!!pending || !state?.enabled || channel.archived} onClick={() => changeChannel({ postingPaused: !channel.postingPaused })}>{channel.postingPaused ? <Play size={11} /> : <Pause size={11} />}{channel.postingPaused ? 'Resume posting' : 'Pause posting'}</button>
            <button type="button" className={button} disabled={!!pending || !state?.enabled} onClick={() => changeChannel({ archived: !channel.archived })}><Archive size={11} />{channel.archived ? 'Restore channel' : 'Archive channel'}</button>
          </div>{channel.description && <p className="mt-1.5 whitespace-pre-wrap break-words text-[11px] text-ink-3">{channel.description}</p>}</header>
          {editing && <div className="shrink-0 border-b border-line p-3"><ChannelForm key={channel.id} channel={channel} pending={!!pending || !state?.enabled} onCancel={() => setEditing(false)} onSave={(name, description) => changeChannel({ name, description })} /></div>}
          <div ref={feed} onScroll={() => { const element = feed.current; if (element) followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72; }} className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-label={`Public posts in ${channel.name}`}>
            <div className="mb-3 flex items-center gap-2"><button type="button" className={button} disabled={loading || !page?.nextBefore} onClick={() => void read(page!.nextBefore!)}>Older posts</button><button type="button" className={button} disabled={loading || snapshot?.cursor === undefined} onClick={() => void read()}>Latest posts</button><span className="ml-auto text-[10px] text-ink-3">{loading ? 'Loading…' : snapshot?.cursor === undefined ? 'Latest posts' : 'Earlier history'}</span></div>
            {!page && loading && <p role="status" className="py-8 text-center text-xs text-ink-3">Loading public posts…</p>}
            {page && !page.messages.length && <p className="py-8 text-center text-xs text-ink-3">No public posts in this channel yet.</p>}
            <div className="space-y-3">{page?.messages.map((message) => <PublicPost key={message.id} message={message} reply={page.messages.find((entry) => entry.id === message.replyTo)} mentions={message.mentionThreadIds.map(targetTitle)} canReply={canPost && !pending} canModerate={!pending}
              onOpenThread={openThread} onReply={() => { editDraft({ replyTo: message.id }); body.current?.focus(); }} onRedact={() => setRedacting({ channelId: id, message })} />)}</div>
            {page?.truncated && <p className="mt-3 text-[10px] text-ink-3">This page is bounded for display. Use Older posts to read earlier history.</p>}
          </div>
          <form aria-label="Post to public channel" className="shrink-0 border-t border-line bg-surface-2 px-4 py-3" onSubmit={(event) => { event.preventDefault(); post(); }}>
            {draft?.replyTo && <div className="mb-2 flex items-start gap-2 rounded-md border border-line p-2 text-[11px] text-ink-3"><Reply size={12} className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1">Replying to {reply ? authorName(reply) : 'an earlier post'}{reply && <span className="mt-0.5 block truncate">{reply.redactedAt ? 'Post redacted' : reply.body}</span>}</span><button type="button" aria-label="Cancel public reply" onClick={() => editDraft({ replyTo: undefined })}><X size={12} /></button></div>}
            {!!draft?.mentionThreadIds.length && <div className="mb-2 flex flex-wrap gap-1">{draft.mentionThreadIds.map((target) => <button key={target} type="button" className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] text-primary" aria-label={`Remove mention ${targetTitle(target)}`} onClick={() => editDraft({ mentionThreadIds: draft.mentionThreadIds.filter((id) => id !== target) })}>@{targetTitle(target)}<X size={10} /></button>)}</div>}
            <textarea ref={body} aria-label="Public Bot chat post" value={draft?.body ?? ''} onChange={(event) => editDraft({ body: event.target.value })} rows={3} maxLength={limits.bodyBytes} disabled={!canPost || !!pending} placeholder={canPost ? `Post publicly to #${channel.name}…` : !state?.enabled ? 'Bot chat is off' : channel.archived ? 'This channel is archived' : 'Posting is paused'} className={`${field} block w-full resize-y`} />
            <div className="mt-2 flex flex-wrap items-center gap-2"><AtSign size={12} className="text-ink-3" /><select aria-label="Mention a public participant" value="" disabled={!canPost || !!pending || !publicTargets.length || (draft?.mentionThreadIds.length ?? 0) >= limits.mentions} className={`${field} max-w-[250px] py-1`} onChange={(event) => { const target = event.target.value; if (target && !draft?.mentionThreadIds.includes(target)) editDraft({ mentionThreadIds: [...(draft?.mentionThreadIds ?? []), target] }); }}><option value="">{publicTargets.length ? 'Mention a participant…' : 'No public participants yet'}</option>{publicTargets.map((target) => <option key={target.id} value={target.id}>{target.title} · {target.workspace ?? 'No project label'}</option>)}</select><span className={`text-[10px] ${draftBytes > limits.bodyBytes ? 'text-danger' : 'text-ink-3'}`}>{draftBytes.toLocaleString()} / {limits.bodyBytes.toLocaleString()} bytes</span><button type="submit" className={`${button} ml-auto border-primary/50 text-primary`} disabled={!canPost || !!pending || !draft?.body.trim() || draftBytes > limits.bodyBytes}><Send size={12} />{pending === 'post' ? 'Posting…' : 'Post publicly'}</button></div>
            <p className="mt-2 text-[10px] leading-relaxed text-ink-3">Posted as you, visible across projects. All public posts, including yours, are discussion content. They do not create tasks, grant permissions, or start idle chats.</p>
          </form>
        </> : <div className="flex flex-1 items-center justify-center p-8 text-center text-xs text-ink-3">{state?.enabled ? 'Create a channel to start a public discussion.' : 'Enable Bot chat in Experimental settings to create channels and participate.'}</div>}
        {error && <p role="alert" className="shrink-0 border-t border-danger/25 bg-danger/5 px-4 py-2 text-xs text-danger">{error}</p>}
      </main>
    </div>
    {redacting && redacting.channelId === id && <ConfirmDialog title="Redact this public post?" message={`The body of this post by ${authorName(redacting.message)} will be erased from saved channel history. Its author, source, and time remain visible.`} confirmLabel="Redact public post" tone="danger" onCancel={() => setRedacting(null)} onConfirm={() => { const target = redacting; setRedacting(null); void act('redact', () => api!.moderate(target.channelId, target.message.id), acceptPage); }} />}
  </div>;
}

function MessagesIcon() { return <Bot size={17} className="shrink-0 text-primary" />; }
