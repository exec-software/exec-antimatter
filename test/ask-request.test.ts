import test from 'node:test';
import assert from 'node:assert/strict';
import {
  askIdFor,
  describeAskOutcome,
  isComplete,
  MAX_ANSWER_TEXT,
  parseAskOutcome,
  parseAskRequest,
  type AskRequest,
} from '../src/api/ask';

/**
 * What a question may be, and what an answer may be.
 *
 * Both directions are boundaries. A question arrives from a model, which can produce anything at
 * all; an answer arrives from a window, which is driven by whatever was clicked and may be a card
 * left over from a turn that has moved on. The rules are here rather than in the runtime so they
 * can be checked without provoking a local model into a malformed call.
 */

const ask = (questions: unknown): AskRequest => parseAskRequest({ questions });

const one = (overrides: Record<string, unknown> = {}): AskRequest =>
  ask([{ header: 'Store', question: 'Which store should this use?', options: [{ label: 'sqlite' }, { label: 'json' }], ...overrides }]);

test('a question survives the trip with its text and options intact', () => {
  const request = one();
  assert.equal(request.questions.length, 1);
  const [question] = request.questions;
  assert.equal(question.header, 'Store');
  assert.equal(question.question, 'Which store should this use?');
  assert.deepEqual(question.options.map((option) => option.label), ['sqlite', 'json']);
  assert.equal(question.multiSelect, false);
});

test('a bare string is accepted as an option, because models reach for it', () => {
  const [question] = ask([{ header: 'Store', question: 'Which?', options: ['sqlite', 'json'] }]).questions;
  assert.deepEqual(question.options.map((option) => option.label), ['sqlite', 'json']);
  assert.equal(question.options[0].description, null);
});

test('a question is bounded in count and in length', () => {
  const many = Array.from({ length: 5 }, (_, index) => ({ header: `H${index}`, question: `Q${index}?`, options: [] }));
  assert.throws(() => ask(many), /at most 4 questions/);
  assert.throws(() => ask([]), /at least one question/);
  assert.throws(() => ask([{ header: 'H', question: 'Q?', options: ['a', 'b', 'c', 'd', 'e'] }]), /at most 4 options/);
  // Long text is cut rather than refused: the question is still worth asking.
  const [question] = ask([{ header: 'x'.repeat(200), question: 'y'.repeat(1_000), options: [] }]).questions;
  assert.equal(question.header.length, 16);
  assert.equal(question.question.length, 300);
});

test('a question with no readable text is refused, not shown with a blank line', () => {
  assert.throws(() => ask([{ header: 'Store', options: [] }]), /needs "question"/);
  assert.throws(() => ask([{ header: 'Store', question: '   ', options: [] }]), /needs "question"/);
  assert.throws(() => parseAskRequest({}), /Pass "questions"/);
  assert.throws(() => ask([{ header: 'H', question: 'Q?', options: [{ description: 'no label' }] }]), /needs a "label"/);
});

test('a missing header falls back to the question rather than failing the call', () => {
  // A chip is cosmetic. Refusing the whole call over one would spend a round trip to learn
  // nothing, and the question itself is perfectly askable without it.
  const [question] = ask([{ question: 'Which store should this use?', options: [] }]).questions;
  assert.equal(question.header, 'Which store shou');
  assert.equal(question.question, 'Which store should this use?');
});

test('control characters cannot break the card out of its frame', () => {
  const [question] = ask([{ header: 'A\nB', question: 'Line\u0000one\r\nstill one', options: [] }]).questions;
  assert.equal(question.header, 'A B');
  assert.equal(question.question, 'Line one still one');
});

test('two options with the same label are refused, because the answer names labels', () => {
  assert.throws(
    () => ask([{ header: 'H', question: 'Q?', options: [{ label: 'Yes' }, { label: 'yes' }] }]),
    /must differ/
  );
});

/** The answer side. */

test('an answer keeps only options that were really offered', () => {
  const request = one();
  const outcome = parseAskOutcome({ kind: 'answered', answers: [{ chosen: ['json', 'postgres'] }] }, request);
  assert.equal(outcome.kind, 'answered');
  // "postgres" was never on the card. Silently dropped rather than relayed: a model must never
  // be told the person chose something it did not offer.
  assert.deepEqual(outcome.answers[0].chosen, ['json']);
});

test('a single-choice question yields one answer however many the window sent', () => {
  const outcome = parseAskOutcome({ kind: 'answered', answers: [{ chosen: ['sqlite', 'json'] }] }, one());
  assert.deepEqual(outcome.answers[0].chosen, ['sqlite']);
  const multi = parseAskOutcome({ kind: 'answered', answers: [{ chosen: ['sqlite', 'json'] }] }, one({ multiSelect: true }));
  assert.deepEqual(multi.answers[0].chosen, ['sqlite', 'json']);
});

