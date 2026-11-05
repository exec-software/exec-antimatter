import { FileText, X } from 'lucide-react';
import type { Attachment } from '../../types';

interface Props {
  attachment: Attachment;
  onRemove?: () => void;
}

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;

export function AttachmentChip({ attachment, onRemove }: Props) {
  return (
    <span
      title={attachment.name}
      className="flex min-w-0 max-w-[240px] items-center gap-1.5 rounded-md border border-line bg-surface-2 py-1 pl-2 pr-1.5 text-[11px] text-ink-2"
    >
      <FileText size={12} className="shrink-0 text-accent" />
      <span className="truncate text-ink">{attachment.name}</span>
      <span className="shrink-0 text-ink-3">{formatSize(attachment.size)}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${attachment.name}`}
          className="shrink-0 rounded p-0.5 text-ink-3 transition hover:bg-surface-3 hover:text-ink"
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}
