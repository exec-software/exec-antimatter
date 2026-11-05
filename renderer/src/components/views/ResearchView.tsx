import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, ClipboardCopy, Pin, Search, SlidersHorizontal, X } from 'lucide-react';
import { formatClock, formatSeconds } from '../../lib/telemetry';
import {
  filterResearchRows, researchRows, researchTsv, sortResearchRows, summarizeResearchRows,
  type ResearchMetric, type ResearchSort,
} from '../../lib/researchData';
import type { Message } from '../../types';
import { MessageBody } from '../chat/MessageBody';
import { useConversationUi } from '../chat/conversationUi';

interface Props {
  messages: Message[];
  isStreaming: boolean;
  pinnedMessageIds: Set<string>;
}

interface Column {
  key: ResearchMetric;
  label: string;
  title: string;
  width: number;
  numeric?: boolean;
}

const DASH = '—';
const COLUMNS: Column[] = [
  { key: 'ttft', label: 'First token', title: 'Seconds from request to first token; mean in the footer', width: 88, numeric: true },
  { key: 'latency', label: 'Time', title: 'Request to finish, or elapsed time while active; mean in the footer', width: 84, numeric: true },
  { key: 'tokens', label: 'Tokens ≈', title: 'Estimated output tokens, not reported provider usage; total in the footer', width: 84, numeric: true },
  { key: 'rate', label: 'Tok/s ≈', title: 'Estimated generation speed; weighted by generation time in the footer', width: 80, numeric: true },
  { key: 'time', label: 'Started', title: 'When the turn started', width: 100 },
  { key: 'model', label: 'Model', title: 'Model recorded on this turn', width: 160 },
  { key: 'chars', label: 'Chars', title: 'Characters; total in the footer', width: 78, numeric: true },
  { key: 'words', label: 'Words', title: 'English word count; total in the footer', width: 78, numeric: true },
  { key: 'avgWord', label: 'Word len.', title: 'Average English word length; word-weighted mean in the footer', width: 88, numeric: true },
  { key: 'functionWordPct', label: 'Function %', title: 'English function words as a share of words; word-weighted mean in the footer', width: 100, numeric: true },
  { key: 'codeBlocks', label: 'Code', title: 'Code blocks; total in the footer', width: 66, numeric: true },
  { key: 'files', label: 'Files', title: 'Attached files; total in the footer', width: 66, numeric: true },
];
const INDEX_COLUMN: Column = { key: 'index', label: '#', title: 'Original turn order', width: 52, numeric: true };
const ESSENTIAL_KEYS = new Set<ResearchMetric>(['index', 'ttft', 'latency', 'tokens', 'rate']);

function metricText(key: ResearchMetric, value: number | string | null | undefined): string {
  if (value == null || (typeof value === 'number' && !Number.isFinite(value))) return DASH;
  if (typeof value === 'string') return value;
  if (key === 'index') return String(value + 1);
  if (key === 'time') return formatClock(value);
  if (key === 'ttft' || key === 'latency') return formatSeconds(value);
  if (key === 'rate' || key === 'avgWord') return value.toFixed(1);
  if (key === 'functionWordPct') return `${Math.round(value)}%`;
  return String(value);
}

