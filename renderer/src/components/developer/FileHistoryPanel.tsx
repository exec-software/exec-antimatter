import { History } from 'lucide-react';
import type { FileHistorySettings } from '../../types';

interface Props {
  value: FileHistorySettings;
  onChange: (next: FileHistorySettings) => void;
  disabled: boolean;
}

/**
 * Experimental local file history.
 *
 * A carbon records why a turn did what it did and deliberately keeps no data — enough to be
 * evidence, not the whole file. So the audit can name the exact turn that ruined something and
 * cannot give it back. This is the other half, and the reason it lives inside the tool rather
 * than in a prompt: an agent that means to commit first and then does not is the ordinary case,
 * and the protection has to sit somewhere there is no decision to make.
 *
 * Blunt about the two things it does not do, because both are the kind of thing someone would
 * otherwise discover in the one moment they were relying on it.
 */
export function FileHistoryPanel({ value, onChange, disabled }: Props) {
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
            <History size={14} className="text-primary" aria-hidden="true" />
            Keep local file history
            <span className="rounded-full bg-warning-bg px-1.5 py-0.5 text-[10px] font-normal text-warning">
              experimental
            </span>
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-ink-2">
            Before a tool changes a file, what it held is stored in a <code>.antimatter</code> directory inside the
            workspace, so a change you only recognise as wrong an hour later can be put back per file or per turn.
            The directory ignores itself in git and is never pushed, and old versions are evicted once it grows past
            its budget. It also holds a shared scratch area, so one agent&rsquo;s intermediate files are visible to
            the next instead of being rebuilt.
          </span>
          <span className="mt-1.5 block text-xs leading-relaxed text-ink-3">
            Two limits worth knowing before you rely on it. It covers the tools that edit files, and{' '}
            <strong className="font-medium text-ink-2">not the shell</strong> — a command that deletes a tree is
            still unprotected. And while it is on, a write whose previous state cannot be stored{' '}
            <strong className="font-medium text-ink-2">fails instead of proceeding</strong>, because a safety net
            with silent holes is worse than none.
          </span>
        </span>
      </label>
    </div>
  );
}
