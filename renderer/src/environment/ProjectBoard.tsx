import { useEffect, useRef, useState } from 'react';
import { FileCode2, Link2, Move, Plus, Save, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import type { BoardCard, NativeProject } from '../../../src/api/nativeProject';
import { actions, useEnvironment } from './store';

const button = 'inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-[11px] text-ink-2 hover:border-primary disabled:opacity-40';
const field = 'min-w-0 rounded border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-primary';

export function ProjectBoard({ project, onOpenSource }: { project: NativeProject | null; onOpenSource(): void }) {
  const state = useEnvironment();
  const [zoom, setZoom] = useState(1);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('helper');
  const [path, setPath] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [moving, setMoving] = useState<{ id: string; x: number; y: number } | null>(null);
  const drag = useRef<{ id: string; startX: number; startY: number; x: number; y: number } | null>(null);
  const root = useRef(state.root); root.current = state.root;
  const board = state.board;
  const rust = project?.kind === 'cargo' || project?.kind === 'rust-file';
  const disabled = busy || state.busy || state.workspaceSwitching || !!state.pendingWorkspace || !!state.task || state.debug.phase !== 'stopped';

  useEffect(() => { void actions.loadBoard(); }, [state.root]);
  useEffect(() => {
    if (!state.boardDirty || state.boardConflict || disabled) return;
    const timer = setTimeout(() => { void actions.saveBoard(); }, 650);
    return () => clearTimeout(timer);
  }, [state.board, state.boardDirty, state.boardConflict, disabled]);
  useEffect(() => { setFrom(''); setTo(''); setError(''); setCreating(false); setMoving(null); }, [state.root]);
  const update = (cards: BoardCard[]) => {
    if (board) actions.editBoard(cards, board.edges.filter((edge) => cards.some((card) => card.id === edge.from) && cards.some((card) => card.id === edge.to)));
  };
  const add = (filePath: string, label?: string) => {
    if (!board || board.cards.some((card) => card.path === filePath)) return;
    update([...board.cards, { id: crypto.randomUUID(), path: filePath, label: label ?? filePath.split('/').pop() ?? filePath,
      x: 32 + (board.cards.length % 3) * 250, y: 32 + Math.floor(board.cards.length / 3) * 140 }]);
  };
  const create = async () => {
    if (!board) return;
    const expectedRoot = state.root;
    setBusy(true); setError('');
    try {
      const created = await window.electronAPI.nativeProject.createSource({ root: state.root, path: path || (rust ? `src/${name}.rs` : `${name}.hpp`), language: rust ? 'rust' : 'cpp', name });
      if (root.current !== expectedRoot) return;
      add(created.path, name); await actions.reload(); await actions.openFile(created.path); setCreating(false);
    } catch (error) { if (root.current === expectedRoot) setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const cards = board?.cards.map((card) => moving?.id === card.id ? { ...card, x: moving.x, y: moving.y } : card) ?? [];
  const width = Math.max(800, ...cards.map((card) => card.x + 260));
  const height = Math.max(480, ...cards.map((card) => card.y + 160));
  const selected = board?.cards.find((card) => card.path === state.activePath);
  const open = async (path: string) => { await actions.openFile(path); onOpenSource(); };
  return <section className="flex h-full min-h-0 min-w-0 flex-col bg-surface" aria-label="Project board">
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
      <button type="button" className={button} disabled={disabled || !board || !state.activePath || board.cards.some((card) => card.path === state.activePath)} onClick={() => state.activePath && add(state.activePath)}><Plus size={12} />Add open file</button>
      <button type="button" className={button} disabled={disabled || !board} onClick={() => { setCreating(!creating); setPath(''); }}><FileCode2 size={12} />New module</button>
      <button type="button" className={button} disabled={!state.boardDirty || disabled || !!state.boardConflict} onClick={() => { void actions.saveBoard(); }}><Save size={12} />{state.boardDirty ? 'Save board' : 'Saved'}</button>
      <span className="flex-1" />
      <button type="button" className={button} aria-label="Zoom out board" disabled={zoom <= 0.5} onClick={() => setZoom(Math.max(0.5, zoom - 0.1))}><ZoomOut size={12} /></button>
      <span className="text-[10px] text-ink-3">{Math.round(zoom * 100)}%</span>
      <button type="button" className={button} aria-label="Zoom in board" disabled={zoom >= 1.5} onClick={() => setZoom(Math.min(1.5, zoom + 0.1))}><ZoomIn size={12} /></button>
    </div>
    {state.boardConflict && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/40 p-3 text-xs text-ink">
      <p className="w-full">The board changed in another window. Your draft is kept.</p>
      <button className={button} onClick={() => actions.resolveBoardConflict(true)}>Keep my board</button>
      <button className={button} onClick={() => actions.resolveBoardConflict(false)}>Use saved board</button>
    </div>}
    {creating && <form className="flex shrink-0 flex-wrap items-end gap-2 border-b border-line p-3" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-[10px] text-ink-3">{rust ? 'Rust module' : 'C++ header'}<input aria-label="Module name" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} className={field} /></label>
      <label className="flex min-w-0 flex-[2] flex-col gap-1 text-[10px] text-ink-3">Path<input aria-label="Module path" value={path} onChange={(event) => setPath(event.target.value)} placeholder={rust ? `src/${name}.rs` : `${name}.hpp`} className={field} /></label>
      <button type="submit" className={button} disabled={disabled || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)}>Create module</button>
    </form>}
    {error && <p role="alert" className="shrink-0 border-b border-danger/40 px-3 py-2 text-xs text-danger">{error}</p>}
    <div className="min-h-0 min-w-0 flex-1 overflow-auto" aria-label="Source cards">
      {!board ? <p className="p-4 text-xs text-ink-3">Loading board…</p> : <div style={{ width: width * zoom, height: height * zoom }}>
        <div className="relative origin-top-left" style={{ width, height, transform: `scale(${zoom})`, backgroundImage: 'radial-gradient(rgb(var(--color-line)) 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
          <svg className="pointer-events-none absolute inset-0 text-primary" width={width} height={height} aria-hidden="true">
            <defs><marker id="project-board-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor" /></marker></defs>
            {board.edges.map((edge) => {
              const source = cards.find((card) => card.id === edge.from), target = cards.find((card) => card.id === edge.to);
              return source && target ? <path key={`${edge.from}:${edge.to}`} d={`M ${source.x + 210} ${source.y + 48} C ${source.x + 250} ${source.y + 48}, ${target.x - 40} ${target.y + 48}, ${target.x} ${target.y + 48}`} fill="none" stroke="currentColor" strokeWidth="1.5" markerEnd="url(#project-board-arrow)" /> : null;
            })}
          </svg>
          {!cards.length && <div className="absolute left-8 top-8 max-w-sm rounded-lg border border-line bg-surface-2 p-4 text-xs text-ink-2">Add a file or create a module. Select a card to edit its source, then connect modules and use Build, Run or Test above.</div>}
          {cards.map((card) => <article key={card.id} aria-label={`Source card ${card.label}`} style={{ left: card.x, top: card.y, width: 210 }}
            className={`absolute rounded-lg border bg-surface-2 shadow-lg ${state.activePath === card.path ? 'border-primary' : 'border-line'}`}>
            <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
              <button type="button" aria-label={`Move ${card.label}`} title="Drag to move; arrow keys move the card" disabled={disabled} className="cursor-move touch-none rounded p-1 text-ink-3 hover:bg-surface-3"
                onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: card.id, startX: event.clientX, startY: event.clientY, x: card.x, y: card.y }; }}
                onPointerMove={(event) => { const current = drag.current; if (current?.id === card.id) setMoving({ id: card.id, x: Math.max(0, Math.min(20000, current.x + (event.clientX - current.startX) / zoom)), y: Math.max(0, Math.min(20000, current.y + (event.clientY - current.startY) / zoom)) }); }}
                onPointerUp={(event) => { const current = drag.current; if (current?.id === card.id) {
                  const x = Math.max(0, Math.min(20000, Math.round((current.x + (event.clientX - current.startX) / zoom) / 8) * 8));
                  const y = Math.max(0, Math.min(20000, Math.round((current.y + (event.clientY - current.startY) / zoom) / 8) * 8));
                  update(board.cards.map((entry) => entry.id === card.id ? { ...entry, x, y } : entry)); drag.current = null; setMoving(null);
                } }}
                onPointerCancel={() => { drag.current = null; setMoving(null); }}
                onKeyDown={(event) => { const delta = event.shiftKey ? 40 : 8;
                  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); update(board.cards.map((entry) => entry.id === card.id ? { ...entry,
                    x: Math.max(0, Math.min(20000, entry.x + (event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0))),
                    y: Math.max(0, Math.min(20000, entry.y + (event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0))) } : entry)); }
                }}><Move size={12} /></button>
              <button type="button" className="min-w-0 flex-1 truncate text-left text-xs font-medium text-ink" title={`Edit ${card.path}`} onClick={() => { void open(card.path); }}>{card.label}</button>
              <button type="button" disabled={disabled} className="rounded p-1 text-ink-3 hover:text-danger" aria-label={`Remove card ${card.label}`} title="Remove card; keep source file" onClick={() => update(board.cards.filter((entry) => entry.id !== card.id))}><Trash2 size={11} /></button>
            </div>
            <button type="button" className="block w-full truncate px-3 py-3 text-left font-mono text-[10px] text-ink-3 hover:text-primary" title={`Edit ${card.path}`} onClick={() => { void open(card.path); }}>{card.path}</button>
          </article>)}
        </div>
      </div>}
    </div>
    {board && cards.length > 0 && <div className="flex shrink-0 flex-col gap-2 border-t border-line p-3">
      {selected && <label className="flex items-center gap-2 text-[10px] text-ink-3">Card label<input aria-label="Card label" value={selected.label} maxLength={160} disabled={disabled} className={`${field} flex-1`}
        onChange={(event) => update(board.cards.map((card) => card.id === selected.id ? { ...card, label: event.target.value } : card))} /></label>}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <select aria-label="Dependency source" value={from} disabled={disabled} onChange={(event) => setFrom(event.target.value)} className={`${field} flex-1`}><option value="">Source…</option>{cards.map((card) => <option key={card.id} value={card.id}>{card.label}</option>)}</select>
        <select aria-label="Dependency module" value={to} disabled={disabled} onChange={(event) => setTo(event.target.value)} className={`${field} flex-1`}><option value="">Depends on…</option>{cards.filter((card) => card.id !== from).map((card) => <option key={card.id} value={card.id}>{card.label}</option>)}</select>
        <button type="button" className={button} disabled={disabled || !from || !to || from === to} onClick={async () => { setBusy(true); try { await actions.connectBoardCards({ from, to }); } finally { setBusy(false); } }}><Link2 size={12} />Connect</button>
      </div>
      {board.edges.length > 0 && <details className="text-[10px] text-ink-3"><summary className="cursor-pointer">{board.edges.length} connections</summary>
        <p className="my-1">Removing a connection keeps its source declaration.</p>
        <ul className="max-h-24 overflow-auto">{board.edges.map((edge) => <li key={`${edge.from}:${edge.to}`} className="flex items-center gap-2 py-1"><span className="min-w-0 flex-1 truncate">{cards.find((card) => card.id === edge.from)?.label} → {cards.find((card) => card.id === edge.to)?.label}</span><button type="button" disabled={disabled} aria-label={`Remove connection ${edge.from} to ${edge.to}`} onClick={() => actions.editBoard(board.cards, board.edges.filter((item) => item !== edge))}><Trash2 size={11} /></button></li>)}</ul>
      </details>}
    </div>}
  </section>;
}
