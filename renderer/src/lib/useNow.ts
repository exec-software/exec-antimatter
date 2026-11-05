import { useEffect, useState } from 'react';

/** The current time, refreshed while `live` is true, for labels that count up. */
export function useNow(live: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [live, intervalMs]);
  return now;
}
