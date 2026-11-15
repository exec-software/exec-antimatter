import { useEffect, useRef, useState } from 'react';
import { AtomIndicator } from '../status/AtomIndicator';

/**
 * The wait after Reinterpret.
 *
 * There is no token stream to show, so the dialog reports how long the call has been running and
 * what stage it is at. It holds focus while the model works, because anything typed behind it
 * would be replaced by the rewrite when it lands — but a local model can take minutes, so there
 * is always a way out: Escape, or the button, abandons the answer and gives the editor back.
 */
export function ReinterpretProgressDialog({ modelName, onDismiss }: { modelName?: string; onDismiss(): void }) {
  const dismiss = useRef<HTMLButtonElement>(null);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dismiss.current?.focus();
    return () => {
      window.clearInterval(timer);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onDismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onDismiss]);

  const phase = seconds < 3 ? `Sending the prompt${modelName ? ` to ${modelName}` : ''}…`
    : seconds < 20 ? 'Writing the agent-ready brief…'
      : 'Still writing — long prompts and slower models take longer.';

  return (
    <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reinterpret-title"
        aria-describedby="reinterpret-detail"
        onKeyDown={(event) => { if (event.key === 'Tab') event.preventDefault(); }}
        className="w-full max-w-md overflow-hidden rounded-xl border border-line bg-surface-2 shadow-2xl shadow-black/60 outline-none"
      >
        <div className="flex items-start gap-3 p-4">
          <AtomIndicator phase="thinking" size={30} />
          <div className="min-w-0 flex-1">
            <h2 id="reinterpret-title" className="text-sm font-semibold text-ink">Reinterpreting the prompt</h2>
            <p id="reinterpret-detail" className="mt-1 text-xs leading-relaxed text-ink-2">
              {modelName
                ? <><span className="font-medium text-ink">{modelName}</span> is rewriting your prompt into an agent-ready brief.</>
                : 'Your prompt is being rewritten into an agent-ready brief.'}
            </p>
          </div>
        </div>

        <div className="px-4 pb-4">
          <span className="relative block h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Waiting for the rewrite">
            <span className="progress-sweep block h-full w-1/3 rounded-full bg-primary" />
          </span>
          <p className="mt-2 flex items-center justify-between gap-3 text-[10px] text-ink-3" aria-hidden="true">
            <span className="min-w-0 truncate">{phase}</span>
            <span className="shrink-0 font-mono tabular-nums">{seconds}s</span>
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-3/40 px-4 py-2.5">
          <p className="min-w-0 text-[10px] leading-relaxed text-ink-3">
            Your prompt stays in the editor until the rewrite arrives. You can undo it afterward.
          </p>
          <button
            ref={dismiss}
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-md border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:border-ink-3 hover:text-ink"
          >
            Stop waiting
          </button>
        </div>
      </div>
    </div>
  );
}
