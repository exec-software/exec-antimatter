import { useEffect, useState } from 'react';
import type { InferenceMetrics } from '../../../src/api/types';

export interface InferenceMetricsEvent {
  id: string;
  round: number;
  providerId: string;
  model: string;
  metrics: InferenceMetrics;
}

export type InferenceHistory = Record<string, InferenceMetricsEvent[]>;
const MAX_RUNS = 48;
const MAX_ROUNDS = 100;
const PHASE_ORDER = { started: 0, prefill: 1, streaming: 2, complete: 3 } as const;

/** Keep diagnostics bounded and scoped to a response, even when several chats are running. */
export function recordInferenceMetrics(history: InferenceHistory, event: InferenceMetricsEvent): InferenceHistory {
  const rounds = history[event.id] ?? [];
  const previous = rounds.find((entry) => entry.round === event.round);
  if (previous && (previous.metrics.requestStartedAt > event.metrics.requestStartedAt ||
      (previous.metrics.requestStartedAt === event.metrics.requestStartedAt &&
        (previous.metrics.requestDurationMs > event.metrics.requestDurationMs ||
          PHASE_ORDER[previous.metrics.phase] > PHASE_ORDER[event.metrics.phase])))) return history;
  const nextRounds = [...rounds.filter((entry) => entry.round !== event.round), event]
    .sort((left, right) => left.round - right.round).slice(-MAX_ROUNDS);
  const next = { ...history };
  delete next[event.id];
  next[event.id] = nextRounds;
  for (const id of Object.keys(next).slice(0, Math.max(0, Object.keys(next).length - MAX_RUNS))) delete next[id];
  return next;
}

export function useInferenceMetrics(): InferenceHistory {
  const [history, setHistory] = useState<InferenceHistory>({});
  useEffect(() => window.electronAPI.onInferenceMetrics?.((event) => {
    setHistory((current) => recordInferenceMetrics(current, event));
  }), []);
  return history;
}

const OVERLAY_KEY = 'antimatter.debugOverlay';
export function loadDebugOverlay(): boolean {
  try { return localStorage.getItem(OVERLAY_KEY) === 'true'; } catch { return false; }
}
export function saveDebugOverlay(enabled: boolean): void {
  try { localStorage.setItem(OVERLAY_KEY, String(enabled)); } catch { /* This session still works. */ }
}
