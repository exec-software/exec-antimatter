import { CornerDownLeft, Pencil, X, Zap } from 'lucide-react';

/**
 * A note typed while the model is still working, waiting its turn.
 *
 * It sits above the composer rather than joining the transcript, because it has not been said
 * yet — the model has not seen it and may never, if you change your mind. The default is to wait
 * for the model to be between things, which is where a correction lands cleanly; "now" cuts the
 * current generation short instead, keeping whatever it had already written.
 */

interface Props {
  note: string;
  /** True once the model has taken it up, so the bubble can bow out rather than vanish. */
  delivered?: boolean;
  onEdit(): void;
  onCancel(): void;
  onSteerNow(): void;
}

const action =
  'flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink';

export function PendingSteer({ note, delivered = false, onEdit, onCancel, onSteerNow }: Props) {
  return (
    <div
      className={`mb-2 flex flex-wrap items-start gap-2 rounded-lg border px-2.5 py-2 transition ${
        delivered ? 'border-accent/40 bg-accent/5' : 'border-primary/40 bg-primary/5'
      }`}
    >
      <CornerDownLeft size={13} className={`mt-0.5 shrink-0 ${delivered ? 'text-accent' : 'text-primary'}`} />
      <div className="min-w-0 flex-1">
        <p className={`text-[10px] font-medium uppercase tracking-wide ${delivered ? 'text-accent' : 'text-primary'}`}>
          {delivered ? 'Picked up' : 'Waiting for a gap'}
        </p>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-ink">{note}</p>
      </div>

      {!delivered && (
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={onSteerNow} title="Interrupt the model and send this now" className={action}>
            <Zap size={11} />
            Steer now
          </button>
          <button type="button" onClick={onEdit} title="Put it back in the composer" className={action}>
            <Pencil size={11} />
            Edit
          </button>
          <button type="button" onClick={onCancel} title="Discard it" className={action}>
            <X size={11} />
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
