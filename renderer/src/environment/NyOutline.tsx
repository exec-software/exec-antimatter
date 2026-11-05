import { useEffect, useMemo, useState } from 'react';
import { ListTree, RefreshCw, Search } from 'lucide-react';
import type { OpenFile } from './store';
import { filterNyOutline, nyOutlineItems, type NyOutlineItem } from './nyOutlineModel';

interface Snapshot { path: string; text: string; items: NyOutlineItem[] }
export interface NyOutlineProps {
  file: Pick<OpenFile, 'path' | 'text'>;
  onReveal(path: string, line: number): void;
}

/** Outline of the current buffer, not a guessed workspace-wide semantic index. */
export function NyOutline({ file, onReveal }: NyOutlineProps) {
  const language = /\.(?:matrix|mat)$/i.test(file.path) ? 'Matrix' : 'Ny';
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [query, setQuery] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const changed = () => setRefresh((value) => value + 1);
    window.addEventListener('antimatter:ny-sdk-changed', changed);
    return () => window.removeEventListener('antimatter:ny-sdk-changed', changed);
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(''); setSelected(null);
    const timer = setTimeout(() => {
      void Promise.resolve().then(() => window.electronAPI.ny.symbols({ path: file.path, text: file.text })).then((symbols) => {
        if (!live) return;
        setSnapshot({ path: file.path, text: file.text, items: nyOutlineItems(symbols, file.text) });
        setLoading(false);
      }).catch((reason: unknown) => {
        if (!live) return;
        setSnapshot(null); setLoading(false);
        setError((reason instanceof Error ? reason.message : String(reason)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').slice(0, 600));
      });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [file.path, file.text, refresh]);

  // An old buffer's positions must disappear in the same render as the edit/file switch.
  const current = snapshot?.path === file.path && snapshot.text === file.text;
  const items = current ? snapshot.items : [];
  const visible = useMemo(() => filterNyOutline(items, query), [items, query]);
  const reveal = (item: NyOutlineItem) => {
    if (!current || loading) return;
    setSelected(item.id);
    onReveal(file.path, item.line);
  };

  return <aside aria-label={`${language} symbol outline`} className="flex h-full min-h-0 min-w-0 w-full flex-col bg-surface-2">
    <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs text-ink-2">
      <ListTree size={14} className="text-primary" />
      <span className="font-medium">{language} outline</span>
      <button type="button" aria-label={`Refresh ${language} outline`} title="Refresh symbols from the selected NIL SDK" disabled={loading}
        onClick={() => setRefresh((value) => value + 1)}
        className="ml-auto rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-primary disabled:opacity-40"><RefreshCw size={12} /></button>
    </div>
    <div className="relative m-2">
      <Search size={12} className="pointer-events-none absolute left-2 top-2 text-ink-3" />
      <input aria-label={`Filter ${language} symbols`} value={query} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); if (event.key === 'Enter' && visible.length === 1) reveal(visible[0]); }}
        placeholder="Find a symbol…" spellCheck={false}
        className="w-full rounded border border-line bg-surface px-2 py-1 pl-6 text-xs text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none" />
    </div>
    <p role="status" className="px-3 pb-2 text-[10px] text-ink-3">
      {loading ? 'Reading current buffer…' : error ? 'Outline unavailable' : `${visible.length} of ${items.length} symbols`}
    </p>
    {error ? <p role="alert" className="overflow-auto px-3 pb-3 text-xs text-danger">{error} Select a working NIL SDK to load symbols.</p>
      : !loading && visible.length === 0 ? <p className="px-3 py-2 text-xs text-ink-3">{query.trim() ? 'No symbols match this filter.' : 'No declarations in this buffer.'}</p>
      : <ul className="min-h-0 flex-1 overflow-auto pb-2">
        {visible.map((item) => <li key={item.id}>
          <button type="button" disabled={loading} onClick={() => reveal(item)}
            title={`${item.container ? `${item.container} › ` : ''}${item.name}\n${item.detail || item.kind}\nLine ${item.line}`}
            aria-label={`${item.kind} ${item.name}, line ${item.line}`}
            className={`flex w-full min-w-0 items-baseline gap-2 border-l-2 py-1.5 pr-2 text-left text-xs transition hover:bg-surface-3 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary ${selected === item.id ? 'border-primary bg-primary/10 text-ink' : 'border-transparent text-ink-2'}`}
            style={{ paddingLeft: `${10 + Math.min(item.depth, 8) * 12}px` }}>
            <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
            <span className="shrink-0 text-[9px] text-ink-3">{item.kind}</span>
          </button>
        </li>)}
      </ul>}
  </aside>;
}
