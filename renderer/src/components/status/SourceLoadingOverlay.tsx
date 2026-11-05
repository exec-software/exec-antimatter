import { useEffect, useState } from 'react';
import { AtomIndicator } from './AtomIndicator';

interface Props {
  /** The source's display name, as configured. */
  sourceName: string;
  /** The model the conversation is pointed at. */
  modelId: string;
  /** The server's own words, when it gave any. Never a phrase invented here. */
  detail?: string;
  /** When the source was first seen loading, so a quarter-hour wait never reads as a hang. */
  since: number;
  onStop?: () => void;
  onChooseModel?: () => void;
}

const clock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** The clock lives here rather than in App, which would otherwise re-render once a second. */
function useElapsed(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now - since;
}

/** Composer admission stays blocked while loading; navigation and Stop remain reachable. */
export function SourceLoadingOverlay({ sourceName, modelId, detail, since, onStop, onChooseModel }: Props) {
  const elapsedMs = useElapsed(since);

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 top-16 z-40 w-[min(22rem,calc(100vw-2rem))]"
    >
      <div className="w-full max-w-sm overflow-hidden rounded-xl border border-line bg-surface-2 p-6 text-center shadow-2xl shadow-black/60">
        <div className="flex justify-center text-primary">
          <AtomIndicator phase="thinking" size={44} />
        </div>

        <h2 className="mt-3 text-sm font-semibold text-ink">Loading {modelId}</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-2">{sourceName}</p>

        {detail && (
          <p className="mt-3 rounded-lg bg-surface-3 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-3">
            {detail}
          </p>
        )}

        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          The composer will be ready when loading finishes. You can keep working or choose another model.
        </p>

        <p className="mt-3 font-mono text-xs tabular-nums text-ink-3" aria-label="Time elapsed">
          {clock(elapsedMs)}
        </p>
        <div className="mt-3 flex justify-center gap-2">
          {onStop && <button type="button" onClick={onStop} className="rounded border border-line px-3 py-1.5 text-xs text-ink hover:bg-surface-3">Stop response</button>}
          {onChooseModel && <button type="button" onClick={onChooseModel} className="rounded bg-primary px-3 py-1.5 text-xs text-on-primary">Choose model</button>}
        </div>
      </div>
    </div>
  );
}
