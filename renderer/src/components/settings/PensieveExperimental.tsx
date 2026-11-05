import { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, RefreshCw } from 'lucide-react';
import type { PensieveExperimentalState } from '../../../../src/api/pensieve';

const button = 'rounded-md border border-line px-3 py-2 text-xs text-ink-2 transition hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

export function pensieveStatusLabel(state: PensieveExperimentalState): string {
  switch (state.status) {
    case 'disabled': return 'Off';
    case 'enabled': return 'Enabled · ready for your next project conversation';
    case 'checking': return 'Checking memory and curriculum…';
    case 'ready': return 'On · persistent project memory';
    case 'error': return 'Needs attention';
  }
}

export function PensieveExperimental({ active = true }: { active?: boolean }) {
  const api = window.electronAPI.pensieve;
  const [state, setState] = useState<PensieveExperimentalState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<boolean | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    if (!api || !active) return;
    const request = ++sequence.current;
    setLoading(true);
    try {
      const next = await api.getState();
      if (mounted.current && request === sequence.current) { setState(next); setError(''); }
    } catch (cause) {
      if (mounted.current && request === sequence.current) setError(errorText(cause));
    } finally { if (mounted.current && request === sequence.current) setLoading(false); }
  }, [api, active]);
  useEffect(() => {
    mounted.current = true;
    if (!active) return () => { mounted.current = false; sequence.current++; };
    void reload();
    const unsubscribe = api?.onChanged((next) => {
      if (mounted.current) { sequence.current++; setState(next); setLoading(false); }
    });
    return () => { mounted.current = false; sequence.current++; unsubscribe?.(); };
  }, [api, active, reload]);
  const perform = async (enabled: boolean) => {
    if (!api || inFlight.current) return;
    inFlight.current = true; sequence.current++; setAction(enabled); setError('');
    try {
      const next = await api.setEnabled(enabled);
      if (mounted.current) { sequence.current++; setState(next); setLoading(false); }
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { inFlight.current = false; if (mounted.current) setAction(null); }
  };
  const busy = action !== null || loading || state?.status === 'checking';
  const issue = error || state?.error || state?.unavailableReason;
  return <section aria-label="Experimental Pensieve memory" className="rounded-xl border border-line bg-surface-2 p-4">
    <div className="mb-3 flex flex-wrap items-center gap-2"><Brain size={16} className="text-primary" /><h3 className="text-sm font-medium text-ink">Pensieve memory</h3><span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">Experimental · off by default</span></div>
    <div className="space-y-2 text-xs leading-5 text-ink-2">
      <p>Give project conversations a persistent memory of NIL, Ny, and Matrix references, observed results, and verified repairs.</p>
      <p>Each project has its own local memory. It is recalled into later conversations and survives application restarts. Turning this off keeps that memory for later use.</p>
    </div>
    <p role="status" aria-live="polite" className="mt-3 text-xs font-medium text-ink">{action === false ? 'Turning Pensieve off…' : state ? pensieveStatusLabel(state) : !api ? 'Pensieve controls are unavailable in this window.' : loading ? 'Reading memory status…' : 'Memory status is unavailable.'}</p>
    {state?.corpus && <dl className="mt-3 space-y-1 text-xs leading-5 text-ink-3">
      <div><dt className="inline">Curriculum: </dt><dd className="inline">{state.corpus.entryCount.toLocaleString('en-US')} entries · {state.corpus.languages.join(', ')}</dd></div>
      <div className="break-all"><dt className="inline">Corpus ID: </dt><dd className="inline font-mono text-[11px]">{state.corpus.id}</dd></div>
      {state.corpus.sdkVersion && <div className="break-all"><dt className="inline">SDK revision: </dt><dd className="inline font-mono text-[11px]">{state.corpus.sdkVersion}</dd></div>}
    </dl>}
    {state?.statistics && <p className="mt-2 text-xs text-ink-3">Last active project: {state.statistics.events.toLocaleString('en-US')} recorded events, {state.statistics.experiences.toLocaleString('en-US')} experiences, {state.statistics.repairs.toLocaleString('en-US')} verified repairs.</p>}
    {issue && <p role="alert" className="mt-3 text-xs leading-5 text-danger">{issue}</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      {state && !state.enabled && <button type="button" className={`${button} border-primary/40 bg-primary/10 text-primary hover:bg-primary/20`} disabled={!api || busy || !state.available} onClick={() => void perform(true)}>{action === true ? 'Enabling Pensieve…' : 'Enable Pensieve'}</button>}
      {state?.enabled && <button type="button" className={button} disabled={busy} onClick={() => void perform(false)}>Turn off Pensieve</button>}
      {state?.enabled && state.status === 'error' && <button type="button" className={button} disabled={busy} onClick={() => void perform(true)}>Retry memory check</button>}
      {api && <button type="button" className={`${button} inline-flex items-center gap-1.5`} disabled={busy} onClick={() => void reload()}><RefreshCw size={12} />Refresh status</button>}
    </div>
  </section>;
}
