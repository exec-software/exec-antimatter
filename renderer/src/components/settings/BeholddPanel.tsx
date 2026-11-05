import { useEffect, useRef, useState } from 'react';
import { CircleStop, FolderOpen, Play, Plug, RotateCw, TriangleAlert } from 'lucide-react';
import type { BeholddInfo, BeholddStatus, SourceKind } from '../../types';
import { AtomIndicator } from '../status/AtomIndicator';

interface Props {
  onUseAsSource: (prefill: { kind: SourceKind; baseUrl: string }) => void;
  active?: boolean;
}

const inputClass =
  'w-full rounded-md border border-line bg-surface-3 px-2.5 py-2 font-mono text-[11px] text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';

const formatBuilt = (value: string | undefined) => (value ? new Date(value).toLocaleString() : 'unknown');

export function BeholddPanel({ onUseAsSource, active = true }: Props) {
  const [info, setInfo] = useState<BeholddInfo | null>(null);
  const [status, setStatus] = useState<BeholddStatus | null>(null);
  const [configPath, setConfigPath] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('6768');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [infoError, setInfoError] = useState('');
  const [infoLoading, setInfoLoading] = useState(true);
  const [infoAttempt, setInfoAttempt] = useState(0);
  const edited = useRef({ configPath: false, host: false, port: false });

  useEffect(() => {
    let alive = true;
    setInfoLoading(true);
    setInfoError('');
    void window.electronAPI.beholdd.info().then((loaded) => {
      if (!alive) return;
      setInfo(loaded);
      if (!edited.current.configPath) setConfigPath(loaded.defaultConfigPath);
      if (!edited.current.host) setHost(loaded.defaultHost);
      if (!edited.current.port) setPort(String(loaded.defaultPort));
    }).catch(() => {
      if (alive) setInfoError('Could not read local engine information.');
    }).finally(() => { if (alive) setInfoLoading(false); });
    return () => { alive = false; };
  }, [infoAttempt]);

  // Poll while the panel is open so the status and log tail stay current.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = () => {
      window.electronAPI.beholdd.status().then((next) => {
        if (!cancelled) setStatus(next);
      }).catch(() => { if (!cancelled) setError('Could not read local engine status.'); });
    };
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active]);

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      setStatus(await window.electronAPI.beholdd.start({ configPath, host, port: Number(port) || undefined }));
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+':\s*/, ''));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError('');
    try {
      setStatus(await window.electronAPI.beholdd.stop());
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+':\s*/, ''));
    } finally {
      setBusy(false);
    }
  };

  /** Stop and start in one action, for a server that is up but wedged. */
  const reconnect = async () => {
    setBusy(true);
    setError('');
    try {
      setStatus(await window.electronAPI.beholdd.restart({ configPath, host, port: Number(port) || undefined }));
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+':\s*/, ''));
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    const chosen = await window.electronAPI.workspace.chooseFile({ title: 'Choose a beholdd config' });
    if (chosen) {
      edited.current.configPath = true;
      setConfigPath(chosen);
    }
  };

  const running = status?.running ?? false;
  const ready = status?.ready ?? false;
  const owned = status?.ownership === 'app';
  const external = status?.ownership === 'external';
  const manifest = info?.manifest ?? null;

  return (
    <div>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <AtomIndicator phase={ready ? 'streaming' : running ? 'thinking' : 'idle'} size={16} />
        Local beholdd server
      </h3>

      {info && !info.installed ? (
        external ? (
          <p className="mt-2 text-xs text-ink-3">
            Using a server that was already running. The bundled binary is not installed in this build.
          </p>
        ) : (
          <p className="mt-2 flex items-start gap-2 text-xs text-danger">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            Not vendored yet. Run <code className="font-mono">npm run deps:sync</code> to cut a release build and copy it to{' '}
            <code className="font-mono">{info.binaryPath}</code>.
          </p>
        )
      ) : (
        <p className="mt-1 text-xs text-ink-3">
          {manifest ? (
            <>
              v{manifest.version ?? '?'} · commit {manifest.commit ?? '?'}
              {manifest.dirty && ' (dirty tree)'} · built {formatBuilt(manifest.builtAt)}
            </>
          ) : (
            info ? 'Vendored build present.' : infoLoading ? 'Reading local engine information…' : 'Local engine information unavailable.'
          )}
        </p>
      )}

      <div className="mt-3 grid gap-2">
        <label className="text-[11px] uppercase tracking-wide text-ink-3">
          Config
          <span className="mt-1 flex gap-1.5">
            <input className={inputClass} value={configPath} onChange={(event) => { edited.current.configPath = true; setConfigPath(event.target.value); }} />
            <button
              type="button"
              onClick={browse}
              title="Choose a config file"
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink"
            >
              <FolderOpen size={13} />
              Browse
            </button>
          </span>
        </label>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-[11px] uppercase tracking-wide text-ink-3">
            Host
            <input className={`mt-1 ${inputClass}`} value={host} onChange={(event) => { edited.current.host = true; setHost(event.target.value); }} />
          </label>
          <label className="text-[11px] uppercase tracking-wide text-ink-3">
            Port
            <input className={`mt-1 ${inputClass}`} value={port} onChange={(event) => { edited.current.port = true; setPort(event.target.value); }} />
          </label>
        </div>
      </div>

      {info && (
        <p className="mt-2 text-[11px] text-ink-3">
          beholdd v2 uses its own strict config; the build ships an example at{' '}
          <code className="break-all font-mono">{info.exampleConfigPath}</code>. Supported models and GPU backends depend on the installed build and configuration.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!external && (
          <button
            type="button"
            onClick={owned ? stop : start}
            disabled={busy || (!owned && (info ? !info.installed : true))}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
              owned
                ? 'border border-danger/40 text-danger hover:bg-danger/10'
                : 'bg-primary text-on-primary hover:bg-primary-strong'
            }`}
          >
            {owned ? <CircleStop size={13} /> : <Play size={13} />}
            {owned ? 'Stop server' : 'Start server'}
          </button>
        )}

        {owned && (
          <button
            type="button"
            onClick={reconnect}
            disabled={busy}
            title="Stop the server and start it again"
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40"
          >
            <RotateCw size={13} />
            Restart server
          </button>
        )}

        {external && (
          <span className="rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-2">
            Externally managed
          </span>
        )}

        {ready && status?.port && (
          <button
            type="button"
            onClick={() => onUseAsSource({ kind: 'beholdd', baseUrl: `http://${status.host}:${status.port}/v1` })}
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-2 transition hover:border-primary/60 hover:text-ink"
          >
            <Plug size={13} />
            Use as source
          </button>
        )}

        <span className="text-[11px] text-ink-3">
          {external
            ? `ready · external · ${status?.host}:${status?.port}`
            : owned
              ? `${ready ? 'ready' : 'starting'} · pid ${status?.pid} · ${status?.host}:${status?.port}`
              : status?.lastExit
                ? `last exit: code ${status.lastExit.code ?? 'null'}${status.lastExit.signal ? ` (${status.lastExit.signal})` : ''}`
                : 'stopped'}
        </span>
      </div>

      {infoError && (
        <div role="alert" className="mt-2 flex items-center gap-2 text-[11px] text-danger">
          <span>{infoError}</span>
          <button type="button" onClick={() => setInfoAttempt((attempt) => attempt + 1)} disabled={infoLoading}
            className="text-ink-2 underline underline-offset-2 hover:text-ink disabled:opacity-40">Retry engine information</button>
        </div>
      )}
      {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}

      {status && status.logs.length > 0 && (
        <details className="mt-3"><summary className="cursor-pointer text-xs text-ink-3">Recent server logs</summary><pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-line-soft bg-surface-0 p-2 font-mono text-[10px] leading-relaxed text-ink-2">
          {status.logs.slice(-12).join('\n')}
        </pre></details>
      )}
    </div>
  );
}
