import { useEffect, useState } from 'react';
import type { SourceReadiness } from '../../types';
import { currentSourceReadiness, pollSourceReadiness, type SourceReadinessObservation } from '../../lib/sourceReadiness';

export interface SourceReadinessResult {
  readiness: SourceReadiness;
  /** When this source was first seen loading. Null unless it is loading. */
  loadingSince: number | null;
}

/** Polls without starting an engine; a new selection immediately discards the previous gate. */
export function useSourceReadiness(providerId: string | undefined): SourceReadinessResult {
  const [observation, setObservation] = useState<SourceReadinessObservation | null>(null);
  useEffect(() => {
    setObservation(null);
    if (!providerId) return;
    return pollSourceReadiness(providerId, {
      read: (id) => window.electronAPI.providers.readiness(id),
      changed: setObservation,
      schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
      cancel: (timer) => window.clearTimeout(timer as number),
      error: (error) => console.error('Could not read source readiness:', error),
    });
  }, [providerId]);
  return currentSourceReadiness(providerId, observation);
}
