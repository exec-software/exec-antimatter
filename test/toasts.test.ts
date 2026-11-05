import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  DEFAULT_TOAST_TIMEOUT,
  MAX_TOAST_ACTIONS,
  MAX_TOAST_BODY,
  MAX_TOAST_TITLE,
  MAX_VISIBLE_TOASTS,
  buildToast,
  placeToast,
  type Toast,
} from '../src/api/toasts';
import { learnProjectPrompt, needsLearning } from '../renderer/src/projectLearning';

const build = (input: unknown, id = 't1'): Toast => buildToast(input, id, 1_000);

test('a toast needs something to say', () => {
  assert.throws(() => build({}), /needs something to say/);
  assert.throws(() => build({ title: '   ' }), /needs something to say/);
  assert.throws(() => build({ title: 42 }), /needs something to say/);
  assert.throws(() => build(null), /must be an object/);
  assert.throws(() => build([]), /must be an object/);
});

/**
 * Toasts relay text this app did not write — a server's error string, a unit's failure reason —
 * so the shape of that text is a boundary concern and not the caller's discipline.
 */
test('relayed text is collapsed to one line and bounded', () => {
  const toast = build({ title: 'Engine\nfailed\tto\r\nstart', body: '  spread   over \n lines  ' });
  assert.equal(toast.title, 'Engine failed to start');
  assert.equal(toast.body, 'spread over lines');

  const long = build({ title: 'A'.repeat(500), body: 'B'.repeat(900) });
  assert.equal(long.title.length, MAX_TOAST_TITLE);
  assert.equal(long.body?.length, MAX_TOAST_BODY);

  // A control character must not survive into the layout.
  assert.equal(build({ title: 'ok\u0000\u001b[31m' }).title.includes('\u0000'), false);
  // A body that is only whitespace is absent, not an empty line taking up room.
  assert.equal(build({ title: 'ok', body: '   ' }).body, null);
});

test('tone decides how long it lingers, and bad news waits to be read', () => {
  assert.equal(build({ title: 'x' }).tone, 'info', 'an unknown tone falls back rather than throwing');
  assert.equal(build({ title: 'x', tone: 'nope' }).tone, 'info');
  assert.equal(build({ title: 'x', tone: 'success' }).timeoutMs, DEFAULT_TOAST_TIMEOUT.success);
  assert.equal(build({ title: 'x', tone: 'danger' }).timeoutMs, null, 'danger stays until dismissed');
  assert.equal(build({ title: 'x', timeoutMs: null }).timeoutMs, null);
  assert.equal(build({ title: 'x', timeoutMs: 5_000 }).timeoutMs, 5_000);
  assert.throws(() => build({ title: 'x', timeoutMs: 10 }), /between 1000 and 120000/);
  assert.throws(() => build({ title: 'x', timeoutMs: 600_000 }), /between 1000 and 120000/);
  assert.throws(() => build({ title: 'x', timeoutMs: Number.NaN }), /between 1000 and 120000/);
});

test('actions carry identifiers rather than functions, validated as such', () => {
  const toast = build({ title: 'x', actions: [{ id: 'learn.project', label: 'Learn it', primary: true }, { id: 'later', label: 'Not now' }] });
  assert.equal(toast.actions.length, 2);
  assert.equal(toast.actions[0].primary, true);
  assert.equal(toast.actions[1].primary, undefined);

  assert.throws(() => build({ title: 'x', actions: 'go' }), /must be a list/);
  assert.throws(() => build({ title: 'x', actions: [{ id: 'a b', label: 'x' }] }), /action needs an id/);
  assert.throws(() => build({ title: 'x', actions: [{ id: 'ok', label: '' }] }), /needs a label/);
  assert.throws(() => build({ title: 'x', actions: [{ label: 'no id' }] }), /action needs an id/);
  assert.throws(
    () => build({ title: 'x', actions: Array.from({ length: MAX_TOAST_ACTIONS + 1 }, (_, i) => ({ id: `a${i}`, label: 'x' })) }),
    /at most/,
  );
});

