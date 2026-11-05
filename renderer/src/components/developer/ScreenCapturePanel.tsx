import { Camera } from 'lucide-react';
import type { ScreenCaptureSettings } from '../../types';

interface Props {
  value: ScreenCaptureSettings;
  onChange: (next: ScreenCaptureSettings) => void;
  disabled: boolean;
}

/**
 * Screen capture: whether every one of them is put to you first.
 *
 * Deliberately blunt about what it gives up, because what it gives up is real: a capture with no
 * window named photographs a whole display, and the display holds whatever is on it. The reason to
 * have the switch at all is that the narrow alternative is not always available — Antimatter skips
 * the question for a capture of its own window, and it can only recognise one when the desktop
 * publishes window titles. A Wayland session does not, so there the only capture that works is the
 * display, and a model checking its own work asks on every single look.
 */
export function ScreenCapturePanel({ value, onChange, disabled }: Props) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={value.withoutAsking}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, withoutAsking: event.target.checked })}
          className="mt-1 accent-[rgb(var(--color-primary))]"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <Camera size={14} className="text-primary" aria-hidden="true" />
            Take screenshots without asking
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-ink-2">
            Under Full access only. A screenshot with no window named photographs one whole display — your other
            windows included — and the picture is saved into the workspace, where the model can be asked to describe
            it. Turn this on while something is building an interface and checking what it drew; turn it off after.
            &ldquo;Ask first&rdquo; still asks for every capture, &ldquo;Read only&rdquo; still refuses them, and
            commands that change the machine are still put to you whatever this says.
          </span>
        </span>
      </label>
    </div>
  );
}
