import { HardDrive } from 'lucide-react';
import type { MachineWideSettings } from '../../types';

interface Props {
  value: MachineWideSettings;
  onChange: (next: MachineWideSettings) => void;
  disabled: boolean;
}

/**
 * Commands that change the machine rather than the project.
 *
 * Full access is permission over a directory. A command line is the one tool argument that can
 * step outside it, so those calls are put to you even there, and the default is not caution for
 * its own sake: asked for a drawing program, a model once worked around a missing ImageTk by
 * installing Pillow in front of every Python program on the machine.
 *
 * The switch exists because that trade inverts on a box you own and expect to change. Where
 * `sudo` is already wired to a Vault credential and the afternoon's work is a dozen
 * `apt-get install` lines, the question has one answer and asking it each time is a dozen
 * dialogs. Blunt about what it gives up, because what it gives up is real and outlives the turn.
 */
export function MachineWidePanel({ value, onChange, disabled }: Props) {
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
            <HardDrive size={14} className="text-primary" aria-hidden="true" />
            Run commands that change the machine without asking
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-ink-2">
            Under Full access only. Commands run as root, system package installs and removals, and installs that
            land outside a virtual environment stop being put to you — these change things no later edit undoes, and
            they affect every program you run, not just this project. Turn it on for a machine you expect a model to
            set up; turn it off after. &ldquo;Ask first&rdquo; still asks, &ldquo;Read only&rdquo; still refuses, and
            screen captures and sending an image to a vision source elsewhere remain their own questions.
          </span>
        </span>
      </label>
    </div>
  );
}
