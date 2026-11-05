import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Braces, Search, X } from 'lucide-react';
import { collectCodeSnippets, filterCodeSnippets, selectedCodeSnippet } from '../../lib/codeSnippets';
import { formatClock } from '../../lib/telemetry';
import type { Message } from '../../types';
import { CodeBlock } from '../CodeBlock';
import { useConversationUi } from '../chat/conversationUi';

interface Props { messages: Message[] }

const lineCountLabel = (code: string): string => {
  const count = code ? code.split('\n').length : 0;
  return `${count} ${count === 1 ? 'line' : 'lines'}`;
};

/** A searchable index keeps one snippet in focus, even while another reply is streaming. */
export function CodeView({ messages }: Props) {
  const { assistantName = 'Antimatter' } = useConversationUi();
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const panelId = useId();
  const blocks = useMemo(() => collectCodeSnippets(messages), [messages]);
  const languages = [...new Set(blocks.map((block) => block.language))].sort();
  const visible = filterCodeSnippets(blocks, query, language, assistantName);
  const selected = selectedCodeSnippet(visible, selectedKey);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 680));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const clearFilters = () => { setQuery(''); setLanguage('all'); };

  return (
    <div ref={rootRef} className="absolute inset-0 flex min-w-0 flex-col bg-surface">
      <header className="shrink-0 space-y-3 border-b border-line px-4 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-ink">Code library</h2>
            <p className="mt-1 text-xs text-ink-3">Find, inspect, and copy snippets from this chat.</p>
          </div>
          <span className="text-xs tabular-nums text-ink-3">{visible.length} of {blocks.length} snippets</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex min-w-0 flex-[1_1_180px] items-center gap-2 rounded-lg border border-line bg-surface-0 px-3 focus-within:border-accent">
            <Search size={14} aria-hidden="true" className="shrink-0 text-ink-3" />
            <input aria-label="Search code snippets" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="Search code, model, or source…" className="min-w-0 flex-1 bg-transparent py-2 text-xs text-ink outline-none placeholder:text-ink-3" />
            {query && <button type="button" aria-label="Clear code search" onClick={() => setQuery('')} className="rounded p-1 text-ink-3 hover:text-ink focus-visible:outline-accent"><X size={13} /></button>}
          </label>
          <select aria-label="Filter code by language" value={language} onChange={(event) => setLanguage(event.target.value)}
            className="max-w-full rounded-lg border border-line bg-surface-0 px-3 py-2 text-xs text-ink focus-visible:outline-accent">
            <option value="all">All languages</option>
            {language !== 'all' && !languages.includes(language) && <option value={language}>{language} (no snippets)</option>}
            {languages.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>
      </header>

      {!selected ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto px-6 py-10 text-center">
          <Braces size={28} className="mb-1 text-accent" aria-hidden="true" />
          <h3 className="text-sm font-medium text-ink">{blocks.length ? 'No matching snippets' : 'No code yet'}</h3>
          <p className="max-w-xs text-xs leading-5 text-ink-3">{blocks.length ? 'Try a different search or language.' : 'Fenced code blocks from your messages and replies will collect here.'}</p>
          {(query || language !== 'all') && <button type="button" onClick={clearFilters} className="mt-2 rounded-md border border-line px-3 py-1.5 text-xs text-ink hover:border-accent focus-visible:outline-accent">Clear filters</button>}
        </div>
      ) : (
        <div className={`flex min-h-0 min-w-0 flex-1 ${narrow ? 'flex-col' : ''}`}>
          <nav ref={listRef} aria-label="Code snippets" className={`shrink-0 overflow-y-auto bg-surface-2/30 p-2 ${narrow ? 'max-h-[34%] min-h-[100px] border-b border-line' : 'w-[252px] border-r border-line'}`}>
            {visible.map((block, index) => {
              const active = block.key === selected.key;
              const label = block.role === 'user' ? 'You' : assistantName;
              const preview = block.code.split('\n').find((line) => line.trim())?.trim() || 'Empty code block';
              return (
                <button key={block.key} type="button" aria-pressed={active} aria-controls={panelId}
                  onClick={() => setSelectedKey(block.key)}
                  onKeyDown={(event) => {
                    const next = event.key === 'ArrowDown' ? Math.min(visible.length - 1, index + 1)
                      : event.key === 'ArrowUp' ? Math.max(0, index - 1)
                      : event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : null;
                    if (next === null) return;
                    event.preventDefault();
                    setSelectedKey(visible[next].key);
                    listRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
                  }}
                  className={`mb-1 block w-full min-w-0 rounded-lg border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${active ? 'border-accent/40 bg-accent/10' : 'border-transparent hover:bg-surface-2'}`}>
                  <span className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate font-medium text-ink">{block.language}</span>
                    <span className="shrink-0 tabular-nums text-ink-3">#{block.turn} · {block.block}</span>
                  </span>
                  <span className="mt-1 block truncate font-mono text-xs text-ink-2" title={preview}>{preview}</span>
                  <span className="mt-1 block truncate text-[11px] text-ink-3">{label} · {lineCountLabel(block.code)}</span>
                </button>
              );
            })}
          </nav>

          <section id={panelId} aria-label="Selected code snippet" className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-4">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-ink">{selected.language} <span className="font-normal text-ink-3">· Turn {selected.turn}, snippet {selected.block}</span></h3>
                <p className="mt-1 break-words text-xs text-ink-3">
                  {selected.role === 'user' ? 'You' : assistantName}
                  {selected.time !== null && Number.isFinite(selected.time) ? ` · ${formatClock(selected.time)}` : ''}
                  {selected.model ? ` · ${selected.model}` : ''}
                  {selected.source ? ` · ${selected.source}` : ''}
                </p>
                {selected.info !== selected.language && selected.info && <p className="mt-1 break-words font-mono text-[11px] text-ink-3">{selected.info}</p>}
              </div>
              <span className="shrink-0 rounded-md bg-surface-2 px-2 py-1 text-[11px] tabular-nums text-ink-3">{lineCountLabel(selected.code)}</span>
            </div>
            <CodeBlock key={selected.key} code={selected.code} language={selected.language} />
            {!selected.complete && <p className="mt-2 text-[11px] text-ink-3">Open code block — the closing fence has not arrived.</p>}
          </section>
        </div>
      )}
    </div>
  );
}
