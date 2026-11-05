import { useEffect, useRef } from 'react';
import { TriangleAlert, X } from 'lucide-react';

/**
 * A confirmation the app owns.
 *
 * Deliberately not window.confirm: that blocks the renderer, cannot say which conversation it
 * means in the app's own voice, and looks like it belongs to a different program. Cancel takes
 * focus rather than the destructive button, because the reflex on a dialog you did not expect
 * is to press Enter.
 */

interface Props {
  title: string;
  /** What will actually happen, in enough detail to decide. */
  message: string;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({ title, message, confirmLabel, tone = 'default', onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div
      role="presentation"
      onClick={onCancel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0/70 p-4 backdrop-blur-sm"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm overflow-hidden rounded-xl border border-line bg-surface-2 shadow-2xl shadow-black/60"
      >
        <div className="flex items-start gap-2.5 p-4">
          {tone === 'danger' && <TriangleAlert size={16} className="mt-0.5 shrink-0 text-danger" />}
          <div className="min-w-0 flex-1">
            <h2 id="confirm-title" className="text-sm font-semibold text-ink">
              {title}
            </h2>
            <p id="confirm-message" className="mt-1 text-xs leading-relaxed text-ink-2">
              {message}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="shrink-0 rounded p-1 text-ink-3 transition hover:bg-surface-3 hover:text-ink"
          >
            <X size={13} />
          </button>
        </div>

        <div className="flex justify-end gap-2 border-t border-line bg-surface-3/40 px-4 py-2.5">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-2 transition hover:border-ink-3 hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              tone === 'danger'
                ? 'bg-danger text-on-danger hover:brightness-110'
                : 'bg-primary text-on-primary hover:bg-primary-strong'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
