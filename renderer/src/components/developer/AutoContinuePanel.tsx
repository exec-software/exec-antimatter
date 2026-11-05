import { FlaskConical } from 'lucide-react';
import { MAX_CONTINUES_CEILING, type AutoContinueSettings } from '../../types';

interface Props {
  value: AutoContinueSettings;
  onChange: (next: AutoContinueSettings) => void;
  disabled: boolean;
}

const CONTINUE_CHOICES = [1, 2, 3, 5, MAX_CONTINUES_CEILING];

/**
 * Auto-continue: carrying on a turn the model put down rather than finished.
 *
 * Deliberately explicit about what it does, because it spends the model's time without being
 * asked again. A smaller model working through a long job stops on the announcement of its next
 * step — "Now let me wire the processor up:" and then nothing — and the cost of that is a person
 * sitting there typing "continue" every few minutes. The cost of getting it wrong is replies
 * spent on a model that had genuinely finished, which is why the allowance is a number and not
 * a switch.
 */
export function AutoContinuePanel({ value, onChange, disabled }: Props) {
  const fieldsDisabled = disabled || !value.enabled;

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
            <FlaskConical size={14} className="text-primary" aria-hidden="true" />
            Carry on a turn that stopped mid-work
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-ink-2">
            A turn ends when the model replies without calling a tool. A smaller model often does that in the middle of
            the job, right after writing what it was about to do next. When that happens, Antimatter tells it to carry
            on instead of handing the turn back — with every tool result from the turn still in front of it, so it
            picks up rather than starts again.
          </span>
        </span>
      </label>

      <div className="mt-3 border-t border-line-soft pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs ${fieldsDisabled ? 'text-ink-3' : 'text-ink-2'}`}>Continue at most</span>
          <div role="group" aria-label="Continues allowed per turn" className="flex items-center gap-1">
            {CONTINUE_CHOICES.map((count) => {
              const active = value.maxContinues === count;
              return (
                <button
                  key={count}
                  type="button"
                  disabled={fieldsDisabled}
                  aria-pressed={active}
                  onClick={() => onChange({ ...value, maxContinues: count })}
                  className={`min-h-7 min-w-8 rounded-md border px-2 text-xs tabular-nums transition disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${
                    active
                      ? 'border-primary bg-primary/10 text-ink'
                      : 'border-line text-ink-2 hover:border-ink-3 hover:text-ink'
                  }`}
                >
                  {count}
                </button>
              );
            })}
          </div>
          <span className={`text-xs ${fieldsDisabled ? 'text-ink-3' : 'text-ink-2'}`}>
            time{value.maxContinues === 1 ? '' : 's'} per turn
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
          The allowance is per turn and is spent whether or not carrying on helped, so a model that cannot get any
          further costs a known number of replies rather than an open-ended number. On a 30B model at about 15 tokens a
          second, each one is a few minutes.
        </p>
      </div>

      <label
        className={`mt-3 flex items-start gap-2 border-t border-line-soft pt-3 text-xs ${
          fieldsDisabled ? 'cursor-default text-ink-3' : 'cursor-pointer text-ink-2'
        }`}
      >
        <input
          type="checkbox"
          checked={value.onRoundLimit}
          disabled={fieldsDisabled}
          onChange={(event) => onChange({ ...value, onRoundLimit: event.target.checked })}
          className="mt-0.5 accent-[rgb(var(--color-primary))]"
        />
        <span>
          Also carry on when a turn runs out of tool calls
          <span className="block text-[11px] leading-relaxed text-ink-3">
            A turn is capped at 64 rounds of tool calls as a guard against a loop, not because the work is expected to
            end there. Reaching it buys another 64 rather than ending the turn, still within the allowance above.
          </span>
        </span>
      </label>

      <p className="mt-3 border-t border-line-soft pt-3 text-[11px] leading-relaxed text-ink-3">
        The model is told plainly that Antimatter continued it and that the user did not, so a nudge is never mistaken
        for a new instruction. Each one is written into the conversation's carbon, so a turn that ran long can be read
        back afterwards to see how much of it was asked for.
      </p>
    </div>
  );
}
