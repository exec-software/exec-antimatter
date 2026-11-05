import { useEffect, useRef, useState } from 'react';
import type { VitalsSnapshot } from '../../types';

/**
 * Polls the machine and keeps the last minute of it.
 *
 * Polling, rather than a subscription, is what makes the cost of this panel exactly the cost of
 * having it open: unmount the component and the sampling stops with nothing to unregister.
 */

const INTERVAL_MS = 1000;
export const HISTORY = 60;

export interface VitalsHistory {
  cpu: number[];
  memory: number[];
  rx: number[];
  tx: number[];
  diskRead: number[];
  diskWrite: number[];
  gpu: number[];
}

const empty = (): VitalsHistory => ({ cpu: [], memory: [], rx: [], tx: [], diskRead: [], diskWrite: [], gpu: [] });

const push = (series: number[], value: number): number[] => {
  const next = [...series, value];
  return next.length > HISTORY ? next.slice(next.length - HISTORY) : next;
};

export function useVitals(): { snapshot: VitalsSnapshot | null; history: VitalsHistory; error: string } {
  const [snapshot, setSnapshot] = useState<VitalsSnapshot | null>(null);
  const [history, setHistory] = useState<VitalsHistory>(empty);
  const [error, setError] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const next = await window.electronAPI.vitals.sample();
        if (!alive.current) return;

        setSnapshot(next);
        setError('');
        setHistory((prev) => ({
          cpu: push(prev.cpu, next.cpu.usage),
          memory: push(prev.memory, next.memory.total ? next.memory.used / next.memory.total : 0),
          rx: push(prev.rx, next.network.reduce((total, entry) => total + entry.rx, 0)),
          tx: push(prev.tx, next.network.reduce((total, entry) => total + entry.tx, 0)),
          diskRead: push(prev.diskRead, next.diskIo?.read ?? 0),
          diskWrite: push(prev.diskWrite, next.diskIo?.write ?? 0),
          gpu: push(prev.gpu, next.gpus[0]?.usage ?? 0),
        }));
      } catch (failure) {
        if (alive.current) setError((failure as Error).message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
      } finally {
        // Chained rather than on an interval, so a slow sample cannot stack up behind itself.
        if (alive.current) timer = window.setTimeout(tick, INTERVAL_MS);
      }
    };

    void tick();
    return () => {
      alive.current = false;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return { snapshot, history, error };
}
