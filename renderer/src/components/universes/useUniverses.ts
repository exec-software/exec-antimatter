import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UniverseLayoutPatch, UniverseView } from '../../../../src/api/universes';
import type { Production, ProductionEdit, ProductionSummary } from '../../../../src/api/movie';

/**
 * The universe registry, as the renderer sees it.
 *
 * One fetch for the whole list rather than a call per universe: the switcher needs every
 * manifest, every layout and every entitlement to draw at all, and three round trips would mean
 * a frame in which a universe is drawn before anyone has checked whether it opens.
 *
 * The layout is written through main rather than kept here and flushed, because a drag settling
 * a region size and a click toggling a panel are two writers of the same document.
 */
export function useUniverses() {
  const [universes, setUniverses] = useState<UniverseView[] | null>(null);
  const [error, setError] = useState('');
  /** Set once the first load has answered, so an empty list reads as empty rather than loading. */
  const [ready, setReady] = useState(false);

  const api = window.electronAPI?.universes;

  const refresh = useCallback(async () => {
    if (!api) {
      // A main process older than this page answers without the namespace. That is not an
      // error the person can act on, so it reads as "no universes" rather than a red banner.
      setReady(true);
      return;
    }
    try {
      setUniverses(await api.list());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The universe list could not be read.');
    } finally {
      setReady(true);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Change a universe's layout.
   *
   * Applied locally first so dragging a panel does not wait on a disk write, then reconciled
   * with what main actually stored. A failed write leaves the optimistic state in place and
   * surfaces the reason: losing someone's arrangement silently is worse than a stale pixel.
   */
  const patchLayout = useCallback(
    async (universeId: string, patch: UniverseLayoutPatch) => {
      setUniverses((current) =>
        current?.map((entry) =>
          entry.manifest.id !== universeId
            ? entry
            : {
                ...entry,
                layout: {
                  ...entry.layout,
                  regions: patch.regions ? { ...entry.layout.regions, ...patch.regions } : entry.layout.regions,
                  open: patch.open ? { ...entry.layout.open, ...patch.open } : entry.layout.open,
                  sizes: patch.sizes ? { ...entry.layout.sizes, ...patch.sizes } : entry.layout.sizes,
                  stageId: patch.stageId !== undefined ? patch.stageId : entry.layout.stageId,
                  atoma: patch.atoma !== undefined ? patch.atoma : entry.layout.atoma,
                },
              }
        ) ?? current
      );
      if (!api) return;
      try {
        const settled = await api.layout(universeId, patch);
        setUniverses((current) =>
          current?.map((entry) => (entry.manifest.id === universeId ? { ...entry, layout: settled } : entry)) ?? current
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'That layout change could not be saved.');
      }
    },
    [api]
  );

  return { universes, ready, error, setError, refresh, patchLayout };
}

/**
 * One production, loaded and edited.
 *
 * Every edit is a round trip to main, which owns the document. That is deliberate and not a
 * performance oversight: a render finishing writes a take into the same file at the same moment
 * someone is dragging a shot, and a renderer that held the document and flushed it would lose
 * one of them. Edits are small; the file is one film.
 */
export function useProduction(productionId: string | null) {
  const [production, setProduction] = useState<Production | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** Guards against a slow read for a production nobody is looking at any more. */
  const wanted = useRef<string | null>(productionId);
  wanted.current = productionId;

  const api = window.electronAPI?.movie;

  useEffect(() => {
    if (!productionId || !api) {
      setProduction(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    api
      .read(productionId)
      .then((value) => {
        if (!cancelled && wanted.current === productionId) {
          setProduction(value);
          setError('');
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'That production could not be opened.');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productionId, api]);

  const edit = useCallback(
    async (edits: ProductionEdit[]) => {
      if (!productionId || !api || !edits.length) return;
      try {
        const next = await api.edit(productionId, edits);
        // Only applied when it is still the open production: a reply for one the person has
        // navigated away from would put the wrong film on screen.
        if (wanted.current === productionId) setProduction(next);
        setError('');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'That change could not be saved.');
      }
    },
    [productionId, api]
  );

  return { production, busy, error, setError, edit };
}

/** The list of productions, for the universe's own document switcher. */
export function useProductions(enabled: boolean) {
  const [productions, setProductions] = useState<ProductionSummary[]>([]);
  const [error, setError] = useState('');
  const api = window.electronAPI?.movie;

  const refresh = useCallback(async () => {
    if (!api || !enabled) return;
    try {
      setProductions(await api.list());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Productions could not be listed.');
    }
  }, [api, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { productions, error, refresh, setProductions };
}

/** A duration the way a cut is read, not the way a number is written. */
export const useTimecode = () =>
  useMemo(
    () => (seconds: number) => {
      const whole = Math.max(0, Math.round(seconds));
      return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
    },
    []
  );
