import { useCallback, useEffect, useRef, useState } from 'react';
import type { HagExperimentalAPI, HagExperimentalState } from '../../../src/api/hag';

export type HagAction = 'enable' | 'disable' | 'dismissWelcome';
export const hagError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
  .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

/** Reading the offer never opts in, downloads a model, or starts an engine. */
export function useHagExperimental(api: HagExperimentalAPI | undefined = window.electronAPI.hag, active = true) {
  const [state, setState] = useState<HagExperimentalState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<HagAction | null>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const currentAPI = useRef(api); currentAPI.current = api;

  const reload = useCallback(async () => {
    if (!api || !active) return;
    const request = ++sequence.current;
    setLoading(true);
    try {
      const next = await api.state();
      if (mounted.current && currentAPI.current === api && request === sequence.current) {
        setState(next); setError('');
      }
    } catch (cause) {
      if (mounted.current && currentAPI.current === api && request === sequence.current) setError(hagError(cause));
    } finally {
      if (mounted.current && currentAPI.current === api && request === sequence.current) setLoading(false);
    }
  }, [api, active]);

  useEffect(() => {
    mounted.current = true;
    if (!active) return () => { mounted.current = false; sequence.current++; };
    setState(null); setError(''); void reload();
    const unsubscribe = api?.onChanged((next) => {
      if (!mounted.current || currentAPI.current !== api) return;
      sequence.current++; setState(next); setLoading(false);
    });
    return () => { mounted.current = false; sequence.current++; unsubscribe?.(); };
  }, [api, active, reload]);

  const perform = useCallback(async (nextAction: HagAction): Promise<boolean> => {
    if (!api || inFlight.current) return false;
    inFlight.current = true; setAction(nextAction); setError('');
    // An earlier state read cannot replace a completed user action.
    sequence.current++;
    try {
      const next = await api[nextAction]();
      if (mounted.current && currentAPI.current === api) {
        sequence.current++; setState(next); setLoading(false);
      }
      return true;
    } catch (cause) {
      if (mounted.current && currentAPI.current === api) setError(hagError(cause));
      return false;
    } finally {
      inFlight.current = false;
      if (mounted.current && currentAPI.current === api) setAction(null);
    }
  }, [api]);

  return { state, error, loading, action, reload, perform, available: !!api };
}

export type HagExperimentalController = ReturnType<typeof useHagExperimental>;
