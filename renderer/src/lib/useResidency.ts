import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResidentModel, SourceResidency } from '../types';

/**
 * What the local engines are holding, kept fresh while the page that shows it is open.
 *
 * Polled rather than pushed: residency changes for reasons Antimatter never sees — a model loaded
 * by something else on the box, a worker that died on its own — so the only honest answer comes
 * from asking. Refreshing after an unload is what makes the button feel like it did something,
 * and a poll is what keeps the number true when it was somebody else who freed the card.
 */
const POLL_MS = 6_000;

export interface Residency {
  sources: SourceResidency[];
  /** True only until the first answer, so a refresh does not blank the panel. */
  loading: boolean;
  /** Every live or dead model across every source that reports one. */
  resident: Array<ResidentModel & { sourceId: string }>;
  refresh: () => void;
  find: (sourceId: string, modelId: string) => ResidentModel | undefined;
}

/** Match the server's unload contract without taking away legacy wedged-worker recovery. */
export function unloadUnavailableReason(source?: SourceResidency): string | undefined {
  if (source?.canUnload !== true) {
    return source?.unloadUnavailableReason ?? 'This source has not confirmed support for model unloading.';
  }
  if (source.unloadRequiresIdle && source.models.some((model) => (model.turns ?? 0) > 0)) {
    return 'Wait for active turns on this native server to finish before unloading.';
  }
  return undefined;
}

export function useResidency(active = true): Residency {
  const [sources, setSources] = useState<SourceResidency[]>([]);
  const [loading, setLoading] = useState(true);
  // A slow engine can take seconds to answer; never let a late reply overwrite a newer one.
  const generation = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++generation.current;
    window.electronAPI.residency
      .list()
      .then((next) => {
        if (mine !== generation.current) return;
        // Most polls report no change at all. Keeping the previous array then keeps every
        // memo downstream of it intact, which is what makes a six-second poll free.
        setSources((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
        setLoading(false);
      })
      .catch((error) => {
        if (mine !== generation.current) return;
        console.error('Could not read what the local engines are holding:', error);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  // Stable while the answer is unchanged, so a caller may use it as a dependency without
  // rebuilding derived work on every poll that reports exactly the same thing.
  const resident = useMemo(
    () => sources.flatMap((source) => source.models.map((model) => ({ ...model, sourceId: source.sourceId }))),
    [sources]
  );

  return {
    sources,
    loading,
    resident,
    refresh,
    find: (sourceId, modelId) =>
      sources.find((source) => source.sourceId === sourceId)?.models.find((model) => model.id === modelId),
  };
}