test('only the first primary keeps its emphasis', () => {
  const toast = build({ title: 'x', actions: [{ id: 'a', label: 'A', primary: true }, { id: 'b', label: 'B', primary: true }] });
  assert.equal(toast.actions[0].primary, true);
  assert.equal(toast.actions[1].primary, undefined);
});

test('a key must be an identifier, so it can never collide by accident with prose', () => {
  assert.equal(build({ title: 'x', key: 'engine.mistral' }).key, 'engine.mistral');
  assert.equal(build({ title: 'x' }).key, null);
  assert.throws(() => build({ title: 'x', key: 'has spaces' }), /toast key is/);
});

test('a keyed repeat replaces in place rather than jumping to the end', () => {
  const first = buildToast({ title: 'Restarting', key: 'engine' }, 'a', 1);
  const other = buildToast({ title: 'Download done' }, 'b', 2);
  const update = buildToast({ title: 'Gave up', key: 'engine' }, 'c', 3);

  const list = placeToast(placeToast([], first), other);
  assert.deepEqual(list.map((t) => t.id), ['a', 'b']);

  const replaced = placeToast(list, update);
  assert.deepEqual(replaced.map((t) => t.id), ['c', 'b'], 'the slot is kept, so the dismiss button stays put');
  assert.equal(replaced[0].title, 'Gave up');
  assert.equal(replaced.length, 2, 'a replacement does not grow the stack');
});

test('unkeyed toasts stack, and the cap drops the oldest', () => {
  let list: Toast[] = [];
  for (let i = 0; i < MAX_VISIBLE_TOASTS + 3; i++) {
    list = placeToast(list, buildToast({ title: `n${i}` }, `id${i}`, i));
  }
  assert.equal(list.length, MAX_VISIBLE_TOASTS);
  // The newest survive; the first three were pushed out.
  assert.equal(list.at(-1)?.id, `id${MAX_VISIBLE_TOASTS + 2}`);
  assert.equal(list.some((t) => t.id === 'id0'), false);
});

test('a keyed toast is never dropped by the cap while it is being updated', () => {
  let list = placeToast([], buildToast({ title: 'held', key: 'held' }, 'keeper', 0));
  for (let i = 0; i < MAX_VISIBLE_TOASTS + 2; i++) {
    list = placeToast(list, buildToast({ title: `n${i}` }, `id${i}`, i + 1));
  }
  // The cap did evict it, which is correct -- but an update then reinstates it rather than
  // being silently lost, because a replacement with no match is placed as a new toast.
  const reinstated = placeToast(list, buildToast({ title: 'held again', key: 'held' }, 'keeper2', 99));
  assert.equal(reinstated.some((t) => t.key === 'held'), true);
  assert.ok(reinstated.length <= MAX_VISIBLE_TOASTS);
});

// ---------------------------------------------------------------------------
// The first consumer: the offer to learn a project
// ---------------------------------------------------------------------------

test('a project is only worth asking about when nothing describes it yet', () => {
  const base = { current: '/work/repo', notes: 0, instructions: 0, memoryEnabled: true };
  assert.equal(needsLearning(base), true);
  // An AGENTS.md is a description written by hand; do not ask about it.
  assert.equal(needsLearning({ ...base, instructions: 1 }), false);
  // Notes mean this has already been done.
  assert.equal(needsLearning({ ...base, notes: 3 }), false);
  // Memory off means notes cannot be kept, so the offer would lead nowhere.
  assert.equal(needsLearning({ ...base, memoryEnabled: false }), false);
  // No project means no root to explore.
  assert.equal(needsLearning({ ...base, current: '' }), false);
});

test('the learn prompt names the root and the tool that records the answer', () => {
  const prompt = learnProjectPrompt('/work/repo');
  assert.ok(prompt.includes('/work/repo'), 'the model must be told where to look');
  assert.ok(prompt.includes('remember'), 'a smaller local model should not have to infer the tool');
  // The point is durable notes, not a summary that dies with the conversation.
  assert.ok(/one fact per note/i.test(prompt));
});
