import type { InferenceMetrics } from '../../../../src/api/types';
import { reportedCachedTokens, reportedPromptProgress } from '../../lib/inferenceProgress';

/** A progress bar exists only when the source reports both the processed and total counts. */
export function InferencePromptStatus({ metrics, active }: { metrics?: InferenceMetrics; active: boolean }) {
  if (!metrics) return null;
  const progress = reportedPromptProgress(metrics);
  const prefilling = active && metrics.phase === 'prefill';
  const cached = reportedCachedTokens(metrics);
  if (!prefilling && cached === null) return null;
  return <div className="mt-2 text-[11px] leading-4 text-ink-3" aria-label="Server prompt metrics">
    {prefilling ? <>
      <p className="flex flex-wrap gap-x-2 gap-y-0.5 tabular-nums">
        <span className="text-ink-2">{progress
          ? `${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()} prompt tokens ready`
          : 'Processing prompt · progress unreported'}</span>
        {progress && <span>{progress.cached.toLocaleString()} reused · {(progress.processed - progress.cached).toLocaleString()} newly processed</span>}
      </p>
      {progress && progress.total > 0 && <div
        role="progressbar" aria-label="Prompt processing" aria-valuemin={0} aria-valuemax={progress.total}
        aria-valuenow={progress.processed}
        aria-valuetext={`${progress.processed.toLocaleString()} of ${progress.total.toLocaleString()} prompt tokens ready, including ${progress.cached.toLocaleString()} reused`}
        title="Server-reported prompt processing. Ready tokens include the reused prefix; this is not a time estimate."
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3"
      ><div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${progress.processed / progress.total * 100}%` }} /></div>}
    </> : <p>{cached?.toLocaleString()} prompt tokens reused{metrics.promptTokens !== undefined && metrics.promptTokens >= (cached ?? 0) ? ` / ${metrics.promptTokens.toLocaleString()} input tokens` : ''}</p>}
  </div>;
}
