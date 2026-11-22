import { AlertTriangle, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { MAX_GUARDRAIL_LIMIT, type GuardrailLimit, type GuardrailSettings } from '../../types';

interface Props {
  value: GuardrailSettings;
  onChange: (next: GuardrailSettings) => void;
  disabled: boolean;
}

type LimitKey = {
  [K in keyof GuardrailSettings]: GuardrailSettings[K] extends GuardrailLimit ? K : never;
}[keyof GuardrailSettings];

interface RailCopy {
  key: LimitKey;
  title: string;
  /** What the number counts, read after it: "3 replies in a row". */
  unit: string;
  /** The stop reason the carbon records, or null for a rail that retries rather than stops. */
  ends: string | null;
  blurb: ReactNode;
}

/**
 * Every counting rail in the tool loop, in the order a turn meets them.
 *
 * The descriptions say what the rail was written for, not just what it does. A switch whose only
 * label is its own name is a switch nobody dares touch, and the whole point of this page is that
 * the person running a model Antimatter has never met is better placed than Antimatter to say
 * which of these are helping.
 */
const RAILS: RailCopy[] = [
  {
    key: 'turnBudget',
    title: 'Turn budget',
    unit: 'tool calls per allowance',
    ends: 'limit',
    blurb: (
      <>
        How much work one turn may do before auto-continue has to buy it more. Counted in tool calls rather than
        replies, because a model that puts one call in each reply would otherwise get a thirty-second of the budget
        a model that fills its batch gets. Switch it off and a turn runs until it answers, loops, or you stop it
        &mdash; there is no second ceiling behind this one.
      </>
    ),
  },
  {
    key: 'repeatedCalls',
    title: 'Repeated calls',
    unit: 'identical calls in a row',
    ends: 'stalled',
    blurb: (
      <>
        The same tool with the same arguments, over and over. Two in a row is ordinary &mdash; re-reading a file
        after an edit, retrying a command. Three with nothing in between is a loop no further round will break.
        This is the main thing standing between a stuck model and your whole turn budget.
      </>
    ),
  },
  {
    key: 'batchOverrun',
    title: 'Oversized batches',
    unit: 'over-cap replies in a row',
    ends: 'flooding',
    blurb: (
      <>
        Replies asking for more tool calls than one reply may carry. One is a misjudgement and the note saying the
        batch was cut is usually enough; the case this catches is a model whose context was just compacted emitting
        a degenerate batch, being told, and emitting another.
      </>
    ),
  },
  {
    key: 'completionClaims',
    title: 'Hollow completion claims',
    unit: 'claims without productive work',
    ends: 'no-progress',
    blurb: (
      <>
        Replies that say the job is done while only printing a success message or exiting the shell. Rewording the
        echo must not buy another round of the same.
      </>
    ),
  },
  {
    key: 'repeatedValidation',
    title: 'Recycled validation',
    unit: 'claims re-reporting known results',
    ends: 'no-progress',
    blurb: (
      <>
        Completion claims resting on checks already run, with nothing done in between. Repeating a passing test does
        not make the next claim about it true.
      </>
    ),
  },
  {
    key: 'thinkingRetries',
    title: 'Cut off mid-thought',
    unit: 'retries',
    ends: null,
    blurb: (
      <>
        When the output limit cuts a reply off while the model is still deliberating, it is asked for the step
        again rather than the turn ending on half a sentence. Costs a full prompt and reply each time, so it is
        bounded low. Not a stop condition: switching it off ends those turns instead of retrying them.
      </>
    ),
  },
  {
    key: 'thinkingOnlyRetries',
    title: 'Thought without answering',
    unit: 'retries',
    ends: null,
    blurb: (
      <>
        The same courtesy for a reply that was not cut off at all: the model reasoned, then ended its turn with no
        answer and no tool call. Told apart from the one above by the finish reason, because the two look identical
        in a transcript and have different causes.
      </>
    ),
  },
];

/** The rails whose job is to end a stuck turn, as opposed to retrying or saving window. */
const STOP_CONDITIONS: LimitKey[] = ['repeatedCalls', 'batchOverrun', 'completionClaims', 'repeatedValidation'];

function Row({
  rail,
  value,
  disabled,
  onChange,
}: {
  rail: RailCopy;
  value: GuardrailLimit;
  disabled: boolean;
  onChange: (next: GuardrailLimit) => void;
}) {
  return (
    <div className="border-t border-line py-3 first:border-t-0 first:pt-0">
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
          className="mt-1 accent-[rgb(var(--color-primary))]"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
            {rail.title}
            {rail.ends && (
              <span className="rounded-full bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] font-normal text-ink-3">
                {rail.ends}
              </span>
            )}
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-ink-2">{rail.blurb}</span>
        </span>
      </label>
      <div className="mt-2 flex items-center gap-2 pl-6">
        <input
          type="number"
          min={1}
          max={MAX_GUARDRAIL_LIMIT}
          value={value.limit}
          disabled={disabled || !value.enabled}
          aria-label={`${rail.title}: ${rail.unit}`}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next) && next >= 1) onChange({ ...value, limit: Math.trunc(next) });
          }}
          className="w-24 rounded border border-line bg-surface px-2 py-1 text-xs text-ink disabled:opacity-50"
        />
        <span className="text-xs text-ink-3">{rail.unit}</span>
      </div>
    </div>
  );
}

