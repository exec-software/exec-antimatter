/**
 * The rails the tool loop runs a turn behind, and the switches that take them off.
 *
 * Every one of these was added for a model that needed it. A 30B that claims completion three
 * times without doing anything, that re-issues the same search until the turn dies, that asks for
 * sixty tool calls in a reply allowed thirty-two — those are real and they are why the loop has
 * stop conditions at all. What was not foreseen is a locally run model that does none of it. On
 * one of those the same rails are not protection, they are eleven ways for an evening's work to
 * end in a grey note, and the person running it has no way to say so.
 *
 * So they are settings. Not because the defaults are wrong — they are right for the case they
 * were written for — but because which case you are in is a fact about your machine and your
 * model, and only the person at the keyboard knows it. The defaults here are exactly the
 * behaviour that shipped before this file existed, so an install that never opens the page is
 * unchanged.
 *
 * Read `src/main/toolLoop.ts` for what each one does at the point it fires. The numbers live here
 * and the mechanisms live there, which keeps this file something a person can read straight down.
 */

/** A rail that counts: how many times something may happen before the turn ends. */
export interface GuardrailLimit {
  enabled: boolean;
  limit: number;
}

/** A rail with nothing to tune: it is on or it is not. */
export interface GuardrailSwitch {
  enabled: boolean;
}

export interface GuardrailSettings {
  /**
   * What one allowance buys, counted in tool calls.
   *
   * Off means a turn runs until it answers, loops, or the person stops it. That is a real choice
   * on a local model and a bad one on a metered endpoint, which is why it is a switch rather than
   * a very large number: a number invites raising it until it stops meaning anything.
   */
  turnBudget: GuardrailLimit;
  /** Consecutive replies asking for more tool calls than one reply may carry. Ends as `flooding`. */
  batchOverrun: GuardrailLimit;
  /** Identical calls, same arguments, in a row. Ends as `stalled`. */
  repeatedCalls: GuardrailLimit;
  /** Replies claiming completion while doing no productive work. Ends as `no-progress`. */
  completionClaims: GuardrailLimit;
  /** Completion claims re-reporting validation results already seen. Ends as `no-progress`. */
  repeatedValidation: GuardrailLimit;
  /** Retries offered when the output lid cut a reply off mid-deliberation. */
  thinkingRetries: GuardrailLimit;
  /** Retries offered when a reply held its whole answer inside its thinking and ended. */
  thinkingOnlyRetries: GuardrailLimit;
  /**
   * Collapse repeated read calls within one batch.
   *
   * Window economy rather than a rail against the model: a file read twice in one reply cannot
   * say anything the first read did not, and the second copy is still in the window. Measured on
   * carbon 95bf32a1 at 39% of one round's 16,110 tokens of results.
   */
  duplicateReads: GuardrailSwitch;
}

/**
 * Not here, deliberately: the write seam.
 *
 * A file written in parts can begin its next part by repeating the lines it ended on, and the
 * loop drops those before anyone is asked to approve the write. That reads like window economy
 * and is not — switching it off does not waste tokens, it writes the duplicated lines into the
 * person's source file. A settings page that can corrupt a file is not offering a choice, so
 * this one stays on and is not listed as a rail.
 */

/**
 * The behaviour that shipped before any of this was switchable.
 *
 * Changing a number here changes what every install does by default, including the ones that
 * never open the page. The place to be generous is the page, not this object.
 */
export const DEFAULT_GUARDRAILS: GuardrailSettings = {
  turnBudget: { enabled: true, limit: 2048 },
  batchOverrun: { enabled: true, limit: 3 },
  repeatedCalls: { enabled: true, limit: 3 },
  completionClaims: { enabled: true, limit: 3 },
  repeatedValidation: { enabled: true, limit: 3 },
  thinkingRetries: { enabled: true, limit: 2 },
  thinkingOnlyRetries: { enabled: true, limit: 2 },
  duplicateReads: { enabled: true },
};

