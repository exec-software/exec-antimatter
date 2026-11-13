import { useEffect, useRef, useState } from 'react';
import type { ConnectionPlugin, ConnectionState } from '../../../../src/api/connections';

/** Shipped host plugins share the credential boundary and can be disabled independently. */
export function ConnectionPluginsPanel() {
  const [state, setState] = useState<ConnectionState | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const api = window.electronAPI.connections;
  const busyRef = useRef(false); const activeRef = useRef(false); const latestRevision = useRef(-1);
  const change = (next: ConnectionState) => { if (activeRef.current && next.revision >= latestRevision.current) { latestRevision.current = next.revision; setState(next); } };
  useEffect(() => { if (!api) { return; } let active = true;
    activeRef.current = true;
    const refresh = () => void api.get().then((next) => { if (active) { change(next); } }).catch(() => { if (active) { setError('Could not read built-in plugins.'); } });
    refresh(); const off = api.onChanged(refresh); return () => { active = false; activeRef.current = false; off(); };
  }, [api]);
  if (!api) { return null; }
  return <section aria-label="Built-in plugins" className="mb-5 space-y-2"><h2 className="text-sm font-medium">Built-in</h2>{error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {(['comms', 'email'] as ConnectionPlugin[]).map((id) => <div key={id} className="flex items-start gap-3 rounded border border-line bg-surface-2 p-3"><div className="min-w-0 flex-1"><h3 className="text-sm">{id === 'comms' ? 'Comms' : 'Email'}</h3><p className="mt-1 text-xs text-ink-3">{id === 'comms' ? 'Discord, Slack and Teams chats.' : 'Outlook, Google and Yahoo mail.'} Configure accounts from the sidebar. Agent access is granted per project; sending requires approval.</p></div>
      <label className="flex items-center gap-1 text-xs"><input aria-label={`Enable built-in ${id}`} type="checkbox" disabled={busy || !state} checked={state?.plugins[id] ?? false} onChange={(event) => { if (busyRef.current) { return; } busyRef.current = true; const enabled = event.target.checked; setBusy(true); setError(''); void api.enable(id, enabled).then(change).catch(() => { if (activeRef.current) { setError('Could not update the plugin.'); } }).finally(() => { busyRef.current = false; if (activeRef.current) { setBusy(false); } }); }} />Enabled</label></div>)}
  </section>;
}
