import { useEffect, useRef, useState } from 'react';
import { Gamepad2, Pause, Play, RotateCcw } from 'lucide-react';
import { registerPlugin } from '../registry';
import { DEFAULT_DOOM_GAME_ID, validateDoomSaves, type DoomAPI, type DoomRuntime, type DoomSession, type DoomWad } from '../../../../src/api/doom';
import { persistDoomSave, registerDoomSnapshot } from '../../lib/doomSaves';
import { DOOM_FRAME_HTML } from './frame';

export function DoomPanel() {
  const api = (window.electronAPI as unknown as { doom: DoomAPI }).doom;
  const [wad, setWad] = useState<DoomWad | null>(null);
  const [launch, setLaunch] = useState<{ engine: DoomRuntime; session: DoomSession; wad: DoomWad | null; channel: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  const alive = useRef(true);
  const saving = useRef(Promise.resolve());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!launch) return;
    const snapshots = new Map<string, { resolve(): void; reject(error: unknown): void }>();
    const stopSnapshots = running ? registerDoomSnapshot(() => new Promise<void>((resolve, reject) => {
      if (!frame.current?.contentWindow) { void saving.current.then(resolve, reject); return; }
      const id = crypto.randomUUID(); snapshots.set(id, { resolve, reject });
      frame.current.contentWindow.postMessage({ channel: launch.channel, kind: 'flush', detail: { id } }, '*');
    })) : () => {};
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      if (event.data.kind === 'ready') {
        frame.current?.contentWindow?.postMessage({ channel: launch.channel, kind: 'boot', detail: { engine: launch.engine, wad: launch.wad, saves: launch.session.saves } }, '*'); return;
      }
      if (event.data.channel !== launch.channel) return;
      if (event.data.kind === 'running') { setRunning(true); setPending(false); }
      if (event.data.kind === 'error') { setError(String(event.data.detail).slice(0, 500)); setPending(false); }
      if (event.data.kind === 'save' || event.data.kind === 'snapshot') {
        const snapshot = event.data.kind === 'snapshot' ? snapshots.get(event.data.detail?.id) : undefined;
        if (event.data.kind === 'snapshot' && !snapshot) return;
        try {
          const files = validateDoomSaves(snapshot ? event.data.detail.files : event.data.detail);
          if (!snapshot) setSaved('Saving game…');
          saving.current = persistDoomSave(launch.session.token, () => api.save(launch.session.token, files)).then(() => { snapshot?.resolve(); if (snapshot) snapshots.delete(event.data.detail.id); if (alive.current) { if (!snapshot) setSaved('Game saved.'); setError(''); } }).catch((failure) => { snapshot?.reject(failure); if (snapshot) snapshots.delete(event.data.detail.id); if (alive.current) { setSaved(''); setError(`Save failed: ${failure instanceof Error ? failure.message : 'Try saving again.'}`); } });
        } catch (failure) { snapshot?.reject(failure); if (snapshot) snapshots.delete(event.data.detail.id); setError('The engine returned an invalid save file.'); }
      }
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); stopSnapshots(); for (const snapshot of snapshots.values()) void saving.current.then(snapshot.resolve, snapshot.reject); snapshots.clear(); };
  }, [launch, api, running]);
  const start = async () => {
    setPending(true); setError(''); setSaved('');
    try {
      await saving.current;
      const engine = await api.runtime();
      const session = await api.openSession(wad?.gameId ?? DEFAULT_DOOM_GAME_ID);
      if (alive.current) setLaunch({ engine, session, wad, channel: crypto.randomUUID() });
    } catch (failure) { if (alive.current) { setPending(false); setError(failure instanceof Error ? failure.message : 'Could not load Doom.'); } }
  };
  const command = (kind: string) => frame.current?.contentWindow?.postMessage({ channel: launch?.channel, kind }, '*');
  return <section className="flex h-full min-h-0 flex-col bg-surface text-ink" aria-label="Doom">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line p-2 text-xs">
      {!launch ? <><button type="button" disabled={pending} onClick={() => void start()} className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-on-primary"><Play size={12} />Play</button>
        <button type="button" disabled={pending} className="rounded border border-line px-2 py-1" onClick={async () => { setError(''); try { const selected = await api.chooseWad(); if (selected) setWad(selected); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not read WAD.'); } }}>Choose IWAD</button>
        {wad && <button type="button" onClick={() => setWad(null)} className="text-ink-2">Use Freedoom</button>}</>
        : <><button type="button" disabled={!running} onClick={() => command('pause')} className="flex items-center gap-1 rounded border border-line px-2 py-1"><Pause size={12} />Pause / resume</button>
          <button type="button" disabled={!running} onClick={() => command('save-menu')} className="rounded border border-line px-2 py-1">Save</button>
          <button type="button" disabled={!running} onClick={() => command('load-menu')} className="rounded border border-line px-2 py-1">Load</button>
          <button type="button" disabled={pending} onClick={async () => { await saving.current; setLaunch(null); setRunning(false); setSaved(''); }} className="ml-auto flex items-center gap-1 text-ink-2"><RotateCcw size={12} />Exit game</button></>}
    </div>
    {launch ? <iframe ref={frame} key={launch.channel} title="Doom game" sandbox="allow-scripts allow-pointer-lock" allow="fullscreen; autoplay" allowFullScreen srcDoc={DOOM_FRAME_HTML} className="min-h-0 flex-1 border-0" />
      : <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center"><Gamepad2 size={36} className="text-primary" /><p className="text-sm">{wad?.name ?? 'Freedoom: Phase 2'}</p><p className="max-w-sm text-xs leading-5 text-ink-2">Play while your agent works. Use the bundled Freedoom game or choose your own Doom IWAD.</p></div>}
    <div className="shrink-0 border-t border-line p-2 text-[11px] text-ink-2"><p>Arrows: move · Ctrl: fire · Space: use · F2: save · F3: load</p><p>Saved games are kept on this computer. Save before closing the panel.</p>
      {pending && <p role="status">Starting game…</p>}{saved && <p role="status">{saved}</p>}{error && <p role="alert" className="text-danger">{error}</p>}
      {!launch && <p className="mt-1">Chocolate Doom (GPL-2.0-or-later) · Freedoom (BSD-3-Clause). Source and notices are included with the application.</p>}
    </div>
  </section>;
}
export const doomPlugin = registerPlugin({ id: 'doom', name: 'Doom', version: '1.0.0', description: 'Doom easter egg', toolWindows: [{ id: 'doom', title: 'Doom', icon: Gamepad2, anchor: 'right', defaultSize: 640, floatSize: { width: 720, height: 600 }, render: () => <DoomPanel /> }] });
