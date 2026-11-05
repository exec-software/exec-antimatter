import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { estimateReasoningTokens } from '../../lib/useReasoningStream';
import { AtomIndicator } from '../status/AtomIndicator';

interface Props {
  /** What the model has thought so far, if this session still holds it. */
  reasoning: string;
  /** The count recorded when the turn ended, which outlives the text. */
  recordedTokens?: number;
  /** The turn is still running. */
  isActive: boolean;
  /** Shown while a turn that has not thought aloud produces nothing at all. */
  idleLabel: string;
}

/**
 * What the model is thinking, while it thinks it.
 *
 * A reasoning model spends most of a turn here and says none of it: measured on this machine, a
 * MiMo turn decoded 12,400 tokens to emit about 300 of answer and tool calls, at a steady 16
 * tok/s. Thirteen minutes of that behind a single unchanging "Thinking…" is indistinguishable
 * from a hang, and it was read as one — the throughput was never the problem, the silence was.
 *
 * So the line always says how much thinking there has been, and opening it shows the thinking.
 * It stays closed by default because it is deliberation, not an answer: something to look at
 * when a turn is taking longer than it should, not something to scroll past every time.
 */
export function ThinkingTrace({ reasoning, recordedTokens, isActive, idleLabel }: Props) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const tail = useRef<HTMLDivElement>(null);

  // Thinking is appended to, so the end is the part worth seeing. Only while it is arriving:
  // scrolling someone's reading position away once the turn is over would be rude.
  useEffect(() => {
    if (!open || !isActive) return;
    const node = tail.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [open, isActive, reasoning]);

  const tokens = reasoning ? estimateReasoningTokens(reasoning) : (recordedTokens ?? 0);
  if (!tokens) {
    if (!isActive) return null;
    return (
      <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-2 py-0.5">
        <AtomIndicator phase="thinking" size={16} />
        <span className="shimmer-text text-xs font-medium">{idleLabel}</span>
      </div>
    );
  }

  const count = `~${tokens.toLocaleString()} token${tokens === 1 ? '' : 's'}`;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
        // Nothing to open once the text has been dropped and only the count survives a reload.
        disabled={!reasoning}
        className="group flex w-full min-w-0 items-center gap-2 py-0.5 text-left text-xs text-ink-3 transition hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 disabled:cursor-default disabled:hover:text-ink-3"
      >
        {isActive && <AtomIndicator phase="thinking" size={16} />}
        <span className={isActive ? 'shimmer-text font-medium' : 'font-medium'}>
          {isActive ? 'Thinking' : 'Thought'}
        </span>
        <span className="tabular-nums">{count}</span>
        {reasoning && (
          <ChevronRight
            size={14}
            aria-hidden="true"
            className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          />
        )}
      </button>
      {open && reasoning && (
        <div
          id={bodyId}
          ref={tail}
          className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-words border-l border-line-soft pl-3 text-[11px] leading-relaxed text-ink-3"
        >
          {reasoning}
        </div>
      )}
    </div>
  );
}
