import { useSyncExternalStore } from 'react';
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react';
import type { ToastTone } from '../../../src/api/toasts';
import { dismissToast, getToasts, runToastAction, subscribeToasts } from '../toasts';

const ICONS: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  danger: XCircle,
};

const ACCENT: Record<ToastTone, string> = {
  info: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

/**
 * Where toasts appear.
 *
 * Bottom-left, because bottom-right is the inference debug overlay's corner and two things
 * fighting for it would mean the notice you need is the one hidden behind the panel you opened.
 *
 * One `aria-live="polite"` region wraps the stack rather than each toast announcing itself, so a
 * keyed notice updating five times is five polite updates to one region instead of five
 * interruptions. `danger` is assertive: an engine that gave up should not wait for a pause.
 */
export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (!toasts.length) return null;
  return <div
    aria-label="Notifications"
    className="pointer-events-none fixed bottom-4 left-4 z-50 flex w-[340px] max-w-[calc(100%-2rem)] flex-col gap-2"
  >
    {toasts.map((toast) => {
      const Icon = ICONS[toast.tone];
      return <div
        key={toast.id}
        role={toast.tone === 'danger' ? 'alert' : 'status'}
        aria-live={toast.tone === 'danger' ? 'assertive' : 'polite'}
        className="pointer-events-auto rounded-xl border border-line bg-surface-2 p-3 shadow-2xl"
      >
        <div className="flex items-start gap-2">
          <Icon size={14} className={`mt-0.5 shrink-0 ${ACCENT[toast.tone]}`} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium leading-5 text-ink">{toast.title}</p>
            {toast.body && <p className="mt-0.5 text-[11px] leading-4 text-ink-2">{toast.body}</p>}
          </div>
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            aria-label={`Dismiss: ${toast.title}`}
            className="shrink-0 rounded p-0.5 text-ink-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X size={13} />
          </button>
        </div>
        {toast.actions.length > 0 && <div className="mt-2 flex flex-wrap gap-2 pl-6">
          {toast.actions.map((action) => <button
            key={action.id}
            type="button"
            onClick={() => runToastAction(toast.id, action.id)}
            className={action.primary
              ? 'rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-on-primary hover:bg-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              : 'rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'}
          >
            {action.label}
          </button>)}
        </div>}
      </div>;
    })}
  </div>;
}
