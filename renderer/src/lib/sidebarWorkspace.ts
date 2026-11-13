import { useCallback, useEffect, useRef, useState } from 'react';
import { emptySidebarState, type SidebarAction, type SidebarApi, type SidebarState } from '../../../src/api/sidebar';

export interface SidebarWorkspace {
  state: SidebarState;
  ready: boolean;
  busy: boolean;
  error: string;
  update(action: SidebarAction): Promise<SidebarState | null>;
  refresh(): Promise<void>;
}

export function useSidebarWorkspace(api: SidebarApi, subscribe?: (listener: () => void) => () => void): SidebarWorkspace {
  const [state, setState] = useState(emptySidebarState);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const queued = useRef(Promise.resolve());
  const pending = useRef(0);
  const apply = useCallback((next: SidebarState) => {
    if (mounted.current) setState((current) => next.revision >= current.revision ? next : current);
  }, []);
  const refresh = useCallback(async () => {
    try {
      apply(await api.load());
      if (mounted.current) { setReady(true); setError(''); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not load sidebar settings.');
    }
  }, [api, apply]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = subscribe?.(() => { void refresh(); });
    return () => { mounted.current = false; unsubscribe?.(); };
  }, [refresh, subscribe]);

  const update = useCallback((action: SidebarAction): Promise<SidebarState | null> => {
    pending.current += 1;
    if (mounted.current) setBusy(true);
    const work = queued.current.then(async () => {
      try {
        // Commands queue in this window and use a fresh revision across windows. A race still
        // fails at the host boundary rather than silently overwriting a newer catalog.
        const current = await api.load();
        const next = await api.update({ revision: current.revision, action });
        apply(next);
        if (mounted.current) { setReady(true); setError(''); }
        return next;
      } catch (cause) {
        try { apply(await api.load()); } catch { /* Keep the last readable view. */ }
        if (mounted.current) setError((cause instanceof Error ? cause.message : 'Could not update sidebar.')
          .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
        return null;
      } finally {
        pending.current -= 1;
        if (mounted.current) setBusy(pending.current > 0);
      }
    });
    queued.current = work.then(() => undefined);
    return work;
  }, [api, apply]);
  return { state, ready, busy, error, update, refresh };
}
