import type { Message } from '../../types';
import { MessageBody } from './MessageBody';
import { PinToggle } from './PinToggle';
import { useConversationUi } from './conversationUi';

/**
 * One turn in the transcript.
 *
 * The two speakers are drawn differently on purpose, and not only by which side they sit on.
 * Before this they were the same rounded box in two shades of near-black, an inch apart on a
 * palette where surface-2 and surface-3 differ by eight points of grey — so the "chat" view read
 * as a slightly ragged version of the structured one beside it.
 *
 * The reader is a quiet surfaced prompt; the reply is unboxed and aligned to the reading column.
 * Product color belongs to live work and decisions, so neither speaker repeats a decorative avatar.
 */

interface Props {
  message: Message;
  isActive: boolean;
  isPinned: boolean;
  onTogglePin: () => void;
}

export function ChatMessageBubble({ message, isActive, isPinned, onTogglePin }: Props) {
  const { assistantName = 'Antimatter' } = useConversationUi();
  const isUser = message.role === 'user';
  const hasContent = message.content.length > 0 || (message.attachments?.length ?? 0) > 0;

  if (isUser) {
    return (
      <article className="group flex justify-end" aria-label="You">
        <div className="relative max-w-[82%] min-w-0">
          <span
            className={`absolute right-full top-1 mr-1 shrink-0 transition ${
              isPinned ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
            }`}
          >
            {hasContent && <PinToggle compact isPinned={isPinned} onToggle={onTogglePin} />}
          </span>
          <div className="min-w-0 rounded-xl border border-line bg-surface-3 px-3.5 py-2.5 text-sm leading-relaxed text-ink">
            <MessageBody message={message} isActive={isActive} />
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="group relative min-w-0" aria-label={`${assistantName} response`}>
      <div className="min-w-0 text-sm leading-relaxed text-ink">
        <MessageBody message={message} isActive={isActive} />
      </div>
      <span
        className={`absolute -right-1 -top-5 shrink-0 transition ${
          isPinned ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
        }`}
      >
        {hasContent && <PinToggle compact isPinned={isPinned} onToggle={onTogglePin} />}
      </span>
    </article>
  );
}
