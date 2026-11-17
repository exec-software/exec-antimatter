import { MonitorCog } from 'lucide-react';
import type { HardwareAccelerationSettings } from '../../types';

interface Props {
  value: HardwareAccelerationSettings;
  onChange: (next: HardwareAccelerationSettings) => void;
  disabled: boolean;
}

/**
 * Whether the browser engine may use the GPU.
 *
 * Antimatter turned this off unconditionally and said only "for performance". The cost that was
 * never written down is WebGL: Chromium's switch is process-wide, with no per-view form, so with
 * the GPU off a WebGL page renders blank in the preview pane — no error, no warning, nothing to
 * debug — and the only way to see your own work is to open a real browser beside the app.
 *
 * Named here as what it actually trades, because on a machine whose GPU is also the inference
 * device the old default was defensible: compositing a window and decoding tokens want the same
 * memory bus. That is a real reason to turn it off, and a bad reason to make everyone blind to
 * their own pages by default.
 */
export function HardwareAccelerationPanel({ value, onChange, disabled }: Props) {
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
            <MonitorCog size={14} className="text-primary" aria-hidden="true" />
            Let the interface use the GPU
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-ink-2">
            Needed for WebGL. With this off, a page that draws with WebGL shows up blank in the preview pane and
            gives no error, so anything built on it can only be checked in a separate browser. Turn it off on a
            machine where the GPU belongs to inference alone and the interface should not touch it — the graphics
            card is shared with any model running locally. <strong className="font-medium text-ink">Takes effect
            after Antimatter restarts</strong>, because the browser engine only accepts this before it starts.
          </span>
        </span>
      </label>
    </div>
  );
}
