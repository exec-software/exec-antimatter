import { useEffect, useState, type CSSProperties } from 'react';
import { Expand, Maximize, Minimize, Minus, Pin, Shrink, X } from 'lucide-react';
import type { DesktopPreferencesAPI, DesktopWindowState, WindowAction } from '../../../../src/api/desktopPreferences';

export function WindowChrome() {
  const [state, setState] = useState<DesktopWindowState | null>(null);
  const [error, setError] = useState('');
  const api = (window.electronAPI as unknown as { desktop?: DesktopPreferencesAPI }).desktop;
  useEffect(() => {
    let alive = true;
    let revision = 0;
    const stop = api?.onWindowState((next) => { revision++; if (alive) setState(next); });
    const observed = revision;
    void api?.windowState().then((next) => { if (alive && revision === observed) setState(next); }).catch(() => {});
    return () => { alive = false; stop?.(); };
  }, [api]);
  if (!state?.customChrome) return null;
  const action = async (name: WindowAction) => {
    setError('');
    try { if (api) setState(await api.windowAction(name)); } catch { setError('Window action failed. Try again.'); }
  };
  const controls = <div className="flex h-full shrink-0 items-center" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
    <button type="button" aria-label="Always on top" aria-pressed={state.alwaysOnTop} title="Always on top"
      onClick={() => void action('toggle-always-on-top')} className={`h-full px-3 hover:bg-surface-3 ${state.alwaysOnTop ? 'text-primary' : 'text-ink-2'}`}><Pin size={13} /></button>
    <button type="button" aria-label={state.fullscreen ? 'Leave full screen' : 'Enter full screen'} onClick={() => void action('toggle-fullscreen')} className="h-full px-3 text-ink-2 hover:bg-surface-3">{state.fullscreen ? <Shrink size={13} /> : <Expand size={13} />}</button>
    <button type="button" aria-label="Minimize window" onClick={() => void action('minimize')} className="h-full px-3 text-ink-2 hover:bg-surface-3"><Minus size={14} /></button>
    <button type="button" aria-label={state.maximized ? 'Restore window' : 'Maximize window'} onClick={() => void action('toggle-maximize')} className="h-full px-3 text-ink-2 hover:bg-surface-3">{state.maximized ? <Minimize size={12} /> : <Maximize size={12} />}</button>
    <button type="button" aria-label="Close window" onClick={() => void action('close')} className="h-full px-3 text-ink-2 hover:bg-danger hover:text-on-danger"><X size={15} /></button>
  </div>;
  return <header className="flex h-8 shrink-0 items-center border-b border-line bg-surface-2 text-xs text-ink-2"
    style={{ WebkitAppRegion: 'drag' } as CSSProperties}
    onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest('button')) void action('toggle-maximize'); }}>
    {state.platform === 'darwin' && controls}
    <span className="min-w-0 flex-1 truncate px-3">Antimatter</span>
    {error && <span role="alert" className="px-3 text-danger">{error}</span>}
    {state.platform !== 'darwin' && controls}
  </header>;
}
