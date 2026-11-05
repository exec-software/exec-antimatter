/**
 * Questions the model puts to the person, and the answers that come back.
 *
 * Until now a turn had two ways to deal with not knowing something, and both were bad. It could
 * guess, and be wrong somewhere expensive. Or it could stop, write "which did you mean?", and end
 * the turn — losing the thread of work, because the next message starts a fresh one. Neither is
 * what a person does when a colleague is in the room: they ask, get four words back, and carry on.
 *
 * That is what this is. A question is a tool call, so it happens *inside* the turn: the model
 * blocks on it, the answer arrives as the call's result, and the work continues in the same turn
 * with the same context. The person answers in one click.
 *
 * Rules the type enforces rather than leaving to each caller:
 *
 *  - **A question is bounded.** At most four questions, four options each, and every string
 *    capped. A model that asks twelve things has not understood the task, and the person should
 *    not have to scroll a transcript to find the end of an interrogation.
 *  - **"Something else" is never the model's to withhold.** Free text is always available, so a
 *    badly framed question with four wrong options is still answerable. `options` is a shortcut
 *    for the common answers, not a menu the person is trapped in.
 *  - **Options are distinct.** Two identically labelled options make the answer ambiguous — the
 *    result names labels, so duplicates would be indistinguishable to the model that asked.
 *  - **Nothing here is instructions.** A question's text is rendered as data in the card and
 *    echoed back as data in the result.
 *
 * Pure, and separate from the runtime that serves the tool, so the rules are a unit test rather
 * than something to try by provoking a local model into a malformed call.
 */

export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 4;
export const MAX_HEADER = 16;
export const MAX_QUESTION = 300;
export const MAX_OPTION_LABEL = 60;
export const MAX_OPTION_DESCRIPTION = 200;
/** What a person may type into "Something else". Generous: it is their sentence, not the model's. */
export const MAX_ANSWER_TEXT = 2_000;

export interface AskOption {
  label: string;
  /** What choosing it means. Shown under the label; absent when the label says it all. */
  description: string | null;
}

export interface AskQuestion {
  /** A few words naming the decision, for the chip on the card. */
  header: string;
  question: string;
  options: readonly AskOption[];
  /** Whether several options may be chosen together. Free text is unaffected. */
  multiSelect: boolean;
}

export interface AskRequest {
  questions: readonly AskQuestion[];
}

/** One question's answer. Either or both parts may be present; at least one must be. */
export interface AskAnswer {
  /** Chosen option labels, in the order the question listed them. */
  chosen: readonly string[];
  /** What the person typed instead of, or alongside, the options. */
  text: string | null;
}

/**
 * How a question ended.
 *
 * `discuss` is not a decoration on `answered`. It is the person saying the question itself is
 * wrong — too early, badly framed, or resting on something the model has not understood — and
 * the honest thing for the turn to do then is stop and talk, not pick the nearest option and
 * carry on. Keeping it a distinct outcome is what lets the result say so plainly.
 */
export type AskOutcomeKind = 'answered' | 'discuss' | 'dismissed' | 'interrupted';

export interface AskOutcome {
  kind: AskOutcomeKind;
  /** Present on `answered`: one entry per question, in the order asked. */
  answers: readonly AskAnswer[];
  /** Present on `discuss`: what the person wants to talk about, when they said. */
  note: string | null;
}

/**
 * The key a waiting question is answered by.
 *
 * Derived from the occurrence rather than handed out, because the card that answers is rebuilt
 * from the transcript — after a re-render, a view switch, or a window reload — and must arrive at
 * the same id the main process is waiting on without having kept anything. Run-scoped for the
 * same reason approvals are: a provider's call ids can repeat across simultaneous turns, and an
 * answer routed to the wrong turn is a decision applied to work it was never about.
 *
 * Shared so the two sides cannot drift.
 */
export const askIdFor = (runId: string, occurrenceId: string): string => `${runId}:${occurrenceId}`;

const text = (value: unknown, limit: number): string | null => {
  if (typeof value !== 'string') return null;
  // A question is prose in a card, not a layout. Control characters would let a model break the
  // frame, and a newline in a one-line chip is a rendering bug waiting to be filed.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, limit) : null;
};

/** Multi-line text the person typed. Their newlines are theirs to keep; control bytes are not. */
const freeText = (value: unknown, limit: number): string | null => {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, limit) : null;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Read a model's `ask_user` arguments, or throw with something the model can act on.
 *
 * Throwing rather than repairing: a question the person sees must be the question the model
 * meant to ask. Silently dropping a malformed option would show someone a choice with a missing
 * alternative, and they would answer it without knowing anything was missing.
 */
