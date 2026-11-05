import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Plus, RefreshCw, Square, TriangleAlert } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { useShell } from '../shell';
import { current, getSnapshot, hasPendingSelection, refresh, restart, select, start, stop, subscribe } from './session';
import { terminalLabel } from './replay';

/** One detached screen per session: moving or hiding the pane never ends a process. */
export function TerminalPanel({ visible }: { visible: boolean }) {
  const { workspace } = useShell();
  const { selected: session, entries } = useSyncExternalStore(subscribe, getSnapshot);
  const mount = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const operation = useRef(0);
  const act = useCallback(async (action: () => Promise<unknown>) => {
    const ticket = ++operation.current; setBusy(true); setError('');
    try { await action(); }
    catch (failure) { if (ticket === operation.current) setError((failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')); }
    finally { if (ticket === operation.current) setBusy(false); }
  }, []);

  useEffect(() => { if (visible && !current() && !hasPendingSelection()) void act(() => start(workspace)); }, [act, visible, workspace]);

  // The host element belongs to the session, not React, and moves intact between dock/float.
  useEffect(() => {
    const container = mount.current;
    if (!container || !session) return;
    container.appendChild(session.host);
    const resize = () => { try { session.fit.fit(); } catch { /* Layout may not exist until the next observation. */ } };
    const observer = new ResizeObserver(resize); observer.observe(container); resize();
    if (visible && session.focusOnMount) session.term.focus();
    return () => { observer.disconnect(); if (session.host.parentElement === container) container.removeChild(session.host); };
  }, [session?.id, visible]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    const read = () => { void refresh().catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : String(failure)); }); };
    read(); const timer = window.setInterval(read, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [visible]);

  const info = session?.info;
  const isCommand = info?.kind === 'command';
  const finished = !!info?.exit;
  const status = info?.exit ? `Exited ${info.exit.code}` : session?.stopRequested ? 'Stopping…' : isCommand ? 'Running' : 'Shell';
  const control = 'shrink-0 rounded p-1.5 text-ink-3 transition hover:bg-surface-3 hover:text-ink disabled:opacity-40';

  return <div className="relative flex h-full min-h-0 flex-col bg-surface-0">
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b border-line-soft px-2 py-1.5">
      <select aria-label="Terminal session" value={session?.id ?? ''} disabled={busy} onChange={(event) => void act(() => select(event.target.value))}
        className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-xs text-ink outline-none focus-visible:ring-1 focus-visible:ring-primary">
        {!session && <option value="">Opening terminal…</option>}
        {entries.map((entry) => <option key={entry.id} value={entry.id}>{terminalLabel(entry)}</option>)}
      </select>
      <button type="button" onClick={() => void act(() => start(workspace))} disabled={busy} title="Open workspace shell" aria-label="Open workspace shell" className={control}><Plus size={13} /></button>
      {!isCommand && <button type="button" onClick={() => void act(restart)} disabled={busy || !session} title="Restart this shell" aria-label="Restart this shell" className={control}><RefreshCw size={12} /></button>}
      <button type="button" onClick={() => void act(() => stop(session?.id))} disabled={busy || !session || finished} title="Stop this process" aria-label="Stop this process" className={control}><Square size={12} /></button>
    </div>
    {info && <div className="shrink-0 border-b border-line-soft px-2.5 py-1.5">
      <div className="flex min-w-0 items-center gap-2 text-[10px] text-ink-3"><span className="shrink-0">{status}</span><span className="truncate font-mono" title={info.cwd}>{info.cwd}</span></div>
      {isCommand && <>
        <p className="mt-1 max-h-12 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[11px] text-ink-2">{info.command || 'Agent command'}</p>
        <p className="mt-1 text-[10px] leading-4 text-ink-3">{info.privateInput
          ? 'Private input used. Command output is withheld from the agent.'
          : 'Type directly for sudo or other prompts. Your input is never logged; typing keeps this command’s output private from the agent.'}</p>
      </>}
    </div>}
    {(error || session?.error) && <p role="alert" className="flex shrink-0 items-start gap-1.5 px-3 py-2 text-[11px] text-danger"><TriangleAlert size={12} className="mt-0.5 shrink-0" />{error || session?.error}</p>}
    <div ref={mount} className="min-h-0 flex-1 overflow-hidden px-1.5 py-1" onClick={() => session?.term.focus()} />
  </div>;
}
