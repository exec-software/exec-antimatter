import { CircleAlert, CircleCheck, Clock, MessageSquare, Pause, Play, RotateCw, Trash2, X } from 'lucide-react';
import type { HubDownload, HubRegistration, ProviderConfig } from '../../types';
import { AtomIndicator } from '../status/AtomIndicator';
import { bytes, rate, remaining, usableTarget } from './presentation';

interface Props {
  record: HubDownload;
  providers: ProviderConfig[];
  onPause(id: string): void;
  onResume(id: string): void;
  onCancel(record: HubDownload): void;
  onRemove(record: HubDownload): void;
  onReregister(id: string): void;
  onUse(providerId: string, modelId: string): void;
}

const button =
  'flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40';

const PHASE_LABEL: Record<string, string> = {
  checking: 'Checking the partial download…',
  transferring: 'Downloading',
  finishing: 'Verifying and finishing…',
  registering: 'Registering with engines…',
};

function stateLine(record: HubDownload): string {
  switch (record.state) {
    case 'queued':
      return record.bytesDone > 0 ? 'Queued — resumes where it stopped' : 'Queued';
    case 'paused':
      return 'Paused';
    case 'failed':
      return 'Failed';
    case 'ready':
      return record.phase === 'registering' ? PHASE_LABEL.registering : 'Downloaded and verified';
    default:
      return PHASE_LABEL[record.phase ?? 'transferring'] ?? 'Downloading';
  }
}

const REGISTRATION_TONE: Record<HubRegistration['status'], string> = {
  registered: 'border-accent/40 text-accent',
  pending: 'border-primary/40 text-primary',
  unsupported: 'border-line text-ink-3',
  failed: 'border-danger/40 text-danger',
};

const REGISTRATION_LABEL: Record<HubRegistration['status'], string> = {
  registered: 'ready',
  pending: 'pending',
  unsupported: 'cannot run it',
  failed: 'failed',
};

export function DownloadCard({ record, providers, onPause, onResume, onCancel, onRemove, onReregister, onUse }: Props) {
  const fraction = record.bytesTotal ? Math.min(1, record.bytesDone / record.bytesTotal) : 0;
  const running = record.state === 'downloading';
  const target = record.state === 'ready' ? usableTarget(record, providers) : null;
  const [owner, name] = record.repoId.split('/');
  const eta = running && record.phase === 'transferring' ? remaining(record.bytesTotal - record.bytesDone, record.bytesPerSecond) : null;
  const anyFailed = record.registrations.some((entry) => entry.status === 'failed');

  return (
    // min-w-0: a card sits in a grid, and without it one long model path widens every card past the page.
    <div className="min-w-0 rounded-xl border border-line bg-surface-2 p-3" data-download={record.id}>
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <AtomIndicator phase={record.phase === 'transferring' ? 'streaming' : 'thinking'} size={14} />
        ) : record.state === 'ready' ? (
          <CircleCheck size={14} className="shrink-0 text-accent" />
        ) : record.state === 'failed' ? (
          <CircleAlert size={14} className="shrink-0 text-danger" />
        ) : (
          <Clock size={14} className="shrink-0 text-ink-3" />
        )}
        <span className="min-w-0 truncate text-sm text-ink">
          <span className="text-ink-3">{owner}/</span>
          <span className="font-semibold">{name}</span>
        </span>
        <span className="rounded-md border border-line bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">{record.label}</span>
        {record.role === 'projector' && <span className="text-[10px] uppercase tracking-wide text-ink-3">vision projector</span>}

        <div className="ml-auto flex items-center gap-1">
          {target && (
            <button
              type="button"
              onClick={() => onUse(target.providerId, target.modelId)}
              className="flex items-center gap-1.5 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-on-primary transition hover:bg-primary-strong"
            >
              <MessageSquare size={12} />
              Use in chat
            </button>
          )}
          {(record.state === 'downloading' || record.state === 'queued') && (
            <button type="button" onClick={() => onPause(record.id)} className={button}>
              <Pause size={12} />
              Pause
            </button>
          )}
          {record.state === 'paused' && (
            <button type="button" onClick={() => onResume(record.id)} className={button}>
              <Play size={12} />
              Resume
            </button>
          )}
          {record.state === 'failed' && (
            <button type="button" onClick={() => onResume(record.id)} className={button}>
              <RotateCw size={12} />
              Retry
            </button>
          )}
          {record.state === 'ready' && anyFailed && (
            <button type="button" onClick={() => onReregister(record.id)} className={button} title="Try registering it with the engines again">
              <RotateCw size={12} />
              Register again
            </button>
          )}
          {record.state === 'ready' ? (
            <button
              type="button"
              onClick={() => onRemove(record)}
              title="Remove this model"
              aria-label={`Remove ${record.repoId} ${record.label}`}
              className="rounded-md border border-danger/30 px-2 py-1 text-[11px] text-danger transition hover:border-danger/60 hover:bg-danger/10"
            >
              <Trash2 size={12} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onCancel(record)}
              title="Cancel and delete what was downloaded"
              aria-label={`Cancel ${record.repoId} ${record.label}`}
              className="rounded-md border border-danger/30 px-2 py-1 text-[11px] text-danger transition hover:border-danger/60 hover:bg-danger/10"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {record.state !== 'ready' && (
        <div className="mt-2">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-surface-3"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-300 ${
                record.state === 'failed' ? 'bg-danger/70' : record.state === 'downloading' ? 'bg-primary' : 'bg-ink-3'
              }`}
              style={{ width: `${fraction * 100}%` }}
            />
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-2">
            <span>{stateLine(record)}</span>
            <span className="font-mono text-ink-3">
              {bytes(record.bytesDone)} / {bytes(record.bytesTotal)} · {Math.floor(fraction * 100)}%
            </span>
            {running && record.bytesPerSecond ? <span className="font-mono text-ink-3">{rate(record.bytesPerSecond)}</span> : null}
            {eta && <span className="text-ink-3">{eta}</span>}
          </p>
        </div>
      )}

      {record.error && (
        <p className={`mt-1.5 text-[11px] ${record.state === 'failed' ? 'text-danger' : 'text-primary'}`}>{record.error}</p>
      )}

      {record.state === 'ready' && (
        <div className="mt-2 space-y-1">
          <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-ink-3">
            <span className="font-mono">{bytes(record.bytesTotal)}</span>
            {record.architecture && <span>{record.architecture}</span>}
            {record.contextLength ? <span>{Math.round(record.contextLength / 1000)}k trained context</span> : null}
          </p>
          {record.path && (
            <p className="truncate font-mono text-[11px] text-ink-3" title={record.path}>
              {record.path}
            </p>
          )}
          {record.registrations.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {record.registrations.map((entry) => (
                <span
                  key={`${entry.target}:${entry.sourceId ?? 'bundled'}`}
                  title={entry.detail ?? (entry.modelId ? `Model id: ${entry.modelId}` : undefined)}
                  className={`rounded-md border px-2 py-0.5 text-[11px] ${REGISTRATION_TONE[entry.status]}`}
                >
                  {entry.sourceName} · {REGISTRATION_LABEL[entry.status]}
                </span>
              ))}
            </div>
          )}
          {record.registrations
            .filter((entry) => entry.detail && entry.status !== 'registered')
            .map((entry) => (
              <p key={`detail:${entry.target}:${entry.sourceId ?? 'bundled'}`} className="text-[11px] text-ink-3">
                {entry.sourceName}: {entry.detail}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
