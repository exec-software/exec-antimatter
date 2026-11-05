import { useCallback, useEffect, useState } from 'react';
import { CircleStop, Cpu, Play, RotateCw, Server, TriangleAlert, Zap } from 'lucide-react';
import type { InferenceServerId, InferenceServerState } from '../../../../src/api/inferenceServers';
import type { ProviderConfig } from '../../types';

/**
 * Stop and restart the servers this app owns. The router here is the one that serves every
 * prepared workload, so this is where a crashed DeepSeek or Omni is brought back without
 * reselecting a model and hoping the port frees itself.
 */
const message = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
};

const uptime = (startedAt: number | null): string | null => {
  if (!startedAt) return null;
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};

/** The two bundled servers have their own marks; a unit-backed engine falls back to the generic. */
const ICONS: Partial<Record<InferenceServerId, typeof Cpu>> = {
  'bundled-beholdd': Cpu,
  'bundled-llama-vulkan': Zap,
};

/** A loopback engine Antimatter runs from a user systemd unit, rather than spawning itself. */
const isUnitEngine = (id: InferenceServerId): boolean => id.startsWith('engine:');

/** The sources these servers serve: the two bundled ones and every prepared workload. */
const isLocalEngineSource = (id: string): boolean =>
  id === 'bundled-beholdd' || id === 'bundled-llama-vulkan' || id.startsWith('workload-');