/**
 * The tool-loop rails, with a switch and a number on each.
 *
 * These were all written for models that needed them, and they are right for those models. On one
 * that holds a long chain together without any of this they are not protection, they are ways for
 * an evening&rsquo;s work to end in a grey note &mdash; so which ones are on is the person&rsquo;s
 * call, and this page says plainly what each one is for so the call can be an informed one.
 */
export function GuardrailsPanel({ value, onChange, disabled }: Props) {
  const stopsOff = STOP_CONDITIONS.every((key) => !value[key].enabled);
  const budgetOff = !value.turnBudget.enabled;

  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <p className="mb-3 flex items-start gap-1.5 text-xs leading-relaxed text-ink-2">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
        <span>
          Each of these ends or extends a turn on Antimatter&rsquo;s judgement rather than yours. They are on by
          default because the behaviour they catch is real; they are switchable because whether your model does any
          of it is something only you can see.
        </span>
      </p>

      {RAILS.map((rail) => (
        <Row
          key={rail.key}
          rail={rail}
          value={value[rail.key]}
          disabled={disabled}
          onChange={(next) => onChange({ ...value, [rail.key]: next })}
        />
      ))}

      <div className="border-t border-line pt-3">
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={value.duplicateReads.enabled}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, duplicateReads: { enabled: event.target.checked } })}
            className="mt-1 accent-[rgb(var(--color-primary))]"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink">Collapse repeated reads in one batch</span>
            <span className="mt-1 block text-xs leading-relaxed text-ink-2">
              Window economy rather than a rail: a file read twice in the same reply cannot say anything the first
              read did not, and the second copy still takes up the window. Measured once at 39% of a round&rsquo;s
              16,110 tokens of results. Nothing is dropped across replies, and a repeated command is always run.
            </span>
          </span>
        </label>
      </div>

      {(stopsOff || budgetOff) && (
        <p className="mt-3 flex items-start gap-1.5 rounded border border-warning-bg bg-warning-bg px-2 py-1.5 text-xs leading-relaxed text-warning">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {stopsOff && budgetOff
              ? 'With every stop condition off and no turn budget, nothing here will end a looping turn — it runs until it answers or you press stop.'
              : stopsOff
                ? 'With every stop condition off, a looping turn runs to the end of its budget before it says anything.'
                : 'With no turn budget, a turn is bounded only by the stop conditions above and by you.'}
          </span>
        </p>
      )}
    </div>
  );
}
