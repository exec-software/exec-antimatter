import type { InferenceMetrics } from '../../api/types';

/** A small public projection; request fingerprints and private provider fields stay on the host. */
export interface RemoteInferenceProgress {
  round: number;
  phase: InferenceMetrics['phase'];
  requestStartedAt: number;
  requestDurationMs: number;
  promptProgress?: { total: number; cached: number; processed: number; elapsedMs: number };
  promptTokens?: number;
  cachedPromptTokens?: number;
  prefillTokens?: number;
  firstTokenMs?: number;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => number(value) && Number.isSafeInteger(value);
const phaseRank = { started: 0, prefill: 1, streaming: 2, complete: 3 };

export function projectInferenceProgress(event: unknown): RemoteInferenceProgress | null {
  const data = object(event);
  const metrics = object(data.metrics);
  if (!count(data.round) || data.round < 1 || !number(metrics.requestStartedAt) ||
      !number(metrics.requestDurationMs) || !['started', 'prefill', 'streaming', 'complete'].includes(String(metrics.phase))) return null;
  const result: RemoteInferenceProgress = {
    round: data.round, phase: metrics.phase as InferenceMetrics['phase'],
    requestStartedAt: metrics.requestStartedAt, requestDurationMs: metrics.requestDurationMs,
  };
  for (const key of ['promptTokens', 'cachedPromptTokens', 'prefillTokens'] as const) {
    if (count(metrics[key])) result[key] = metrics[key];
  }
  if (number(metrics.firstTokenMs)) result.firstTokenMs = metrics.firstTokenMs;
  const progress = object(metrics.promptProgress);
  if (count(progress.total) && progress.total > 0 && count(progress.cached) && count(progress.processed) && number(progress.elapsedMs) &&
      progress.cached <= progress.processed && progress.processed <= progress.total) {
    result.promptProgress = { total: progress.total, cached: progress.cached, processed: progress.processed, elapsedMs: progress.elapsedMs };
  }
  return result;
}

/** Live-only state for reconnect snapshots, removed when the owning turn finishes. */
export class RemoteInferenceState {
  private readonly current = new Map<string, RemoteInferenceProgress>();

  update(runId: string, event: unknown): RemoteInferenceProgress | null {
    const next = projectInferenceProgress(event);
    if (!next) return null;
    const previous = this.current.get(runId);
    if (previous && (next.round < previous.round ||
      (next.round === previous.round && (next.requestStartedAt < previous.requestStartedAt ||
        (next.requestStartedAt === previous.requestStartedAt && (next.requestDurationMs < previous.requestDurationMs ||
          phaseRank[next.phase] < phaseRank[previous.phase])))))) return null;
    this.current.set(runId, next);
    return structuredClone(next);
  }

  get(runId: string): RemoteInferenceProgress | undefined {
    const value = this.current.get(runId);
    return value ? structuredClone(value) : undefined;
  }

  finish(runId: string): void { this.current.delete(runId); }
}
