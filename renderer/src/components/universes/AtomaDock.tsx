import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Atom, GripHorizontal, Minimize2, Send, X } from 'lucide-react';
import type { Message } from '../../types';
import { beginDrag } from '../../plugins/drag';
import {
  ATOMA_DEFAULT_HEIGHT,
  ATOMA_DEFAULT_WIDTH,
  ATOMA_MIN_HEIGHT,
  ATOMA_MIN_WIDTH,
  type UniverseLayout,
} from '../../../../src/api/universes';

/**
 * Atoma: the conversation, floating over a workbench.
 *
 * The important thing about this panel is what it is *not*. It is not a second assistant, it does
 * not have its own history, and it does not start a fresh thread when you open it. It is the
 * conversation you already had open in the chat view, drawn here — same thread, same model, same
 * tools, same memory of what you were doing ten minutes ago in the sidebar.
 *
 * That is the whole reason it is worth building. An assistant that lives inside the video
 * workbench and knows nothing about the chat where you worked out what the film was is a worse
 * assistant than the one you just navigated away from, and people would simply navigate back.
 * Sharing the thread means leaving the chat for the workbench costs nothing — you take the
 * conversation with you.
 *
 * It is a presentation layer over state App.tsx owns: messages come in as props and submitting
 * calls the same handler the real composer does. Nothing about a turn is duplicated here,
 * because two code paths that run turns is two code paths that drift.
 */

interface Props {
  /** The live conversation. Already filtered by App.tsx the way the transcript filters it. */
  messages: readonly Message[];
  threadTitle: string;
  /** The same submit the main composer uses, so a turn started here is an ordinary turn. */
  onSubmit: (text: string) => void;
  streaming: boolean;
  /** Why a turn cannot be started right now, when one cannot. */
  blockedReason?: string;
  assistantName: string;
  /** Where it was left, and how to remember where it is left next. */
  placement: UniverseLayout['atoma'];
  onPlacement: (next: NonNullable<UniverseLayout['atoma']>) => void;
  onClose: () => void;
  /** A line of context about what the workbench is showing, shown as the chat's footing. */
  context?: string;
}

/** Keeps the panel on screen after a window resize or a move that overshot. */
const clampToViewport = (x: number, y: number, width: number, height: number) => ({
  x: Math.max(8, Math.min(x, Math.max(8, window.innerWidth - width - 8))),
  y: Math.max(8, Math.min(y, Math.max(8, window.innerHeight - height - 8))),
});

