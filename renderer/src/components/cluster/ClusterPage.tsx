import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Cpu, Link, Play, RefreshCw, RotateCcw, Server, Square, X } from 'lucide-react';
import type { ClusterAPI, ClusterEngine, ClusterEngineAction, ClusterNode, ClusterSnapshot } from '../../../../src/api/cluster';
import { ConfirmDialog } from '../ConfirmDialog';

const button = 'inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-2 hover:bg-surface-3 disabled:opacity-40';
const bytes = (value: number | null | undefined) => value == null ? '—' : value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
const percent = (value: number | null | undefined) => value == null ? '—' : `${Math.round(value * 100)}%`;
const uptime = (value: number | null | undefined) => value == null ? '—' : value >= 86400 ? `${Math.floor(value / 86400)}d ${Math.floor(value % 86400 / 3600)}h` : `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m`;

function Meter({ label, used, total }: { label: string; used: number | null | undefined; total: number | null | undefined }) {
  const ratio = used != null && total != null && total > 0 ? Math.min(1, Math.max(0, used / total)) : null;
  return <div className="min-w-0"><p className="flex justify-between gap-2 text-xs"><span className="text-ink-3">{label}</span><span className="text-ink-2">{bytes(used)} / {bytes(total)}</span></p>
    <div className="mt-2 h-1.5 overflow-hidden rounded bg-surface-3"><div className="h-full bg-accent" style={{ width: `${(ratio ?? 0) * 100}%` }} /></div>
  </div>;
}