/**
 * The widest a counting rail may be set to.
 *
 * A rail set past this is not a rail, and the switch is the honest way to say that. Keeping a
 * ceiling on the number means a stored or hand-edited file cannot quietly turn a guard into an
 * unbounded loop while still reading as enabled on the page.
 */
export const MAX_GUARDRAIL_LIMIT = 100_000;

const limit = (value: unknown, fallback: GuardrailLimit): GuardrailLimit => {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<GuardrailLimit>;
  const requested = Number(source.limit);
  return {
    enabled: source.enabled !== false,
    limit: Number.isFinite(requested) && requested >= 1
      ? Math.min(MAX_GUARDRAIL_LIMIT, Math.trunc(requested))
      : fallback.limit,
  };
};

const toggle = (value: unknown, fallback: GuardrailSwitch): GuardrailSwitch => {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<GuardrailSwitch>;
  return { enabled: source.enabled !== false };
};

export function normalizeGuardrails(value: unknown): GuardrailSettings {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<GuardrailSettings>;
  return {
    turnBudget: limit(source.turnBudget, DEFAULT_GUARDRAILS.turnBudget),
    batchOverrun: limit(source.batchOverrun, DEFAULT_GUARDRAILS.batchOverrun),
    repeatedCalls: limit(source.repeatedCalls, DEFAULT_GUARDRAILS.repeatedCalls),
    completionClaims: limit(source.completionClaims, DEFAULT_GUARDRAILS.completionClaims),
    repeatedValidation: limit(source.repeatedValidation, DEFAULT_GUARDRAILS.repeatedValidation),
    thinkingRetries: limit(source.thinkingRetries, DEFAULT_GUARDRAILS.thinkingRetries),
    thinkingOnlyRetries: limit(source.thinkingOnlyRetries, DEFAULT_GUARDRAILS.thinkingOnlyRetries),
    duplicateReads: toggle(source.duplicateReads, DEFAULT_GUARDRAILS.duplicateReads),
  };
}

/**
 * The numbers the loop compares against, with the switches already applied.
 *
 * A stop condition that is off becomes a threshold nothing reaches, so the loop keeps one code
 * path rather than a condition wrapped in a test at every site. A retry that is off becomes zero
 * attempts, which is the same sentence read the other way: there is no allowance to spend.
 *
 * `tracked` is separate from an infinite threshold on purpose. The repeat detector keeps a window
 * of recent call signatures, and a threshold of Infinity would grow that window for the whole
 * turn to feed a comparison that can never be true — on a turn running thousands of calls that is
 * a leak in aid of nothing. Off means the bookkeeping stops too.
 */
export interface ResolvedGuardrails {
  /** Tool calls one allowance buys, or Infinity when the budget is off. */
  callBudget: number;
  batchOverrun: number;
  repeatedCalls: number;
  /** Whether to keep the window of recent call signatures at all. */
  trackRepeats: boolean;
  completionClaims: number;
  repeatedValidation: number;
  thinkingRetries: number;
  thinkingOnlyRetries: number;
  duplicateReads: boolean;
}

const threshold = (rail: GuardrailLimit): number => (rail.enabled ? rail.limit : Number.POSITIVE_INFINITY);
const attempts = (rail: GuardrailLimit): number => (rail.enabled ? rail.limit : 0);

export function resolveGuardrails(value?: GuardrailSettings | null): ResolvedGuardrails {
  const rails = value ?? DEFAULT_GUARDRAILS;
  return {
    callBudget: threshold(rails.turnBudget),
    batchOverrun: threshold(rails.batchOverrun),
    repeatedCalls: threshold(rails.repeatedCalls),
    trackRepeats: rails.repeatedCalls.enabled,
    completionClaims: threshold(rails.completionClaims),
    repeatedValidation: threshold(rails.repeatedValidation),
    thinkingRetries: attempts(rails.thinkingRetries),
    thinkingOnlyRetries: attempts(rails.thinkingOnlyRetries),
    duplicateReads: rails.duplicateReads.enabled,
  };
}