export function InferenceServersPanel({ active = true }: { active?: boolean }) {
  const [servers, setServers] = useState<InferenceServerState[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<InferenceServerId | null>(null);
  /** Set when an action was refused because a turn is in flight; offers the explicit override. */
  const [interrupt, setInterrupt] = useState<{ id: InferenceServerId; action: 'stop' | 'restart' } | null>(null);
  const [note, setNote] = useState('');
  const [sources, setSources] = useState<ProviderConfig[]>([]);
  const [current, setCurrent] = useState<{ providerId: string; modelId: string } | null>(null);
  const [switching, setSwitching] = useState('');

  const load = useCallback(() => {
    window.electronAPI.inferenceServers.list()
      .then((next) => { setServers(next); setError(''); })
      .catch((cause) => setError(message(cause)));
  }, []);

  const loadSelection = useCallback(() => {
    void Promise.all([
      window.electronAPI.providers.list().catch(() => [] as ProviderConfig[]),
      window.electronAPI.model.get().catch(() => null),
    ]).then(([configured, selected]) => {
      setSources(configured.filter((source) => isLocalEngineSource(source.id)));
      setCurrent(selected);
    });
  }, []);

  useEffect(() => { if (active) loadSelection(); }, [active, loadSelection]);

  // Poll while open so a server that exits on its own stops looking healthy here.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = () => {
      window.electronAPI.inferenceServers.list().then((next) => {
        if (!cancelled) { setServers(next); setError(''); }
      }).catch((cause) => { if (!cancelled) setError(message(cause)); });
    };
    tick();
    const timer = window.setInterval(tick, 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active]);

  const act = async (id: InferenceServerId, action: 'start' | 'stop' | 'restart', force = false) => {
    setBusy(id); setError(''); setNote(''); setInterrupt(null);
    try {
      const next = action === 'start'
        ? await window.electronAPI.inferenceServers.start(id)
        : action === 'stop'
          ? await window.electronAPI.inferenceServers.stop(id, { force })
          : await window.electronAPI.inferenceServers.restart(id, { force });
      setServers(next);
      setNote(action === 'stop' ? 'Server stopped.' : action === 'start' ? 'Server started.' : 'Server restarted.');
    } catch (cause) {
      setError(message(cause));
      // Only a refusal naming an in-flight turn offers the override, so a genuine failure
      // (a missing model file, an occupied port) never turns into "try harder".
      if (/serving a request/.test(message(cause)) && action !== 'start') setInterrupt({ id, action });
      load();
    } finally {
      setBusy(null);
    }
  };

  /**
   * Selection only remembers a choice. The first request performs the engine transition and
   * refuses to abandon a source that is mid-request. Nothing here reaches for a process directly.
   */
  const switchTo = async (providerId: string, modelId: string) => {
    setSwitching(providerId); setError(''); setNote('');
    try {
      setCurrent(await window.electronAPI.model.set(providerId, modelId));
      setNote('Backend selected. Its model loads when you send a message.');
      load();
    } catch (cause) { setError(message(cause)); }
    finally { setSwitching(''); }
  };

  if (!servers) {
    return <p role="status" className="text-xs text-ink-3">{error || 'Reading inference server status…'}</p>;
  }

  return <div className="space-y-3">
    <p className="text-xs leading-5 text-ink-2">
      These servers run on this computer and are started by Antimatter. Restart one that is running
      but no longer answering; the router comes back bound to the same workload. The engines listed
      from a source start on the first request that needs them, and are released when this window
      closes — stopping one here simply hands its memory back until the next request.
    </p>
    {error && <p role="alert" className="flex items-start gap-2 text-xs text-danger"><TriangleAlert size={13} className="mt-0.5 shrink-0" />{error}</p>}
    {note && !error && <p role="status" className="text-xs text-accent">{note}</p>}

    {servers.map((server) => {
      const Icon = ICONS[server.id] ?? Server;
      const external = server.ownership === 'external';
      const acting = busy === server.id;
      const state = server.statusError !== null ? 'status unavailable'
        : external ? 'managed outside Antimatter'
          : server.ready ? 'ready'
            : server.running ? 'starting' : 'stopped';
      const age = uptime(server.startedAt);
      return <article key={server.id} className="rounded-lg border border-line bg-surface-2 p-3.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h4 className="flex items-center gap-1.5 text-sm font-medium text-ink"><Icon size={14} className="text-ink-3" />{server.name}</h4>
          <span className={`text-[11px] ${server.statusError !== null ? 'text-danger' : server.ready ? 'text-success' : server.running ? 'text-ink-2' : 'text-ink-3'}`}>
            {state}{server.busy ? ' · serving a request' : ''}
          </span>
        </div>
        <p className="mt-1 text-xs leading-5 text-ink-3">{server.role}</p>
        {server.statusError !== null && <p role="alert" className="mt-2 flex items-start gap-2 text-xs text-danger">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />{server.statusError}
        </p>}

        <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-[11px] text-ink-3">
          {server.endpoint && <><dt>Endpoint</dt><dd className="font-mono text-ink-2">{server.endpoint}</dd></>}
          {server.running && server.pid !== null && <><dt>Process</dt><dd className="font-mono text-ink-2">pid {server.pid}{age ? ` · up ${age}` : ''}</dd></>}
          {server.sourceName && <><dt>Serving</dt><dd className="text-ink-2">{server.sourceName}</dd></>}
          {server.detail && <><dt>Loaded</dt><dd className="break-all font-mono text-ink-2">{server.detail}</dd></>}
        </dl>

        {server.lastExit && !server.running && <p className="mt-2 text-[11px] text-ink-3">
          Last exit: {server.lastExit.signal ? `signal ${server.lastExit.signal}` : `code ${server.lastExit.code}`} at {new Date(server.lastExit.at).toLocaleTimeString()}
        </p>}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!server.running && <button type="button" disabled={acting || external || !server.startable || server.statusError !== null}
            onClick={() => void act(server.id, 'start')}
            title={server.startable ? undefined : 'No workload is set up and no packaged checkpoint is available for this server.'}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-on-primary disabled:opacity-50">
            <Play size={12} />{acting ? 'Starting…' : 'Start server'}
          </button>}
          {server.running && <button type="button" disabled={acting || external || server.statusError !== null}
            onClick={() => void act(server.id, 'stop')}
            className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-ink-2 hover:text-ink disabled:opacity-50">
            <CircleStop size={12} />{acting ? 'Stopping…' : 'Stop server'}
          </button>}
          {server.running && !isUnitEngine(server.id) && <button type="button" disabled={acting || external || server.statusError !== null}
            onClick={() => void act(server.id, 'restart')} title="Stop the server and start it again"
            className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-ink-2 hover:text-ink disabled:opacity-50">
            <RotateCw size={12} />{acting ? 'Restarting…' : 'Restart server'}
          </button>}
          {interrupt?.id === server.id && <button type="button" disabled={acting}
            onClick={() => void act(server.id, interrupt.action, true)}
            className="flex items-center gap-1.5 rounded-md border border-danger/50 px-3 py-1.5 text-xs text-danger disabled:opacity-50">
            <TriangleAlert size={12} />{interrupt.action === 'stop' ? 'Stop anyway' : 'Restart anyway'}
          </button>}
        </div>

        {server.logs.length > 0 && <details className="mt-3">
          <summary className="cursor-pointer text-[11px] text-ink-3 hover:text-ink">Recent log output</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-3 p-2 text-[10px] leading-4 text-ink-3">{server.logs.join('\n')}</pre>
        </details>}
      </article>;
    })}

    {sources.length > 1 && <section className="rounded-lg border border-line bg-surface-2 p-3.5">
      <h4 className="text-sm font-medium text-ink">Switch backend</h4>
      <p className="mt-1 text-xs leading-5 text-ink-3">
        Choose which local backend chat uses. Switching retires the one it replaces, so the same
        weights are never resident in two engines at once. The new backend loads on its first
        request, not now.
      </p>
      <ul className="mt-2.5 space-y-1.5">
        {sources.map((source) => {
          const model = source.models[0];
          const selected = current?.providerId === source.id;
          return <li key={source.id} className="flex flex-wrap items-center gap-2">
            <span className={`flex-1 text-xs ${selected ? 'text-ink' : 'text-ink-2'}`}>
              {source.name}
              {selected && <span className="ml-2 text-[11px] text-success">in use</span>}
            </span>
            <button type="button"
              disabled={selected || !model || switching !== '' || busy !== null}
              onClick={() => model && void switchTo(source.id, model.id)}
              title={model ? undefined : 'This source has no model card yet.'}
              className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-2 hover:text-ink disabled:opacity-40">
              {switching === source.id ? 'Switching…' : selected ? 'Active' : 'Use this'}
            </button>
          </li>;
        })}
      </ul>
    </section>}
  </div>;
}