export function ClusterPage({ api, onClose, onOpenPairing }: { api: ClusterAPI; onClose(): void; onOpenPairing(): void }) {
  const [snapshot, setSnapshot] = useState<ClusterSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ node: ClusterNode; engine: ClusterEngine; action: 'stop' | 'restart' } | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true; setLoading(true);
    try { const next = await api.snapshot(); if (alive.current) { setSnapshot(next); setError(''); } }
    catch { if (alive.current) setError('Could not refresh the cluster.'); }
    finally { pending.current = false; if (alive.current) setLoading(false); }
  }, [api]);
  useEffect(() => {
    alive.current = true; void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive.current = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  const action = async (node: ClusterNode, engine: ClusterEngine, action: ClusterEngineAction['action']) => {
    setConfirm(null); setBusy(`${node.key}:${engine.id}`); setError('');
    try {
      const engines = await api.action(node.key, { requestId: crypto.randomUUID(), serverId: engine.id, action, force: action !== 'start' && engine.busy });
      if (alive.current) setSnapshot((current) => current ? { ...current, nodes: current.nodes.map((item) => item.key === node.key ? { ...item, engines } : item) } : current);
      await refresh();
    } catch (cause) { if (alive.current) setError((cause instanceof Error ? cause.message : 'The engine action failed.').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')); }
    finally { if (alive.current) setBusy(null); }
  };
  return <div className="absolute inset-0 flex flex-col bg-surface">
    <header className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3"><Server size={17} className="text-primary" /><h1 className="mr-auto text-sm font-semibold">Cluster</h1>
      <button type="button" className={button} onClick={onOpenPairing}><Link size={13} />Pair nodes</button>
      <button type="button" className={button} disabled={loading} onClick={() => void refresh()}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} />Refresh</button>
      <button type="button" className={button} onClick={onClose}><X size={13} />Done</button></header>
    <div className="min-h-0 flex-1 overflow-y-auto p-5"><div className="mx-auto max-w-6xl space-y-5">
      <p className="text-xs text-ink-3">Paired nodes share only the permissions granted during pairing. Engine controls apply to servers managed by Antimatter.</p>
      {error && <p role="alert" className="rounded border border-danger/40 bg-danger/5 p-3 text-xs text-danger">{error}</p>}
      {!snapshot && <p role="status" className="text-sm text-ink-3">{loading ? 'Reading cluster…' : 'No cluster data available.'}</p>}
      <div className="grid gap-4 xl:grid-cols-2">{snapshot?.nodes.map((node) => <article key={node.key} className="rounded-xl border border-line bg-surface-2 p-4">
        <header className="flex flex-wrap items-center gap-2"><Server size={16} className="text-primary" /><h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{node.name}</h2>
          <span className="text-[11px] text-ink-3">{node.local ? 'This computer' : Object.keys(node.errors).length ? 'Connection issue' : 'Connected'}</span></header>
        {!node.local && <p className="mt-1 break-all font-mono text-[11px] text-ink-3">{node.key}</p>}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div><p className="flex items-center gap-1.5 text-xs text-ink-3"><Cpu size={13} />CPU</p><p className="mt-1 text-lg text-ink">{percent(node.vitals?.cpuUsage)} <span className="text-xs text-ink-3">{node.vitals?.cpuCores == null ? '' : `${node.vitals.cpuCores} cores`}</span></p></div>
          <div><p className="flex items-center gap-1.5 text-xs text-ink-3"><Activity size={13} />Uptime</p><p className="mt-1 text-lg text-ink">{uptime(node.vitals?.uptimeSeconds)}</p></div>
          <Meter label="Memory" used={node.vitals?.memoryUsed} total={node.vitals?.memoryTotal} />
          <div><p className="text-xs text-ink-3">Network</p><p className="mt-1 text-xs text-ink-2">↓ {bytes(node.vitals?.networkRx)}/s · ↑ {bytes(node.vitals?.networkTx)}/s</p></div>
        </div>
        {node.vitals?.gpus.map((gpu, index) => <div key={index} className="mt-4 border-t border-line pt-3"><p className="mb-2 flex flex-wrap justify-between gap-2 text-xs"><span className="text-ink">{gpu.name}</span><span className="text-ink-3">{percent(gpu.usage)} · {gpu.celsius == null ? '—' : `${gpu.celsius.toFixed(0)}°C`} · {gpu.watts == null ? '—' : `${gpu.watts.toFixed(0)} W`}</span></p><Meter label="GPU memory" used={gpu.memoryUsed} total={gpu.memoryTotal} /></div>)}
        {!node.vitals && node.report?.accelerators.map((gpu, index) => <div key={index} className="mt-3"><Meter label={gpu.name} used={gpu.memoryTotal != null && gpu.memoryFree != null ? gpu.memoryTotal - gpu.memoryFree : null} total={gpu.memoryTotal} /></div>)}
        {!node.scopes.includes('vitals') && <p className="mt-3 text-xs text-ink-3">Detailed vitals require a new pairing with vitals access.</p>}
        {node.vitals && node.vitals.disks.length > 0 && <details className="mt-3 text-xs text-ink-3"><summary className="cursor-pointer">Storage</summary><div className="mt-3 space-y-3">{node.vitals.disks.map((disk, index) => <Meter key={index} label={`Volume ${index + 1}`} used={disk.used} total={disk.total} />)}</div></details>}
        {Object.entries(node.errors).map(([kind, message]) => <p key={kind} role="status" className="mt-3 text-xs text-danger">{message}</p>)}
        <section className="mt-4 border-t border-line pt-3" aria-label={`Engines on ${node.name}`}><h3 className="mb-2 text-xs font-medium text-ink">Engines</h3>
          {!node.scopes.includes('manage-engines') ? <p className="text-xs text-ink-3">Engine control was not granted. Pair again on this node to enable it.</p>
            : node.engines?.length === 0 ? <p className="text-xs text-ink-3">No registered engines.</p> : node.engines?.map((engine) => <div key={engine.id} className="flex flex-wrap items-center gap-2 border-b border-line-soft py-2 last:border-0">
              <div className="min-w-0 flex-1"><p className="truncate text-xs text-ink">{engine.name}</p><p className="text-[10px] text-ink-3">{engine.busy ? 'Serving active work' : engine.ready ? 'Ready' : engine.running ? 'Starting' : 'Stopped'}{engine.ownership === 'external' ? ' · externally managed' : ''}</p></div>
              {engine.running ? <><button type="button" className={button} disabled={!!busy || engine.ownership !== 'app'} onClick={() => setConfirm({ node, engine, action: 'restart' })}><RotateCcw size={12} />Restart</button><button type="button" className={button} disabled={!!busy || engine.ownership !== 'app'} onClick={() => setConfirm({ node, engine, action: 'stop' })}><Square size={12} />Stop</button></>
                : <button type="button" className={button} disabled={!!busy || !engine.startable || engine.ownership === 'external'} onClick={() => void action(node, engine, 'start')}><Play size={12} />Start</button>}
            </div>)}
        </section>
        {!!node.report?.checkpoints.length && <details className="mt-3 text-xs text-ink-3"><summary className="cursor-pointer">Prepared checkpoints · {node.report.checkpoints.length}</summary><ul className="mt-2 space-y-1">{node.report.checkpoints.map((checkpoint) => <li key={checkpoint.id} className="flex justify-between gap-2"><span className="truncate">{checkpoint.name}</span><span>{bytes(checkpoint.bytes)}</span></li>)}</ul></details>}
        <p className="mt-3 text-[10px] text-ink-3">Updated {new Date(node.vitals?.observedAt ?? node.report?.observedAt ?? node.updatedAt).toLocaleTimeString()}</p>
      </article>)}</div>
      {snapshot?.nodes.length === 1 && <p className="text-sm text-ink-3">Pair another computer to manage it here.</p>}
      {!!snapshot?.actions.length && <details className="rounded-lg border border-line p-4 text-xs text-ink-2"><summary className="cursor-pointer">Actions this session</summary><ul className="mt-3 space-y-2">{snapshot.actions.map((entry, index) => <li key={index}>{new Date(entry.at).toLocaleTimeString()} · {entry.node} · {entry.action} {entry.serverId} · {entry.outcome}{entry.forced ? ' · interruption allowed' : ''}</li>)}</ul></details>}
    </div></div>
    {confirm && <ConfirmDialog title={`${confirm.action === 'stop' ? 'Stop' : 'Restart'} ${confirm.engine.name}?`}
      message={`${confirm.node.name}: ${confirm.engine.busy ? 'This will interrupt active work on this engine.' : 'The engine will be unavailable while this action runs.'}`}
      confirmLabel={confirm.engine.busy ? `Interrupt and ${confirm.action}` : confirm.action === 'stop' ? 'Stop engine' : 'Restart engine'} tone={confirm.engine.busy ? 'danger' : 'default'}
      onCancel={() => setConfirm(null)} onConfirm={() => void action(confirm.node, confirm.engine, confirm.action)} />}
  </div>;
}
