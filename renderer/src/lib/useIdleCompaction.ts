import { useEffect } from 'react';

/** User activity postpones background inference; the host still owns cancellation and stale checks. */
export function useIdleCompaction(threadId: string | null, running: boolean): void {
  useEffect(() => {
    const api = window.electronAPI.idleCompaction;
    if (!api) return;
    let lastSent = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      lastSent = Date.now();
      if (timer) clearTimeout(timer);
      timer = undefined;
      void api.activity(threadId).catch(() => {});
    };
    const activity = () => {
      if (Date.now() - lastSent >= 5000) send();
      else if (!timer) timer = setTimeout(send, 5000 - (Date.now() - lastSent));
    };
    send();
    for (const name of ['keydown', 'pointerdown', 'wheel'] as const) window.addEventListener(name, activity, { passive: true, capture: true });
    return () => {
      if (timer) clearTimeout(timer);
      for (const name of ['keydown', 'pointerdown', 'wheel'] as const) window.removeEventListener(name, activity, true);
      void api.activity(null).catch(() => {});
    };
  }, [threadId, running]);
}