export function parseAskRequest(input: unknown): AskRequest {
  const raw = record(input);
  if (!Array.isArray(raw.questions)) {
    throw new Error('Pass "questions": a list of one to four questions, each with a header, a question, and up to four options.');
  }
  if (!raw.questions.length) throw new Error('Ask at least one question.');
  if (raw.questions.length > MAX_QUESTIONS) {
    throw new Error(`Ask at most ${MAX_QUESTIONS} questions at once. Ask the ones that block you now; you can ask again after the answer.`);
  }

  const questions = raw.questions.map((value, index) => {
    const entry = record(value);
    const at = `Question ${index + 1}`;
    const question = text(entry.question, MAX_QUESTION);
    if (!question) throw new Error(`${at} needs "question": the thing you are actually asking, as a sentence.`);
    // Falls back to the question rather than refusing: a missing chip is cosmetic, and refusing
    // the whole call over it would cost a round trip to learn nothing.
    const header = text(entry.header, MAX_HEADER) ?? text(question, MAX_HEADER) ?? 'Question';

    let options: AskOption[] = [];
    if (entry.options !== undefined) {
      if (!Array.isArray(entry.options)) throw new Error(`${at}: "options" must be a list.`);
      if (entry.options.length > MAX_OPTIONS) throw new Error(`${at}: at most ${MAX_OPTIONS} options.`);
      options = entry.options.map((candidate) => {
        const option = record(candidate);
        // A bare string is the obvious shorthand and models reach for it; accept it.
        const label = text(typeof candidate === 'string' ? candidate : option.label, MAX_OPTION_LABEL);
        if (!label) throw new Error(`${at}: every option needs a "label".`);
        return { label, description: text(option.description, MAX_OPTION_DESCRIPTION) };
      });
      const seen = new Set<string>();
      for (const option of options) {
        const key = option.label.toLowerCase();
        if (seen.has(key)) throw new Error(`${at}: two options are both labelled "${option.label}". The answer names labels, so they must differ.`);
        seen.add(key);
      }
    }

    return { header, question, options, multiSelect: entry.multiSelect === true };
  });

  return { questions };
}

/**
 * Read what the renderer says the person chose.
 *
 * A boundary even though the other side is our own window: the window is driven by whatever the
 * person clicked, and a stale card from a turn that has moved on can still post. Labels are
 * matched against the question rather than trusted, so the result the model reads can only ever
 * contain options that were really offered.
 */
export function parseAskOutcome(input: unknown, request: AskRequest): AskOutcome {
  const raw = record(input);
  const kind = raw.kind;

  if (kind === 'discuss') return { kind: 'discuss', answers: [], note: freeText(raw.note, MAX_ANSWER_TEXT) };
  if (kind === 'dismissed') return { kind: 'dismissed', answers: [], note: null };
  if (kind !== 'answered') throw new Error('An answer is "answered", "discuss" or "dismissed".');

  if (!Array.isArray(raw.answers) || raw.answers.length !== request.questions.length) {
    throw new Error(`Expected ${request.questions.length} answer(s).`);
  }

  const answers = raw.answers.map((value, index) => {
    const entry = record(value);
    const question = request.questions[index];
    const offered = new Map(question.options.map((option) => [option.label.toLowerCase(), option.label]));
    const chosen: string[] = [];
    if (Array.isArray(entry.chosen)) {
      for (const candidate of entry.chosen) {
        const label = text(candidate, MAX_OPTION_LABEL);
        const match = label ? offered.get(label.toLowerCase()) : undefined;
        // Unknown labels are dropped, not an error: the person's typed text still stands, and a
        // card left open across a re-ask must not be able to answer with an option from the old one.
        if (match && !chosen.includes(match)) chosen.push(match);
      }
    }
    // One answer per question unless the model said otherwise, whatever the card sent.
    const limited = question.multiSelect ? chosen : chosen.slice(0, 1);
    const typed = freeText(entry.text, MAX_ANSWER_TEXT);
    if (!limited.length && !typed) throw new Error(`Question ${index + 1} was not answered.`);
    return { chosen: limited, text: typed };
  });

  return { kind: 'answered', answers, note: null };
}

/** True when every question has something the model can use. What enables the card's button. */
export const isComplete = (outcome: AskOutcome, request: AskRequest): boolean =>
  outcome.kind !== 'answered'
    ? outcome.kind === 'discuss'
    : outcome.answers.length === request.questions.length &&
      outcome.answers.every((answer) => answer.chosen.length > 0 || !!answer.text);

/**
 * The result the model reads.
 *
 * Written as the person's words rather than a status code, because the next thing the model does
 * is act on it. It is also explicit about the one thing a model will otherwise get wrong: on
 * `discuss` and `dismissed` it must not ask the same question again, which is precisely the loop
 * a blocking question makes possible.
 */
export function describeAskOutcome(outcome: AskOutcome, request: AskRequest): string {
  if (outcome.kind === 'interrupted') {
    return 'The turn ended before the question was answered. Nothing was decided; do not act on an assumed answer.';
  }
  if (outcome.kind === 'dismissed') {
    return [
      'The user closed the question without answering.',
      'Take it as "not now". Do not ask again. Either carry on with the part of the work that does not depend on it, saying plainly in your reply what you assumed, or stop and say what you need.',
    ].join(' ');
  }
  if (outcome.kind === 'discuss') {
    return [
      'The user would rather talk this through than pick an option.',
      outcome.note ? `They said: ${outcome.note}` : '',
      'Do not call ask_user again for this. End the turn with a short reply in your own words that engages with the decision — what you see, what you would do and why — and let them answer in the conversation.',
    ].filter(Boolean).join(' ');
  }

  const lines = request.questions.map((question, index) => {
    const answer = outcome.answers[index];
    const parts = [
      ...(answer.chosen.length ? [answer.chosen.join(', ')] : []),
      ...(answer.text ? [`they also said: ${answer.text}`] : []),
    ];
    return `${question.header}: ${question.question}\n  → ${parts.join(' — ')}`;
  });
  return [
    request.questions.length === 1 ? 'The user answered:' : 'The user answered:',
    ...lines,
    'Take this as decided and carry on in this turn. Do not ask it again, and do not re-confirm it in your reply.',
  ].join('\n');
}
