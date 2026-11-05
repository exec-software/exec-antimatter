import { useEffect, useRef } from 'react';
import type { HagExperimentalController } from '../../lib/useHagExperimental';
import { HagExperimentalControls } from '../settings/HagExperimentalPanel';

export function HagWelcomeDialog({ controller, onEnabled }: { controller: HagExperimentalController; onEnabled?(): void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    title.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="hag-welcome-title" aria-describedby="hag-welcome-description"
      className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl border border-line bg-surface p-6 shadow-2xl"
      onKeyDown={(event) => {
        const busy = controller.action !== null || controller.state?.status === 'downloading' || controller.state?.status === 'starting';
        if (event.key === 'Escape' && !busy) { event.preventDefault(); void controller.perform('dismissWelcome'); return; }
        if (event.key !== 'Tab') return;
        const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');
        if (!focusable?.length) { event.preventDefault(); return; }
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === title.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === title.current)) { event.preventDefault(); first.focus(); }
      }}>
      <p className="text-xs font-medium text-primary">New in Antimatter</p>
      <h2 ref={title} tabIndex={-1} id="hag-welcome-title" className="mt-1 text-xl font-semibold text-ink outline-none">Try the experimental HAG runtime</h2>
      <p id="hag-welcome-description" className="mb-4 mt-2 text-xs leading-5 text-ink-3">This update adds an optional native GPU preview. It stays off until you enable it. You can revisit this choice in Settings → Experimental.</p>
      <HagExperimentalControls controller={controller} welcome onEnabled={onEnabled} />
    </div>
  </div>;
}