function HeaderCell({ column, sort, onSort }: { column: Column; sort: ResearchSort; onSort: (key: ResearchMetric) => void }) {
  const active = sort.key === column.key;
  return (
    <th scope="col" aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
      className={`sticky top-0 z-10 border-b border-line bg-surface-2 px-3 py-3 ${column.numeric ? 'text-right' : 'text-left'}`}>
      <button type="button" title={column.title} aria-label={`Sort by ${column.label === '#' ? 'turn' : column.label}`}
        onClick={() => onSort(column.key)}
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded text-[11px] font-medium transition hover:text-ink focus-visible:outline-accent ${active ? 'text-accent' : 'text-ink-3'}`}>
        {column.label}{active && (sort.descending ? <ArrowDown size={11} aria-hidden="true" /> : <ArrowUp size={11} aria-hidden="true" />)}
      </button>
    </th>
  );
}

/** A readable turn comparison by default, with the complete telemetry table one toggle away. */
export function ResearchView({ messages, isStreaming, pinnedMessageIds }: Props) {
  const { assistantName = 'Antimatter' } = useConversationUi();
  const [sort, setSort] = useState<ResearchSort>({ key: 'index', descending: false });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'all' | Message['role']>('all');
  const [detailed, setDetailed] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [now, setNow] = useState(Date.now);
  const detailId = useId();

  useEffect(() => {
    if (!isStreaming) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [isStreaming]);
  useEffect(() => {
    if (copyState !== 'copied') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 1500);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const rows = useMemo(() => researchRows(messages, isStreaming, now), [messages, isStreaming, now]);
  const filtered = filterResearchRows(rows, query, role, assistantName);
  const sorted = sortResearchRows(filtered, sort);
  const summary = summarizeResearchRows(filtered);
  const columns = detailed ? COLUMNS : COLUMNS.slice(0, 4);
  const replies = filtered.filter(({ turn }) => turn.role === 'assistant').length;
  const toggleSort = (key: ResearchMetric) => setSort((previous) => previous.key === key ? { key, descending: !previous.descending } : { key, descending: false });
  const copyTsv = async () => {
    try { await navigator.clipboard.writeText(researchTsv(sorted)); setCopyState('copied'); }
    catch { setCopyState('failed'); }
  };

  return (
    <div className="absolute inset-0 flex min-w-0 flex-col bg-surface">
      <header className="shrink-0 space-y-3 border-b border-line px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Research</h2>
            <p className="mt-1 text-xs text-ink-3">Compare replies, inspect a turn, or take the data with you.</p>
          </div>
          <button type="button" onClick={copyTsv} disabled={!sorted.length} aria-label="Copy filtered rows as TSV"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-xs text-ink-2 transition hover:border-accent hover:text-ink focus-visible:outline-accent disabled:opacity-40">
            {copyState === 'copied' ? <Check size={13} className="text-accent" aria-hidden="true" /> : <ClipboardCopy size={13} aria-hidden="true" />}
            {copyState === 'copied' ? 'Copied' : 'Copy TSV'}
          </button>
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-2 rounded-lg bg-surface-2/60 px-3 py-2.5">
          {[
            ['Replies', String(replies)], ['Avg first token', metricText('ttft', summary.ttft)],
            ['Avg turn time', metricText('latency', summary.latency)], ['Output tokens ≈', metricText('tokens', summary.tokens)],
          ].map(([label, value]) => <div key={label} className="min-w-[96px]"><p className="text-[10px] text-ink-3">{label}</p><p className="mt-0.5 text-sm font-medium tabular-nums text-ink">{value}</p></div>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-[1_1_180px] items-center gap-2 rounded-lg border border-line bg-surface-0 px-3 focus-within:border-accent">
            <Search size={14} aria-hidden="true" className="shrink-0 text-ink-3" />
            <input aria-label="Search research turns" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="Search messages, models, or sources…" className="min-w-0 flex-1 bg-transparent py-2 text-xs text-ink outline-none placeholder:text-ink-3" />
            {query && <button type="button" aria-label="Clear research search" onClick={() => setQuery('')} className="rounded p-1 text-ink-3 hover:text-ink focus-visible:outline-accent"><X size={13} /></button>}
          </label>
          <select aria-label="Filter research by role" value={role} onChange={(event) => setRole(event.target.value as typeof role)}
            className="max-w-full rounded-lg border border-line bg-surface-0 px-3 py-2 text-xs text-ink focus-visible:outline-accent">
            <option value="all">All turns</option><option value="assistant">Replies</option><option value="user">Your messages</option>
          </select>
          <button type="button" aria-label="Show detailed metrics" aria-pressed={detailed}
            onClick={() => { setDetailed(!detailed); if (detailed && !ESSENTIAL_KEYS.has(sort.key)) setSort({ key: 'index', descending: false }); }}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition focus-visible:outline-accent ${detailed ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line text-ink-2 hover:text-ink'}`}>
            <SlidersHorizontal size={13} aria-hidden="true" />Details
          </button>
        </div>
        <p className="text-[11px] text-ink-3">{filtered.length} of {rows.length} turns · Tokens and speed are estimates. {DASH} means unmeasured.</p>
        {copyState === 'failed' && <p role="status" className="text-xs text-danger">Could not copy the table. Try again.</p>}
        {copyState === 'copied' && <span role="status" className="sr-only">Copied {sorted.length} turns with all metrics.</span>}
      </header>

      {!sorted.length ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto p-6 text-center">
          <Search size={24} className="text-accent" aria-hidden="true" />
          <h3 className="text-sm font-medium text-ink">{rows.length ? 'No matching turns' : 'No turns to compare yet'}</h3>
          <p className="text-xs text-ink-3">{rows.length ? 'Try another search or show all roles.' : 'Your conversation and its measurements will appear here.'}</p>
          {(query || role !== 'all') && <button type="button" onClick={() => { setQuery(''); setRole('all'); }} className="mt-2 rounded-md border border-line px-3 py-1.5 text-xs text-ink hover:border-accent focus-visible:outline-accent">Clear filters</button>}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" tabIndex={0} role="region" aria-label="Turn measurements" style={{ outlineOffset: -2 }}>
          <table className={`w-full table-fixed border-separate border-spacing-0 text-xs ${detailed ? 'min-w-[1440px]' : 'min-w-[680px]'}`}>
            <caption className="sr-only">Conversation turn measurements. Sort using column buttons; expand a message to read it. Totals and averages reflect the current filters.</caption>
            <colgroup><col style={{ width: INDEX_COLUMN.width }} /><col />{columns.map((column) => <col key={column.key} style={{ width: column.width }} />)}</colgroup>
            <thead><tr><HeaderCell column={INDEX_COLUMN} sort={sort} onSort={toggleSort} /><th scope="col" className="sticky top-0 z-10 border-b border-line bg-surface-2 px-3 py-3 text-left text-[11px] font-medium text-ink-3">Message</th>{columns.map((column) => <HeaderCell key={column.key} column={column} sort={sort} onSort={toggleSort} />)}</tr></thead>
            <tbody>
              {sorted.map(({ message, turn, active }) => {
                const expanded = expandedId === message.id;
                const rowDetailId = `${detailId}-${turn.index}`;
                const isUser = turn.role === 'user';
                const preview = message.content.replace(/\s+/g, ' ').trim() || (active ? 'Reply in progress…' : turn.files ? `${turn.files} attached files` : 'Empty turn');
                return <Fragment key={message.id}>
                  <tr className={expanded ? 'bg-surface-2/60' : 'hover:bg-surface-2/30'}>
                    <td className="border-b border-line-soft px-3 py-3 text-right align-top tabular-nums text-ink-3"><span className="inline-flex items-center gap-1">{pinnedMessageIds.has(message.id) && <Pin size={10} aria-label="Pinned" className="text-accent" />}{turn.index + 1}</span></td>
                    <td className="border-b border-line-soft px-3 py-2">
                      <button type="button" aria-expanded={expanded} aria-controls={expanded ? rowDetailId : undefined}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} turn ${turn.index + 1} from ${isUser ? 'You' : assistantName}`}
                        onClick={() => setExpandedId(expanded ? null : message.id)}
                        className="flex w-full min-w-0 items-start gap-2 rounded-md py-1 text-left focus-visible:outline-accent">
                        {expanded ? <ChevronDown size={13} className="mt-0.5 shrink-0 text-accent" /> : <ChevronRight size={13} className="mt-0.5 shrink-0 text-ink-3" />}
                        <span className="min-w-0 flex-1"><span className="flex items-baseline gap-2"><span className={`shrink-0 text-[11px] font-medium ${isUser ? 'text-ink-2' : 'text-accent'}`}>{isUser ? 'You' : assistantName}</span>{!detailed && turn.model && <span className="truncate text-[10px] text-ink-3" title={turn.model}>{turn.model}</span>}{active && <span className="text-[10px] text-accent">Live</span>}{turn.failed && <span className="text-[10px] text-danger">Failed</span>}</span><span className="mt-1 block truncate leading-5 text-ink-2" title={preview}>{preview}</span></span>
                      </button>
                    </td>
                    {columns.map((column) => <td key={column.key} title={column.key === 'model' ? [turn.source, turn.model].filter(Boolean).join(' · ') : column.title}
                      className={`truncate border-b border-line-soft px-3 py-3 font-mono text-[11px] tabular-nums ${column.numeric ? 'text-right' : ''} ${turn[column.key] === null ? 'text-ink-3' : 'text-ink-2'}`}>{metricText(column.key, turn[column.key])}</td>)}
                  </tr>
                  {expanded && <tr><td colSpan={columns.length + 2} className="border-b border-line bg-surface-2/30 px-5 py-4"><div id={rowDetailId} className="max-w-5xl break-words"><p className="mb-3 text-[11px] text-ink-3">Turn {turn.index + 1}{turn.source ? ` · ${turn.source}` : ''}{turn.model ? ` · ${turn.model}` : ''}</p><MessageBody message={message} isActive={active} /></div></td></tr>}
                </Fragment>;
              })}
            </tbody>
            <tfoot><tr><th colSpan={2} scope="row" className="sticky bottom-0 border-t border-line bg-surface-2 px-3 py-3 text-left text-[11px] font-medium text-ink-3">Filtered totals / averages</th>{columns.map((column) => <td key={column.key} title={column.title} className={`sticky bottom-0 border-t border-line bg-surface-2 px-3 py-3 font-mono text-[11px] tabular-nums text-ink-2 ${column.numeric ? 'text-right' : ''}`}>{column.key === 'time' || column.key === 'model' ? '' : metricText(column.key, summary[column.key])}</td>)}</tr></tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
