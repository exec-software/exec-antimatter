import { useId, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { formatElapsedMilliseconds } from '../../lib/duration';
import { useNow } from '../../lib/useNow';

interface Props {
  startedAt?: number;
  finishedAt?: number;
  isActive: boolean;
  /** Imported source records do not establish how long the agent actually worked. */
  historical?: boolean;
  /** The turn ended in an error or was stopped. */
  failed?: boolean;
  /** Actions folded away here. Shown closed, so the line says what there is rather than only how long. */
  actions?: number;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}

/**
 * How a turn got to its answer, folded to one line once it has one.
 *
 * The answer is what someone came back to read; the forty tool calls before it are evidence,
 * worth a click and not worth scrolling past. While the turn is working the fold stays open,
 * because then the steps are the only news there is.
 */
export function WorkedFor({
  startedAt,
  finishedAt,
  isActive,
  historical = false,
  failed = false,
  actions = 0,
  open,
  onToggle,
  children,
}: Props) {
  const now = useNow(isActive);
  const bodyId = useId();
  const elapsed = startedAt ? formatElapsedMilliseconds((isActive ? now : finishedAt ?? now) - startedAt) : null;
  const label = historical && !isActive ? 'Imported activity' : isActive
    ? elapsed
      ? `Working for ${elapsed}`
      : 'Working'
    : failed
      ? elapsed
        ? `Stopped after ${elapsed}`
        : 'Stopped'
      : elapsed
        ? `Worked for ${elapsed}`
        : 'Worked';

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="group flex w-full min-w-0 items-center gap-1.5 border-b border-line-soft pb-2 text-left text-[13px] text-ink-3 transition hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
      >
        <span className={isActive ? 'shimmer-text font-medium' : ''}>{label}</span>
        {/* Closed, the fold also holds whatever the model wrote between its calls, and a line
            that only gives a duration reads as though the turn has nothing else to show. */}
        {!open && actions > 0 && (
          <span className="shrink-0 text-ink-3">
            · {actions} action{actions === 1 ? '' : 's'}
          </span>
        )}
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div id={bodyId} className="pt-2">
          {children}
        </div>
      )}
    </div>
  );
}
