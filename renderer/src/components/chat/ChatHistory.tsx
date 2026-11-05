import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, Check, Copy, Pencil } from 'lucide-react';
import { sittingLabel, startsSitting } from '../../lib/conversation';
import { isActiveReply } from '../../lib/telemetry';
import { useFollowScroll } from '../../lib/useFollowScroll';
import type { Message } from '../../types';
import { ChatMessageBubble } from './ChatMessageBubble';

interface Props {
  messages: Message[];
  isStreaming: boolean;
  pinnedMessageIds: Set<string>;
  onTogglePin: (message: Message) => void;
  /** Puts a message you sent back in the composer, to change and send again. */
  onEditMessage?: (message: Message) => void;
  /** Room kept free on the right for the panel that floats there. */
  insetRight?: number;
}

const actionClass =
  'flex size-7 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70';

/** Copy and edit, under a message you sent. */
function MessageActions({ message, onEdit, persistent }: { message: Message; onEdit?: () => void; persistent: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!message.content) return null;
  return (
    <div
      className={`mt-1 flex justify-end gap-0.5 transition ${
        persistent ? '' : 'opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100'
      }`}
    >
      <button
        type="button"
        aria-label={copied ? 'Copied' : 'Copy message'}
        title={copied ? 'Copied' : 'Copy'}
        onClick={() => {
          void navigator.clipboard.writeText(message.content).then(() => setCopied(true));
        }}
        className={actionClass}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      {onEdit && (
        <button type="button" aria-label="Edit and resend" title="Edit and resend" onClick={onEdit} className={actionClass}>
          <Pencil size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * A tick for each thing you asked, down the left edge. The one in view is lit, and each is a way
 * back to where that part of the conversation began.
 */
function TurnRail({
  turns,
  current,
  onJump,
}: {
  turns: Message[];
  current: string | null;
  onJump: (id: string) => void;
}) {
  if (turns.length < 2) return null;
  return (
    <nav
      aria-label="Your messages"
      className="absolute left-2 top-1/2 z-10 flex max-h-[70%] -translate-y-1/2 flex-col justify-between gap-[5px] overflow-hidden py-1"
    >
      {turns.map((turn) => {
        const lit = turn.id === current;
        return (
          <button
            key={turn.id}
            type="button"
            onClick={() => onJump(turn.id)}
            aria-label={`Go to: ${turn.content.slice(0, 80) || 'attachment'}`}
            aria-current={lit ? 'true' : undefined}
            title={turn.content.slice(0, 120)}
            className="group/tick flex h-[5px] w-5 shrink items-center focus-visible:outline-none"
          >
            <span
              className={`block h-[2px] rounded-full transition-all ${
                lit ? 'w-4 bg-ink' : 'w-2.5 bg-ink-3 group-hover/tick:w-4 group-hover/tick:bg-ink-2 group-focus-visible/tick:bg-primary'
              }`}
            />
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Transcript: the conversation, read as a conversation.
 *
 * A reading column rather than the full pane — a reply set across 1,400 pixels is not readable —
 * with the turns spaced far enough apart to be separate thoughts. Atlas is the view for density;
 * this one is for following what was said.
 */
export function ChatHistory({ messages, isStreaming, pinnedMessageIds, onTogglePin, onEditMessage, insetRight = 0 }: Props) {
  const { scrollRef, contentRef, onScroll, hasNewActivity, jumpToLatest } = useFollowScroll(
    messages.length,
    messages,
    { preservePosition: true }
  );
  const turns = messages.filter((message) => message.role === 'user');
  const lastTurnId = turns[turns.length - 1]?.id ?? null;
  const [currentTurn, setCurrentTurn] = useState<string | null>(lastTurnId);
  const frame = useRef(0);

  // The lit tick is the last question whose start has scrolled above the upper third — or, at the
  // bottom of the conversation, simply the last question, which may start lower than that.
  const locate = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    if (container.scrollHeight - container.scrollTop - container.clientHeight < 8) {
      setCurrentTurn(lastTurnId);
      return;
    }
    const line = container.getBoundingClientRect().top + container.clientHeight / 3;
    let found: string | null = null;
    for (const element of container.querySelectorAll<HTMLElement>('[data-turn-id]')) {
      if (element.getBoundingClientRect().top <= line) found = element.dataset.turnId ?? found;
      else break;
    }
    setCurrentTurn(found ?? lastTurnId);
  }, [scrollRef, lastTurnId]);

  useEffect(() => {
    locate();
  }, [locate, messages.length]);

  const handleScroll = () => {
    onScroll();
    window.cancelAnimationFrame(frame.current);
    frame.current = window.requestAnimationFrame(locate);
  };

  const jumpTo = (id: string) => {
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`);
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return (
    <div className="absolute inset-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto py-6 pl-10 pr-4"
        style={insetRight ? { paddingRight: insetRight } : undefined}
      >
        <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col">
          {messages.map((message, index) => {
            const previous = messages[index - 1];
            const isUser = message.role === 'user';
            const sitting = isUser && startsSitting(previous?.meta?.createdAt, message.meta?.createdAt);
            const spacing =
              index === 0 ? '' : message.role === 'assistant' && previous?.role === 'user' ? 'mt-3' : 'mt-8';
            return (
              <div
                key={message.id}
                className={`group/turn ${spacing}`}
                data-turn-id={isUser ? message.id : undefined}
                style={isUser ? { scrollMarginTop: 16 } : undefined}
              >
                {sitting && message.meta?.createdAt && (
                  <p className={`mb-6 text-center text-xs text-ink-3 ${index === 0 ? '' : 'mt-2'}`}>
                    {sittingLabel(message.meta.createdAt)}
                  </p>
                )}
                <ChatMessageBubble
                  message={message}
                  isActive={isActiveReply(message, index === messages.length - 1, isStreaming)}
                  isPinned={pinnedMessageIds.has(message.id)}
                  onTogglePin={() => onTogglePin(message)}
                />
                {isUser && (
                  <MessageActions
                    message={message}
                    persistent={message.id === lastTurnId}
                    onEdit={onEditMessage && !isStreaming ? () => onEditMessage(message) : undefined}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <TurnRail turns={turns} current={currentTurn} onJump={jumpTo} />

      {hasNewActivity && (
        <>
          <span role="status" aria-live="polite" className="sr-only">
            New conversation activity is available.
          </span>
          <button
            type="button"
            onClick={jumpToLatest}
            aria-label="Jump to latest conversation activity"
            className="absolute bottom-3 left-1/2 z-10 flex min-h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-2 shadow-lg shadow-black/35 transition hover:border-ink-3 hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <ArrowDown size={14} aria-hidden="true" />
            New activity
          </button>
        </>
      )}
    </div>
  );
}
