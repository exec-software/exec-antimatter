import { useEffect, useState } from 'react';
import type { IdleCompactionPreferences, IdleCompactionState } from '../../../../src/api/idleCompaction';

export function IdleCompactionPanel() {
  const [state, setState] = useState<IdleCompactionState | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    const api = window.electronAPI.idleCompaction;
    void api.get().then((next) => { if (alive) setState(next); }).catch(() => { if (alive) setError('Could not load context settings.'); });
    const unsubscribe = api.onChanged((next) => { if (alive) setState(next); });
    return () => { alive = false; unsubscribe(); };
  }, []);
  const update = async (patch: Partial<IdleCompactionPreferences>) => {
    setSaving(true); setError('');
    try { setState(await window.electronAPI.idleCompaction.update(patch)); }
    catch { setError('Could not save context settings.'); }
    finally { setSaving(false); }
  };
  return <section className="space-y-3" aria-label="Idle compaction">
    <div><h3 className="text-sm font-medium text-ink">Idle compaction</h3>
      <p className="mt-1 text-xs text-ink-3">Summarize the active chat while you’re away. Uses the chat’s model and may incur provider charges. Visible messages stay intact.</p></div>
    {state && <>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={state.preferences.enabled} disabled={saving}
        onChange={(event) => { void update({ enabled: event.target.checked }); }} />Compact when idle</label>
      <div className="flex flex-wrap gap-4 text-xs text-ink-2">
        <label className="flex items-center gap-2">After <select className="rounded border border-line bg-surface-2 p-1" value={state.preferences.idleMinutes} disabled={saving}
          onChange={(event) => { void update({ idleMinutes: Number(event.target.value) }); }}>
          {[...new Set([1, 5, 10, 15, 30, 60, state.preferences.idleMinutes])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{value} min</option>)}
        </select></label>
        <label className="flex items-center gap-2">Minimum context <select className="rounded border border-line bg-surface-2 p-1" value={state.preferences.minimumTokens} disabled={saving}
          onChange={(event) => { void update({ minimumTokens: Number(event.target.value) }); }}>
          {[...new Set([2048, 8192, 16384, 32768, 65536, state.preferences.minimumTokens])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{value.toLocaleString()} tokens</option>)}
        </select></label>
      </div>
      <p className="text-xs text-ink-3" role="status">{state.phase === 'running' ? 'Compacting…' : state.phase === 'complete'
        ? `Compacted ${state.lastCompactedMessages} messages${state.lastCompletedAt ? ` at ${new Date(state.lastCompletedAt).toLocaleTimeString()}` : ''}.`
        : state.phase === 'off' ? 'Off' : state.phase === 'error' ? 'Compaction failed. Context was preserved.' : 'Waiting for idle time.'}</p>
    </>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </section>;
}
