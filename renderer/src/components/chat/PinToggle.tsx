import { Pin } from 'lucide-react';

interface Props {
  isPinned: boolean;
  onToggle: () => void;
  compact?: boolean;
}

export function PinToggle({ isPinned, onToggle, compact = false }: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isPinned}
      aria-label={isPinned ? 'Unpin message' : 'Pin message'}
      title={isPinned ? 'Unpin message' : 'Pin message'}
      className={`flex items-center gap-1 rounded p-1 text-[11px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${
        isPinned ? 'text-primary hover:text-primary-strong' : 'text-ink-3 hover:text-ink'
      }`}
    >
      <Pin size={12} />
      {!compact && (isPinned ? 'Pinned' : 'Pin')}
    </button>
  );
}
