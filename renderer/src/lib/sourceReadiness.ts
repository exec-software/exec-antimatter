import type { SourceReadiness } from '../types';

export const UNKNOWN_SOURCE_READINESS: SourceReadiness = { state: 'unknown' };
export interface SourceReadinessObservation {
  providerId: string;
  readiness: SourceReadiness;
  loadingSince: number | null;
}

/** An observation belongs to one source; a slow old poll must never gate a new selection. */
export function currentSourceReadiness(providerId: string | undefined, observation: SourceReadinessObservation | null) {
  return observation && observation.providerId === providerId
    ? { readiness: observation.readiness, loadingSince: observation.loadingSince }
    : { readiness: UNKNOWN_SOURCE_READINESS, loadingSince: null };
}

/** Loading and genuine unavailability block every submit path, including live voice. */
export function sourceReadinessBlock(readiness: SourceReadiness): string | undefined {
  if (readiness.state === 'loading') return 'This source is still loading its model.';
  if (readiness.state === 'unreachable') return readiness.detail || 'This source is not answering. Check that its server is running.';
  return undefined;
}

/** Only one poll is active at once; disposal also fences an already in-flight response. */
export function pollSourceReadiness(providerId: string, options: {
  read(id: string): Promise<SourceReadiness>;
  changed(observation: SourceReadinessObservation): void;
  schedule(callback: () => void, milliseconds: number): unknown;
  cancel(timer: unknown): void;
  now?(): number;
  error?(error: unknown): void;
}): () => void {
  let cancelled = false;
  let timer: unknown;
  let loadingSince: number | null = null;
  const poll = async () => {
    let readiness = UNKNOWN_SOURCE_READINESS;
    try { readiness = await options.read(providerId); }
    catch (error) { options.error?.(error); }
    if (cancelled) return;
    if (readiness.state === 'loading') loadingSince ??= (options.now ?? Date.now)();
    else loadingSince = null;
    options.changed({ providerId, readiness, loadingSince });
    if (!cancelled) timer = options.schedule(() => { void poll(); }, 4_000);
  };
  void poll();
  return () => {
    cancelled = true;
    if (timer !== undefined) options.cancel(timer);
  };
}
