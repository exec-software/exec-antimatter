import type { InferenceMetrics } from '../../../src/api/types';

const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The server's processed count includes the reused prefix. Never infer it from elapsed time. */
export function reportedPromptProgress(metrics?: InferenceMetrics) {
  const progress = metrics?.promptProgress;
  if (!progress || !tokenCount(progress.total) || !tokenCount(progress.cached) || !tokenCount(progress.processed) ||
      progress.cached > progress.processed || progress.processed > progress.total ||
      !Number.isFinite(progress.elapsedMs) || progress.elapsedMs < 0) return null;
  return progress;
}

export function reportedCachedTokens(metrics?: InferenceMetrics): number | null {
  return tokenCount(metrics?.cachedPromptTokens) ? metrics.cachedPromptTokens : null;
}
