import { useEffect, useState } from 'react';
import type { WorkloadView } from '../../../../src/api/workloads';
import { setupError } from '../settings/AssistantPanel';

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

export function WorkloadCatalog({ onOpenModels, onOpenServers }: {
  onOpenModels?: () => void;
  /** Offered once a workload is set up: where its server is stopped and restarted. */
  onOpenServers?: () => void;
}) {
  const [workloads, setWorkloads] = useState<WorkloadView[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [peers, setPeers] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  useEffect(() => {
    let cancelled = false;
    const refresh = () => window.electronAPI.workloads.list().then((items) => {
      if (!cancelled) { setWorkloads(items); setError(''); }
    }).catch((cause) => { if (!cancelled) setError(setupError(cause)); });
    void refresh();
    const unsubscribe = window.electronAPI.onHubDownloads(() => { void refresh(); });
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  const download = async (id: string) => {
    setBusy(id); setError('');
    try { setWorkloads(await window.electronAPI.workloads.download(id)); }
    catch (cause) { setError(setupError(cause)); }
    finally { setBusy(null); }
  };
  const configure = async (workload: WorkloadView) => {
    setBusy(workload.id); setError(''); setNote('');
    try {
      const configuredPeers = (peers[workload.id] ?? workload.deployment?.peers.join(', ') ?? '').split(',').map((peer) => peer.trim()).filter(Boolean);
      setWorkloads(await window.electronAPI.workloads.configure(workload.id, configuredPeers));
      setNote(`${workload.name} is set up. Select its source and model in the Model Library when you are ready to use it. Its server starts on the first request.`);
    } catch (cause) { setError(setupError(cause)); }
    finally { setBusy(null); }
  };
  return <div className="space-y-3">
    <p className="text-sm leading-relaxed text-ink-2">Choose a prepared workload for your hardware, or keep your current model. Each download pins the repository revision and verifies every file with SHA-256. Downloads continue after setup closes.</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {note && <p role="status" className="text-sm text-accent">{note}</p>}
    {!workloads.length && !error && <p role="status" className="text-sm text-ink-3">Loading workloads…</p>}
    {workloads.map((workload) => {
      const downloadState = workload.download;
      const downloading = downloadState?.state === 'queued' || downloadState?.state === 'downloading';
      const ready = downloadState?.state === 'ready';
      return <article key={workload.id} className="rounded-lg border border-line bg-surface-2 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-medium text-ink">{workload.name}</h3><span className="text-xs text-ink-3">{workload.quantization} · {gib(workload.bytes)}</span></div>
        <p className="mt-1 text-sm text-ink-2">{workload.description}</p>
        {workload.modalities?.length ? <p className="mt-1.5 text-xs text-accent">
          Reads {workload.modalities.join(' and ')} as well as text
          {workload.projector ? ', through a projector file downloaded beside the weights' : ''}.
        </p> : null}
        <p className="mt-2 text-xs font-medium text-ink">{workload.engine}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-3">{workload.hardware}</p>
        <details className="mt-2 text-xs text-ink-3"><summary className="cursor-pointer text-accent">Validation and provenance</summary>
          <p className="mt-2 leading-relaxed">{workload.evidence}</p>
          <p className="mt-1 break-all">{workload.repoId}<br />Revision {workload.revision}</p>
          <ul className="mt-1 space-y-0.5">
            {[...workload.files, ...(workload.projector ? [workload.projector.file] : [])].map((file) => (
              <li key={file.path} className="break-all">{file.path} · {gib(file.size)}</li>
            ))}
          </ul>
        </details>
        {downloadState && <div className="mt-3" role="status">
          <div className="flex justify-between text-xs text-ink-2"><span>{ready ? 'Download verified' : downloadState.state === 'failed' ? 'Download failed' : downloadState.state === 'paused' ? 'Paused' : downloadState.state === 'queued' ? 'Queued' : 'Downloading'}</span><span>{gib(downloadState.bytesDone)} / {gib(workload.bytes)}</span></div>
          <progress className="mt-1 h-1.5 w-full accent-primary" max={workload.bytes} value={downloadState.bytesDone} aria-label={`${workload.name} download progress`} />
          {downloadState.error && <p className="mt-1 text-xs text-danger">{downloadState.error}</p>}
        </div>}
        {ready && <label className="mt-3 block">
          <span className="mb-1 block text-xs text-ink-2">GPU peers {workload.requiresPeers ? '(required for this setup)' : '(optional)'}</span>
          <input className="w-full rounded-md border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink placeholder:text-ink-3" value={peers[workload.id] ?? workload.deployment?.peers.join(', ') ?? ''}
            onChange={(event) => setPeers((current) => ({ ...current, [workload.id]: event.target.value }))} placeholder="gpu-host:50052, another-host:50052" disabled={busy !== null} />
          {workload.requiresPeers && <p className="mt-1 text-xs text-ink-3">Start the matching llama.cpp RPC runtime on each peer first. Use machines on a trusted local network.</p>}
        </label>}
        <div className="mt-3 flex gap-2">
          {!ready && <button type="button" onClick={() => void download(workload.id)} disabled={busy !== null || downloading}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-on-primary disabled:opacity-50">
            {busy === workload.id ? 'Queuing…' : downloadState?.state === 'downloading' ? 'Downloading…' : downloading ? 'Download queued' : downloadState ? 'Resume download' : `Download ${gib(workload.bytes)}`}
          </button>}
          {ready && <button type="button" disabled={busy !== null || (workload.requiresPeers && !(peers[workload.id] ?? workload.deployment?.peers.join(', ') ?? '').trim())}
            onClick={() => void configure(workload)} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-on-primary disabled:opacity-50">
            {busy === workload.id ? 'Setting up…' : workload.deployment ? 'Update workload setup' : 'Set up workload'}
          </button>}
          {ready && onOpenModels && <button type="button" onClick={onOpenModels} className="rounded-md border border-line px-3 py-1.5 text-xs text-accent">Open Model Library</button>}
          {workload.deployment && onOpenServers && <button type="button" onClick={onOpenServers} className="rounded-md border border-line px-3 py-1.5 text-xs text-accent">Manage its server</button>}
        </div>
      </article>;
    })}
    {onOpenModels && <button type="button" onClick={onOpenModels} className="text-xs text-accent hover:underline">Use an existing model or connect a provider</button>}
  </div>;
}