test('typed text alone is a complete answer', () => {
  const outcome = parseAskOutcome({ kind: 'answered', answers: [{ chosen: [], text: 'neither — use the one in config/' }] }, one());
  assert.deepEqual(outcome.answers[0].chosen, []);
  assert.equal(outcome.answers[0].text, 'neither — use the one in config/');
  // The person's newlines are theirs; control bytes are not.
  const multiline = parseAskOutcome({ kind: 'answered', answers: [{ text: 'one\r\ntwo\u0000three' }] }, one());
  assert.equal(multiline.answers[0].text, 'one\ntwo three');
  const long = parseAskOutcome({ kind: 'answered', answers: [{ text: 'x'.repeat(MAX_ANSWER_TEXT + 500) }] }, one());
  assert.equal(long.answers[0].text?.length, MAX_ANSWER_TEXT);
});

test('an empty answer is refused rather than relayed as a decision', () => {
  assert.throws(() => parseAskOutcome({ kind: 'answered', answers: [{ chosen: [], text: '  ' }] }, one()), /was not answered/);
  assert.throws(() => parseAskOutcome({ kind: 'answered', answers: [] }, one()), /Expected 1 answer/);
  assert.throws(() => parseAskOutcome({ kind: 'nonsense' }, one()), /"answered", "discuss" or "dismissed"/);
});

test('discussing and dismissing are answers in their own right', () => {
  const discuss = parseAskOutcome({ kind: 'discuss', note: 'the second one worries me' }, one());
  assert.equal(discuss.kind, 'discuss');
  assert.equal(discuss.note, 'the second one worries me');
  assert.equal(parseAskOutcome({ kind: 'dismissed' }, one()).kind, 'dismissed');
});

test('completeness is per question, so a half-answered pair cannot be sent', () => {
  const request = ask([
    { header: 'A', question: 'First?', options: ['x'] },
    { header: 'B', question: 'Second?', options: ['y'] },
  ]);
  const half = { kind: 'answered' as const, answers: [{ chosen: ['x'], text: null }, { chosen: [], text: null }], note: null };
  assert.equal(isComplete(half, request), false);
  const whole = { kind: 'answered' as const, answers: [{ chosen: ['x'], text: null }, { chosen: [], text: 'later' }], note: null };
  assert.equal(isComplete(whole, request), true);
  assert.equal(isComplete({ kind: 'discuss', answers: [], note: null }, request), true);
  assert.equal(isComplete({ kind: 'dismissed', answers: [], note: null }, request), false);
});

/**
 * What the model reads.
 *
 * The exact wording is not the contract, but two things are, because getting either wrong puts
 * the turn in a loop: an unanswered question must not read as permission to assume, and every
 * ending must tell the model not to ask again.
 */

test('an answer is reported as a decision, not a status code', () => {
  const request = one();
  const text = describeAskOutcome(
    { kind: 'answered', answers: [{ chosen: ['json'], text: 'but keep sqlite behind a flag' }], note: null },
    request
  );
  assert.match(text, /json/);
  assert.match(text, /keep sqlite behind a flag/);
  assert.match(text, /Which store should this use\?/);
  assert.match(text, /not ask it again/i);
});

test('nothing unanswered reads as permission to assume an answer', () => {
  const request = one();
  for (const kind of ['interrupted', 'dismissed'] as const) {
    const text = describeAskOutcome({ kind, answers: [], note: null }, request);
    assert.match(text, /not/i);
    assert.doesNotMatch(text, /\bchose\b/);
  }
  assert.match(describeAskOutcome({ kind: 'interrupted', answers: [], note: null }, request), /nothing was decided/i);
  assert.match(describeAskOutcome({ kind: 'dismissed', answers: [], note: null }, request), /Do not ask again/i);
});

test('discussing tells the model to talk, and to stop asking', () => {
  const text = describeAskOutcome({ kind: 'discuss', answers: [], note: 'what about the migration?' }, one());
  assert.match(text, /rather talk this through/i);
  assert.match(text, /what about the migration\?/);
  assert.match(text, /Do not call ask_user again/i);
});

test('the answer key is run-scoped, so two turns cannot collide', () => {
  assert.equal(askIdFor('run-a', 'occurrence-1'), 'run-a:occurrence-1');
  assert.notEqual(askIdFor('run-a', 'occurrence-1'), askIdFor('run-b', 'occurrence-1'));
});
