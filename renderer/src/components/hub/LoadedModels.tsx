import { CircleSlash, MemoryStick, RotateCw, TriangleAlert } from 'lucide-react';
import type { ProviderConfig, ResidentModel } from '../../types';
import { unloadUnavailableReason, type Residency } from '../../lib/useResidency';
import { bytes } from './presentation';

interface Props {
  providers: ProviderConfig[];
  residency: Residency;
  /** `sourceId:modelId` of the one being freed, so its row can say so. */
  busy: string | null;
  error: string;
  onUnload: (sourceId: string, model: ResidentModel) => void;
}

const chip = 'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]';
const button =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:cursor-default disabled:opacity-50';

/**
 * What the local engines are holding right now, and the way to put it down.
 *
 * Above the library rather than only on each card, because the question it answers is about the
 * box and not about any one model: what is in memory, how much of the card has gone, and what
 * can be freed before loading something else. Only sources that can actually report it appear —
 * a hosted API has no memory of yours to free, and a llama-server process is one model that ends
 * when the process does.
 */
export function LoadedModels({ providers, residency, busy, error, onUnload }: Props) {
  const reporting = residency.sources.filter((source) => source.supported);
  if (!reporting.length) return null;

  const named = (sourceId: string) => providers.find((source) => source.id === sourceId)?.name ?? sourceId;
  const vram = reporting.reduce((total, source) => total + (source.vramBytes ?? 0), 0);
  const failures = reporting.filter((source) => source.error);

  return (
    <section className="mt-4 rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-ink">
          <MemoryStick size={13} className="text-primary" aria-hidden="true" />
          In memory now
        </h3>
        {vram > 0 && (
          <span
            className="text-[11px] tabular-nums text-ink-3"
            title="Device memory in use across the card, as the engine reports it for the whole card rather than per model."
          >
            {bytes(vram)} of the card in use
          </span>
        )}
        <button type="button" onClick={residency.refresh} title="Check again" className={`${button} ml-auto`}>
          <RotateCw size={12} /> Refresh
        </button>
      </div>

      {residency.loading && !residency.resident.length ? (
        <p className="mt-2 text-[11px] text-ink-3">Asking the local engines what they are holding…</p>
      ) : residency.resident.length ? (
        <ul className="mt-2.5 grid gap-1.5">
          {reporting.flatMap((source) =>
            source.models.map((model) => {
              const key = `${source.sourceId}:${model.id}`;
              const dead = model.state === 'dead';
              const unavailableReason = unloadUnavailableReason(source);
              return (
                <li
                  key={key}
                  className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-surface px-2.5 py-2"
                >
                  <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dead ? 'bg-danger' : 'bg-accent'}`} />
                  <span className="min-w-0 truncate text-xs text-ink" title={`${named(source.sourceId)} · ${model.id}`}>
                    {model.id}
                  </span>
                  <span className="shrink-0 text-[10px] text-ink-3">{named(source.sourceId)}</span>
                  {dead ? (
                    <span className={`${chip} border-danger/40 bg-danger/10 text-danger`} title={model.detail}>
                      <TriangleAlert size={9} /> Stopped answering
                    </span>
                  ) : (
                    <span className={`${chip} border-accent/40 bg-accent/10 text-accent`}>Loaded</span>
                  )}
                  {model.turns ? (
                    <span className={`${chip} border-primary/40 bg-primary/10 text-primary`}>
                      {model.turns} turn{model.turns === 1 ? '' : 's'} on it
                    </span>
                  ) : null}
                  {model.hostBytes ? (
                    <span
                      className="shrink-0 text-[10px] tabular-nums text-ink-3"
                      title="Host memory. Weights offloaded to the card are not counted here."
                    >
                      {bytes(model.hostBytes)} host
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onUnload(source.sourceId, model)}
                    disabled={busy === key || !!unavailableReason}
                    title={unavailableReason}
                    className={`${button} ml-auto shrink-0`}
                  >
                    <CircleSlash size={12} />
                    {busy === key ? 'Unloading…' : dead ? 'Clear' : 'Unload'}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      ) : (
        <p className="mt-2 text-[11px] text-ink-3">
          Nothing is loaded. A turn loads the model it needs and leaves it loaded, so the next turn on it starts at once;
          this is where it is put down again.
        </p>
      )}

      {failures.map((source) => (
        <p key={source.sourceId} className="mt-2 text-[11px] text-danger">
          {named(source.sourceId)} could not be asked: {source.error}
        </p>
      ))}

      {reporting.filter((source) => source.models.length && source.canUnload !== true).map((source) => (
        <p key={`unload:${source.sourceId}`} className="mt-2 text-[11px] text-ink-3">
          {named(source.sourceId)}: {unloadUnavailableReason(source)}
        </p>
      ))}

      {error && (
        <p role="alert" className="mt-2 text-[11px] text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
