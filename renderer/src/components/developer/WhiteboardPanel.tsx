import { Presentation } from 'lucide-react';
import type { WhiteboardSettings } from '../../types';

interface Props {
  value: WhiteboardSettings;
  onChange: (next: WhiteboardSettings) => void;
  disabled: boolean;
}

/**
 * The whiteboard experiment.
 *
 * A surface per conversation that both a person and the model put objects on, so planning can
 * happen the way it does around a real board rather than only in prose. It is structured rather
 * than drawn — notes, comments and positions — which is what lets the model read it exactly and
 * add to it, instead of squinting at a picture.
 *
 * Experimental in the plain sense: unfinished. Ink, images and grouping are not built yet, so a
 * board today holds notes and comments and little else.
 */
export function WhiteboardPanel({ value, onChange, disabled }: Props) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
          className="mt-1 accent-[rgb(var(--color-primary))]"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <Presentation size={14} className="text-primary" aria-hidden="true" />
            Enable the whiteboard
            <span className="rounded-full bg-warning-bg px-1.5 py-0.5 text-[10px] font-normal text-warning">
              experimental
            </span>
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-ink-2">
            Adds <strong className="font-medium text-ink">Whiteboard</strong> to the Desk, which opens the current
            conversation&rsquo;s board. Put notes on it, drag them around, and the model can read the surface and add
            to it — everything carries who put it there, so your own thinking stays distinguishable from a
            suggestion. Each board is kept with the app&rsquo;s data, never in the project, and goes when its
            conversation does.
          </span>
          <span className="mt-1.5 block text-xs leading-relaxed text-ink-3">
            Unfinished rather than risky: notes and comments work, and drawing, images and grouping are not built
            yet.
          </span>
        </span>
      </label>
    </div>
  );
}