export function AtomaDock({
  messages,
  threadTitle,
  onSubmit,
  streaming,
  blockedReason,
  assistantName,
  placement,
  onPlacement,
  onClose,
  context,
}: Props) {
  const width = placement?.width ?? ATOMA_DEFAULT_WIDTH;
  const height = placement?.height ?? ATOMA_DEFAULT_HEIGHT;
  const [position, setPosition] = useState(() =>
    placement && placement.x !== null && placement.y !== null
      ? clampToViewport(placement.x, placement.y, width, height)
      : // Never placed: bottom right, where a floating assistant is looked for.
        clampToViewport(window.innerWidth - width - 24, window.innerHeight - height - 24, width, height)
  );
  const [size, setSize] = useState({ width, height });
  const [text, setText] = useState('');
  const [minimized, setMinimized] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  // Follow the conversation, the way the transcript does. Only when already near the bottom
  // would be better, but this panel is short enough that scrolling away from the end is almost
  // always a deliberate look back at something that is about to be scrolled past anyway.
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, streaming]);

  useEffect(() => {
    const onResize = () => setPosition((current) => clampToViewport(current.x, current.y, size.width, size.height));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [size.width, size.height]);

  const remember = useCallback(
    (next: { x: number; y: number; width: number; height: number }) => {
      onPlacement({ open: true, ...next });
    },
    [onPlacement]
  );

  const onDragHeader = (event: React.PointerEvent) => {
    const start = position;
    let live = start;
    beginDrag(
      event,
      ({ dx, dy }) => {
        live = clampToViewport(start.x + dx, start.y + dy, size.width, size.height);
        setPosition(live);
      },
      () => remember({ ...live, ...size })
    );
  };

  const onDragCorner = (event: React.PointerEvent) => {
    const start = size;
    let live = start;
    beginDrag(
      event,
      ({ dx, dy }) => {
        live = {
          width: Math.max(ATOMA_MIN_WIDTH, Math.min(900, start.width + dx)),
          height: Math.max(ATOMA_MIN_HEIGHT, Math.min(900, start.height + dy)),
        };
        setSize(live);
      },
      () => remember({ ...position, ...live })
    );
  };

  const send = () => {
    const value = text.trim();
    if (!value || streaming || blockedReason) return;
    onSubmit(value);
    setText('');
  };

  /**
   * The last few turns, not the whole thread.
   *
   * A floating panel 380 pixels wide is not where anyone reads a long transcript, and rendering
   * a thousand messages into it on every token would cost more than the turn. The full
   * conversation is one click away in the chat view, which is the same conversation.
   */
  const recent = useMemo(() => messages.slice(-12), [messages]);

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        style={{ left: position.x, top: position.y }}
        className="fixed z-40 flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-2 text-xs text-ink shadow-lg transition hover:border-primary/60"
      >
        <Atom size={14} className="text-primary" />
        Atoma
        {streaming && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />}
      </button>
    );
  }

  return (
    <div
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
      className="fixed z-40 flex flex-col overflow-hidden rounded-lg border border-line bg-surface-2 shadow-2xl"
      role="complementary"
      aria-label="Atoma, the conversation for this workbench"
    >
      <header
        onPointerDown={onDragHeader}
        className="flex shrink-0 cursor-grab items-center gap-1.5 border-b border-line px-2.5 py-1.5"
      >
        <Atom size={13} className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink" title={threadTitle}>
          {threadTitle}
        </span>
        {streaming && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" />}
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setMinimized(true)}
          className="rounded p-0.5 text-ink-3 hover:text-ink"
          title="Minimise"
        >
          <Minimize2 size={12} />
        </button>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
          className="rounded p-0.5 text-ink-3 hover:text-ink"
          title="Close"
        >
          <X size={12} />
        </button>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
        {!recent.length ? (
          <p className="text-[11px] leading-relaxed text-ink-3">
            This is the conversation from the chat view, not a new one. Ask about what is on the workbench — the shot
            you have selected, the shape of the cut, what is still a slug.
          </p>
        ) : (
          recent.map((message) => (
            <div
              key={message.id}
              className={`rounded-md px-2 py-1.5 text-[11px] leading-relaxed ${
                message.role === 'user' ? 'bg-primary/10 text-ink' : 'bg-surface-3 text-ink-2'
              }`}
            >
              <span className="mb-0.5 block text-[9px] uppercase tracking-wide text-ink-3">
                {message.role === 'user' ? 'You' : assistantName}
              </span>
              {/* Plain text on purpose: this panel is for the back-and-forth, and a floating
                  380px column is the wrong place to render code blocks and tool output. Anything
                  that wants reading properly is already in the transcript, unchanged. */}
              <span className="whitespace-pre-wrap break-words">
                {message.content.length > 1200 ? `${message.content.slice(0, 1200)}…` : message.content}
              </span>
            </div>
          ))
        )}
      </div>

      {context && (
        <p className="shrink-0 border-t border-line px-2.5 py-1 text-[9px] text-ink-3" title="What the workbench is showing">
          {context}
        </p>
      )}

      <div className="shrink-0 border-t border-line p-2">
        {blockedReason ? (
          <p className="text-[10px] text-ink-3">{blockedReason}</p>
        ) : (
          <div className="flex items-end gap-1.5">
            <textarea
              rows={2}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder={streaming ? `${assistantName} is answering…` : `Ask ${assistantName}`}
              className="min-h-0 flex-1 resize-none rounded border border-line bg-surface-3 px-2 py-1.5 text-[11px] text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none"
            />
            <button
              type="button"
              onClick={send}
              disabled={!text.trim() || streaming}
              className="rounded bg-primary p-1.5 text-on-primary transition disabled:opacity-40"
              title="Send"
            >
              <Send size={13} />
            </button>
          </div>
        )}
      </div>

      {/* The resize corner. Deliberately plain: a floating panel with chrome on every edge reads
          as a window, and this is not one. */}
      <div
        onPointerDown={onDragCorner}
        role="separator"
        aria-label="Resize Atoma"
        className="absolute bottom-0 right-0 cursor-nwse-resize p-1 text-ink-3"
      >
        <GripHorizontal size={10} />
      </div>
    </div>
  );
}
