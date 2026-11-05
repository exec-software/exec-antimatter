import { ArrowDownToLine, ArrowLeft, ArrowRight, Atom, Check, ChevronRight, Compass, FileText, Map, Paperclip, Pin, Search, ShieldAlert, User, Wrench, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { formatClock, isActiveReply } from '../../lib/telemetry';
import type { Message } from '../../types';
import { MessageBody } from '../chat/MessageBody';
import { PinToggle } from '../chat/PinToggle';
import { useConversationUi } from '../chat/conversationUi';
import { atlasExchanges, atlasMessageMatches, atlasSpeaker, type AtlasExchange } from './atlas';
import './atlas.css';

interface Props {
  messages: Message[];
  isStreaming: boolean;
  pinnedMessageIds: Set<string>;
  onTogglePin: (message: Message) => void;
}

const control = 'inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-ink-2 transition hover:bg-surface-3 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-35';

/** A map of exchanges and one focused document, with the real message actions kept intact. */
export function AtlasView({ messages, isStreaming, pinnedMessageIds, onTogglePin }: Props) {
  const { assistantName = 'Antimatter' } = useConversationUi();
  const [query, setQuery] = useState('');
  // Null follows the newest message. Explicit navigation holds the reader's place during updates.
  const [selection, setSelection] = useState<{ exchangeId: string; messageId: string } | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const exchanges = useMemo(() => atlasExchanges(messages), [messages]);
  const matching = useMemo(() => exchanges.filter((entry) => entry.messages.some((message) => atlasMessageMatches(message, query))), [exchanges, query]);
  const following = selection === null && !query.trim();
  const exchange = (following ? exchanges[exchanges.length - 1] : matching.find((entry) => entry.id === selection?.exchangeId)) ?? matching[0];
  const message = exchange?.messages.find((entry) => entry.id === selection?.messageId)
    ?? (query.trim() ? exchange?.messages.find((entry) => atlasMessageMatches(entry, query)) : exchange?.messages[exchange.messages.length - 1]);
  const last = messages[messages.length - 1];
  const activeMessage = isStreaming && last?.role === 'assistant' ? last : undefined;
  const approvalCount = activeMessage?.meta?.tools?.filter((tool) => tool.awaitingApproval).length ?? 0;
  const selectedIsActive = message !== undefined && message.id === activeMessage?.id;
  const selectedIndex = exchange ? matching.findIndex((entry) => entry.id === exchange.id) : -1;
  const reader = useRef<HTMLDivElement>(null);
  const readerBody = useRef<HTMLDivElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const wasMessage = useRef<string>();
  const followScroll = useRef(true);
  const [below, setBelow] = useState(false);
  const panelId = useId();

  const select = (entry: AtlasExchange, messageId?: string, focusReader = false) => {
    const next = entry.messages.find((item) => item.id === messageId)
      ?? (query.trim() ? entry.messages.find((item) => atlasMessageMatches(item, query)) : undefined)
      ?? entry.messages[entry.messages.length - 1];
    setSelection({ exchangeId: entry.id, messageId: next.id });
    setMapOpen(false);
    if (focusReader) requestAnimationFrame(() => reader.current?.focus({ preventScroll: true }));
  };
  const latest = () => { setQuery(''); setSelection(null); setMapOpen(false); followScroll.current = true; reader.current?.scrollTo({ top: reader.current.scrollHeight }); setBelow(false); };

  useLayoutEffect(() => {
    const element = reader.current;
    if (!element || !message) return;
    if (wasMessage.current !== message.id) {
      wasMessage.current = message.id;
      followScroll.current = following;
      element.scrollTop = following && selectedIsActive ? element.scrollHeight : 0;
      setBelow(false);
    } else if (selectedIsActive && followScroll.current) {
      element.scrollTop = element.scrollHeight;
      setBelow(false);
    } else if (selectedIsActive) setBelow(true);
  }, [message, selectedIsActive, following]);

  useEffect(() => {
    const element = reader.current;
    if (!element || !readerBody.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (selectedIsActive && followScroll.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(readerBody.current);
    return () => observer.disconnect();
  }, [selectedIsActive, message?.id]);

  useEffect(() => { selectedButton.current?.scrollIntoView({ block: 'nearest' }); }, [exchange?.id]);

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === 'ArrowDown' ? Math.min(matching.length - 1, selectedIndex + 1)
      : event.key === 'ArrowUp' ? Math.max(0, selectedIndex - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? matching.length - 1 : -1;
    if (next < 0 || !matching[next]) return;
    event.preventDefault(); select(matching[next]); setMapOpen(true);
    requestAnimationFrame(() => selectedButton.current?.focus());
  };

  if (!messages.length) return <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-ink-3">
    <div><Compass size={28} className="mx-auto mb-3 text-accent" /><h2 className="text-sm font-medium text-ink">A map of your conversation</h2>
      <p className="mt-2 max-w-xs text-xs leading-relaxed">Each prompt and its replies become an exchange you can explore here.</p></div>
  </div>;

  return <div className="atlas-view absolute inset-0 flex min-h-0 flex-col bg-surface">
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3">
      <div className="flex items-center gap-2"><Compass size={16} className="text-accent" /><h2 className="text-sm font-semibold text-ink">Atlas</h2></div>
      <span className="text-[11px] text-ink-3">{exchanges.length} exchanges <span aria-hidden="true">·</span> {messages.length} messages</span>
      <button type="button" onClick={latest} aria-pressed={following} className={`${control} ml-auto ${following ? 'text-accent' : ''}`}>
        {following ? <Check size={13} /> : <ArrowDownToLine size={13} />} {following ? 'Following latest' : 'Latest exchange'}
      </button>
    </header>

    {activeMessage && !selectedIsActive && <button type="button" onClick={latest}
      className={`flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2 text-left text-xs ${approvalCount ? 'bg-primary/10 text-primary' : 'bg-accent/10 text-accent'}`}>
      <span className="flex items-center gap-2">{approvalCount ? <ShieldAlert size={14} /> : <Atom size={14} />}
        {approvalCount ? `${approvalCount} action${approvalCount === 1 ? ' needs' : 's need'} approval in the live reply` : `${assistantName} has a live reply`}</span>
      <span className="flex shrink-0 items-center gap-1">Open <ChevronRight size={13} /></span>
    </button>}

    <div className="atlas-mobile-bar shrink-0 items-center gap-2 border-b border-line px-3 py-2">
      <button type="button" className={control} onClick={() => setMapOpen((value) => !value)} aria-expanded={mapOpen} aria-controls={`${panelId}-map`}><Map size={14} />{mapOpen ? 'Hide map' : 'Explore map'}</button>
      <span className="ml-auto text-xs tabular-nums text-ink-3">{exchange ? `Exchange ${exchange.number} of ${exchanges.length}` : 'No matches'}</span>
    </div>

    <div className={`atlas-layout min-h-0 flex-1 ${mapOpen ? 'atlas-map-open' : ''}`}>
      <nav id={`${panelId}-map`} aria-label="Conversation map" className="atlas-navigator min-h-0 flex-col border-r border-line bg-surface-2/40">
        <div className="shrink-0 space-y-3 border-b border-line p-3">
          <label className="relative block">
            <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2.5 text-ink-3" />
            <input value={query} onChange={(event) => { setQuery(event.target.value); setSelection(null); }} type="search" aria-label="Search Atlas" placeholder="Find text, files, or actions"
              className="w-full rounded-md border border-line bg-surface py-2 pl-8 pr-7 text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear Atlas search" className="absolute right-1.5 top-1.5 rounded p-1 text-ink-3 hover:text-ink"><X size={12} /></button>}
          </label>
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-ink-3"><span>{query ? `${matching.length} matches` : 'Exchange index'}</span><span>{exchange ? String(exchange.number).padStart(2, '0') : '—'} / {String(exchanges.length).padStart(2, '0')}</span></div>
          <div aria-hidden="true" className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-surface-3">
            {exchanges.map((entry) => <span key={entry.id} className={`min-w-0 flex-1 ${entry.id === exchange?.id ? 'bg-accent' : entry.number < (exchange?.number ?? 0) ? 'bg-accent/25' : 'bg-surface-3'}`} />)}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2" onKeyDown={navigate}>
          {matching.map((entry) => {
            const selected = entry.id === exchange?.id;
            const live = entry.messages.some((item) => item.id === activeMessage?.id);
            const pins = entry.messages.filter((item) => pinnedMessageIds.has(item.id)).length;
            return <button type="button" key={entry.id} ref={selected ? selectedButton : undefined} aria-current={selected ? 'true' : undefined}
              aria-label={`Open exchange ${entry.number}: ${entry.excerpt}`} onClick={() => select(entry, undefined, true)}
              className={`atlas-exchange group mb-1 flex w-full gap-2.5 rounded-lg border p-2.5 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${selected ? 'border-accent/30 bg-accent/10' : 'border-transparent hover:bg-surface-2'}`}>
              <span className={`pt-0.5 font-mono text-[10px] tabular-nums ${selected ? 'text-accent' : 'text-ink-3'}`}>{String(entry.number).padStart(2, '0')}</span>
              <span className="min-w-0 flex-1">
                <span className={`line-clamp-2 text-xs leading-relaxed ${selected ? 'text-ink' : 'text-ink-2'}`}>{entry.excerpt}</span>
                <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-ink-3">
                  <span>{entry.messages.length} msg</span>
                  {entry.actions > 0 && <span className="flex items-center gap-1"><Wrench size={10} />{entry.actions}</span>}
                  {entry.attachments > 0 && <span className="flex items-center gap-1"><Paperclip size={10} />{entry.attachments}</span>}
                  {pins > 0 && <span className="flex items-center gap-1 text-primary"><Pin size={10} />{pins}</span>}
                  {live && <span className="ml-auto flex items-center gap-1 text-accent"><span className="h-1 w-1 rounded-full bg-accent" />Live</span>}
                </span>
              </span>
            </button>;
          })}
          {!matching.length && <p className="p-3 text-xs leading-relaxed text-ink-3">No exchanges match. Try a different phrase or clear the search.</p>}
        </div>
      </nav>

      <section aria-label="Atlas reading panel" className="relative flex min-h-0 min-w-0 flex-col">
        {exchange && message ? <>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
            <span className="min-w-0 flex-1 text-[11px] uppercase tracking-wide text-ink-3">Exchange {String(exchange.number).padStart(2, '0')}</span>
            <button type="button" className={control} disabled={selectedIndex <= 0} onClick={() => select(matching[selectedIndex - 1])} aria-label="Previous exchange"><ArrowLeft size={14} /></button>
            <button type="button" className={control} disabled={selectedIndex >= matching.length - 1} onClick={() => select(matching[selectedIndex + 1])} aria-label="Next exchange"><ArrowRight size={14} /></button>
          </div>
          <div role="tablist" aria-label="Messages in this exchange" className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-4 pt-2">
            {exchange.messages.map((entry, index) => <button type="button" key={entry.id} role="tab" id={`${panelId}-tab-${index}`}
              aria-selected={entry.id === message.id} aria-controls={`${panelId}-document`} tabIndex={entry.id === message.id ? 0 : -1}
              onClick={() => select(exchange, entry.id)} onKeyDown={(event) => {
                const target = event.key === 'ArrowRight' ? (index + 1) % exchange.messages.length : event.key === 'ArrowLeft' ? (index + exchange.messages.length - 1) % exchange.messages.length
                  : event.key === 'Home' ? 0 : event.key === 'End' ? exchange.messages.length - 1 : -1;
                if (target < 0) return;
                event.preventDefault(); select(exchange, exchange.messages[target].id);
                document.getElementById(`${panelId}-tab-${target}`)?.focus();
              }} className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${entry.id === message.id ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink'}`}>
              {entry.role === 'user' ? <User size={12} /> : entry.role === 'assistant' ? <Atom size={12} /> : <FileText size={12} />}
              {entry.role === 'user' ? 'Your prompt' : atlasSpeaker(entry, assistantName)}
              {exchange.messages.filter((item) => item.role === entry.role).length > 1 && <span className="text-[10px] text-ink-3">{exchange.messages.slice(0, index + 1).filter((item) => item.role === entry.role).length}</span>}
              {pinnedMessageIds.has(entry.id) && <Pin size={10} className="text-primary" />}
            </button>)}
          </div>
          <div ref={reader} role="tabpanel" id={`${panelId}-document`} aria-labelledby={`${panelId}-tab-${exchange.messages.indexOf(message)}`} tabIndex={0}
            onScroll={() => { const element = reader.current!; followScroll.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; if (followScroll.current) setBelow(false); }}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent">
            <div ref={readerBody} className="atlas-document mx-auto w-full max-w-[900px] px-6 py-5">
              <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-soft pb-4">
                <h3 className="text-sm font-semibold text-ink">{atlasSpeaker(message, assistantName)}</h3>
                {message.meta?.createdAt !== undefined && <span className="text-[11px] text-ink-3">{formatClock(message.meta.createdAt)}</span>}
                {message.meta?.modelId && <span className="max-w-[240px] truncate font-mono text-[10px] text-ink-3" title={message.meta.modelId}>{message.meta.modelId}</span>}
                {selectedIsActive && <span className="text-[10px] text-accent">Live reply</span>}
                {message.meta?.failed && <span className="text-[10px] text-danger">Failed</span>}
                {(message.content || message.attachments?.length) && <span className="ml-auto"><PinToggle isPinned={pinnedMessageIds.has(message.id)} onToggle={() => onTogglePin(message)} /></span>}
              </div>
              <MessageBody key={message.id} message={message} isActive={isActiveReply(message, message.id === last?.id, isStreaming)} />
              {!message.content && !message.attachments?.length && !message.meta?.tools?.length && !selectedIsActive && <p className="text-sm text-ink-3">No text was recorded for this message.</p>}
            </div>
          </div>
          {selectedIsActive && below && <button type="button" onClick={() => { followScroll.current = true; reader.current?.scrollTo({ top: reader.current.scrollHeight }); setBelow(false); }}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-accent/30 bg-surface-2 px-3 py-1.5 text-xs text-accent shadow-lg"><ArrowDownToLine size={12} />New activity below</button>}
        </> : <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center text-sm text-ink-3">No matching messages. Clear the search to return to the map.</div>}
      </section>
    </div>
  </div>;
}
