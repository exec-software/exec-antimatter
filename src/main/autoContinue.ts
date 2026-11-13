/**
 * Carrying on a turn a smaller model has put down rather than finished.
 *
 * A 30B model asked to do a large job will do a great deal of it and then stop in the middle,
 * usually in the most recognisable way there is: it writes what it is about to do next and then
 * ends its reply. "Now let me wire the processor up to the controller:" — and nothing. There was
 * no error, the round ceiling was nowhere near, and the tools all worked. It simply stopped, and
 * the turn ends, and the person types "continue", and it carries on for another ten minutes.
 *
 * Deciding that from the text is a guess, so the rules here are deliberately narrow: the turn
 * must already have been working (it ran tools), the reply must have made no tool call, and it
 * must end on an announcement of a next step rather than on an account of a finished one. Every
 * nudge is counted against a ceiling the person sets, so a model that never gets anywhere costs
 * a known number of replies instead of an open-ended number.
 */

export interface AutoContinueSettings {
  enabled: boolean;
  /** How many times one turn may be carried on. Zero disables it as surely as `enabled: false`. */
  maxContinues: number;
  /** Also carry on a turn that was cut off by the tool-loop round ceiling. */
  onRoundLimit: boolean;
}

export const DEFAULT_AUTO_CONTINUE: AutoContinueSettings = {
  enabled: false,
  maxContinues: 3,
  onRoundLimit: true,
};

/**
 * Bounded so a stored or remote value cannot turn one turn into an unbounded series of them.
 *
 * It was 10, which is a ceiling on the wrong thing. The allowance is shared with the round-limit
 * extension, so a turn doing real work spends it on rounds it was always going to need: carbon
 * 43b94a71 ran a single turn to 101 rounds of tool calls, and reaching 64 cost it one of the ten
 * before a single mid-work stop had happened. A model that can hold a chain together for hours —
 * Laguna-s 2.1 has run whole evenings here — is not the case this number was protecting against.
 * It is high enough now to be a backstop rather than a budget, and the person still sets it.
 */
export const MAX_CONTINUES_CEILING = 50;

export function normalizeAutoContinue(value: unknown): AutoContinueSettings {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<AutoContinueSettings>;
  const requested = Number(source.maxContinues);
  return {
    enabled: source.enabled === true,
    maxContinues: Number.isFinite(requested)
      ? Math.min(MAX_CONTINUES_CEILING, Math.max(0, Math.trunc(requested)))
      : DEFAULT_AUTO_CONTINUE.maxContinues,
    onRoundLimit: source.onRoundLimit !== false,
  };
}

/**
 * Phrases a reply ends on when the next step is still ahead of it.
 *
 * Anchored to the end of the text, because the same words in the middle of a paragraph are an
 * account of something already done. "Let me check the header" as a closing line is a model
 * about to check a header; the same sentence four lines up is one that already has.
 */
const ANNOUNCES_NEXT_STEP: RegExp[] = [
  /\b(?:now |next,? |then )?(?:let me|let's|let us|i(?:'ll| will| am going to| am now going to))\b[^.!?\n]*[:.]?\s*$/i,
  /\b(?:continuing|proceeding|moving on|carrying on)\b[^.!?\n]*[:.]?\s*$/i,
  /\b(?:next steps?|remaining|still (?:to do|needed|left))\b\s*[:]\s*$/i,
];

/**
 * The same words, turned around to face the person: "Let me know if you want it tuned", "I'll
 * let you know how it goes". Those are a reply handing the work back on purpose, which is the
 * one thing auto-continue must never talk over — so a closing line about the reader is left
 * alone whatever else it looks like.
 */
const ADDRESSED_TO_THE_PERSON = /\byou(?:r|rs|'d|'ll|'ve)?\b/i;

/** An odd number of fences means the reply ended inside a block it never closed. */
const endsInsideCodeFence = (text: string): boolean => (text.match(/^```/gm)?.length ?? 0) % 2 === 1;

/**
 * Whether a reply that called no tool reads as a stopping point rather than an answer.
 *
 * The last non-empty line carries the verdict. A reply that ends on a heading, a bullet list of
 * what was delivered, or a closing sentence is finished work, however much is left in the wider
 * job; the person is the one who decides whether to ask for more of that.
 */
export function stoppedMidWork(text: string): boolean {
  const trimmed = text.trim();
  // A reply with nothing in it and no tool call is not an answer by any reading.
  if (!trimmed) return true;
  if (endsInsideCodeFence(trimmed)) return true;

  const lastLine = trimmed.split('\n').filter((line) => line.trim()).pop() ?? '';
  const candidate = lastLine.replace(/[*_`#>\s-]+$/, '').trim();
  if (!candidate || ADDRESSED_TO_THE_PERSON.test(candidate)) return false;
  return ANNOUNCES_NEXT_STEP.some((pattern) => pattern.test(candidate));
}

/**
 * Why a turn is being carried on, which is what the transcript and the carbon record.
 *
 * The last two are not decided here and are not subject to these settings. A reply the output lid
 * cut off mid-deliberation (`ran-out-thinking`) and a reply that held its whole answer inside its
 * thinking and then ended (`thought-without-answering`) are both a model that wrote no answer at
 * all, which is not a model choosing to stop, so there is nothing to guess at. The loop owns them
 * — see RAN_OUT_THINKING and THOUGHT_WITHOUT_ANSWERING there — and reports them through the same
 * channel so one reader covers every reason a turn went round again.
 */
export type AutoContinueReason =
  | 'stopped-mid-work'
  | 'round-limit'
  | 'ran-out-thinking'
  | 'thought-without-answering';

export const AUTO_CONTINUE_NUDGE: Record<
  Exclude<AutoContinueReason, 'ran-out-thinking' | 'thought-without-answering'>,
  string
> = {
  'stopped-mid-work':
    'You stopped in the middle of the work rather than finishing it, and this is Antimatter ' +
    'continuing you automatically — not the user. Carry straight on with the next step you just ' +
    'named. Do not summarize what you have done, do not ask whether to proceed, and do not start ' +
    'again from the beginning: every tool result from this turn is still in front of you. When ' +
    'the job really is done, say so plainly and stop.',
  'round-limit':
    'You reached this turn\'s tool-call ceiling and Antimatter has extended it so you can carry ' +
    'on — this is not the user writing. Continue from exactly where you were. If what remains is ' +
    'larger than the rest of this turn, do the most important part first and say what is left.',
};

/**
 * The decision, kept away from the loop so it can be read and tested on its own.
 *
 * `used` is how many times this turn has already been carried on, so exhausting the allowance
 * ends the turn in the ordinary way rather than quietly looping.
 */
export function shouldAutoContinue(
  settings: AutoContinueSettings,
  input: {
    reason: AutoContinueReason;
    used: number;
    /** Tool calls this turn actually executed. A turn that ran none was never mid-work. */
    executedToolCalls: number;
    /** The reply's text; only consulted for a turn that stopped without calling a tool. */
    content: string;
  }
): boolean {
  // The loop decides these two on the reply itself and does not ask; answering here would put an
  // opt-in setting between a reply that never reached an answer and its retry.
  if (input.reason === 'ran-out-thinking' || input.reason === 'thought-without-answering') return false;
  if (!settings.enabled || input.used >= settings.maxContinues) return false;
  if (input.executedToolCalls === 0) return false;
  if (input.reason === 'round-limit') return settings.onRoundLimit;
  return stoppedMidWork(input.content);
}
