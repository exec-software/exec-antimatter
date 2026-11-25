import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PRODUCTION_SHOT_LIMIT,
  PRODUCTION_TAKE_LIMIT,
  applyProductionEdits,
  cutSeconds,
  describeProduction,
  emptyProduction,
  entrySeconds,
  normalizeProduction,
  shotPrompt,
  summarizeProduction,
  timecode,
  type Production,
  type ProductionEdit,
} from '../src/api/movie';
import * as movie from '../src/main/movie';
import * as universes from '../src/main/universes';

const shot = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  slug: `shot ${id}`,
  intent: '',
  prompt: '',
  seconds: 4,
  takes: [],
  author: { kind: 'person' },
  at: '2026-11-25T00:00:00.000Z',
  ...over,
});

const take = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  path: `${id}.mp4`,
  seconds: 4,
  width: 1280,
  height: 720,
  audio: false,
  author: { kind: 'generator', name: 'wan-2-2-comfy' },
  at: '2026-11-25T00:00:00.000Z',
  ...over,
});

/** A production with two shots in the cut, the second of which has a take. */
function sample(): Production {
  return normalizeProduction(
    {
      title: 'Test film',
      lookbook: '35mm, overcast',
      shots: [shot('a'), shot('b', { takes: [take('t1')], selectedTakeId: 't1' })],
      cut: [{ shotId: 'a' }, { shotId: 'b' }],
    },
    'prod-1'
  );
}

const apply = (production: Production, ...edits: ProductionEdit[]) => applyProductionEdits(production, edits);

function root(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'antimatter-movie-'));
  t.after(() => {
    universes.useRoot(join(directory, 'unused'));
    rmSync(directory, { recursive: true, force: true });
  });
  universes.useRoot(directory);
  return directory;
}

// ------------------------------------------------------------------ the design's load-bearing claim

test('re-generating a shot does not move it in the cut', () => {
  // This is the whole reason the cut points at shots rather than files. If it failed, the
  // workbench would be an NLE with extra steps.
  const before = sample();
  const positionBefore = before.cut.findIndex((entry) => entry.shotId === 'b');
  const after = apply(
    before,
    { op: 'add-take', shotId: 'b', take: take('t2', { prompt: 'a different idea' }) },
    { op: 'select-take', shotId: 'b', takeId: 't2' },
    { op: 'remove-take', shotId: 'b', takeId: 't1' }
  );
  assert.equal(after.cut.findIndex((entry) => entry.shotId === 'b'), positionBefore);
  assert.deepEqual(after.cut.map((entry) => entry.shotId), ['a', 'b']);
  assert.equal(after.shots.find((entry) => entry.id === 'b')?.selectedTakeId, 't2');
});

test('a shot with no footage still occupies the cut and still has a length', () => {
  const production = sample();
  const slug = production.cut.find((entry) => entry.shotId === 'a')!;
  assert.equal(entrySeconds(production, slug), 4, 'a slug falls back to the shot\'s own duration');
  assert.equal(cutSeconds(production), 8);
  assert.equal(summarizeProduction(production).unrendered, 1);
});

test('a take records the prompt and seed it was actually made from', () => {
  // The shot's prompt moves on; the take's did not. Without this a take cannot be reproduced,
  // which is what keeping takes is for.
  const production = apply(sample(), {
    op: 'add-take',
    shotId: 'a',
    take: take('t9', { prompt: 'the original wording', seed: 1234 }),
  });
  const stored = production.shots.find((entry) => entry.id === 'a')?.takes[0];
  assert.equal(stored?.prompt, 'the original wording');
  assert.equal(stored?.seed, 1234);

  const later = apply(production, { op: 'update-shot', id: 'a', patch: { prompt: 'rewritten' } });
  assert.equal(later.shots.find((entry) => entry.id === 'a')?.takes[0].prompt, 'the original wording');
});

test('the first take on a shot is selected, because the alternative is a slug beside footage', () => {
  const production = apply(sample(), { op: 'add-take', shotId: 'a', take: take('first') });
  assert.equal(production.shots.find((entry) => entry.id === 'a')?.selectedTakeId, 'first');
  // A second take does not steal the selection: that is a choice, not an arrival.
  const two = apply(production, { op: 'add-take', shotId: 'a', take: take('second') });
  assert.equal(two.shots.find((entry) => entry.id === 'a')?.selectedTakeId, 'first');
});

test('deleting the selected take falls back to one that still exists', () => {
  const production = apply(
    sample(),
    { op: 'add-take', shotId: 'a', take: take('t1') },
    { op: 'add-take', shotId: 'a', take: take('t2') },
    { op: 'select-take', shotId: 'a', takeId: 't2' },
    { op: 'remove-take', shotId: 'a', takeId: 't2' }
  );
  const after = production.shots.find((entry) => entry.id === 'a');
  assert.equal(after?.selectedTakeId, 't1', 'the cut should keep playing something');

  const empty = apply(production, { op: 'remove-take', shotId: 'a', takeId: 't1' });
  assert.equal(empty.shots.find((entry) => entry.id === 'a')?.selectedTakeId, undefined);
});

test('the look is prepended to every shot, and an empty prompt falls back to the intent', () => {
  const production = sample();
  const withPrompt = { ...production.shots[0], prompt: 'a lighthouse at dusk' };
  assert.equal(shotPrompt(production, withPrompt), '35mm, overcast\n\na lighthouse at dusk');
  const withIntent = { ...production.shots[0], prompt: '', intent: 'establish the coast' };
  assert.equal(shotPrompt(production, withIntent), '35mm, overcast\n\nestablish the coast');
  const bare = { ...production.shots[0], prompt: '', intent: '', slug: 'the slug' };
  assert.equal(shotPrompt(production, bare), '35mm, overcast\n\nthe slug');
});

// ------------------------------------------------------------------ document integrity

test('a cut entry for a shot that is gone is dropped, not left as a gap', () => {
  const production = normalizeProduction(
    { shots: [shot('a')], cut: [{ shotId: 'a' }, { shotId: 'ghost' }, { shotId: 'a' }] },
    'p'
  );
  assert.deepEqual(production.cut.map((entry) => entry.shotId), ['a'], 'ghosts and duplicates both go');
});

test('removing a shot takes its place in the cut with it', () => {
  const after = apply(sample(), { op: 'remove-shot', id: 'b' });
  assert.deepEqual(after.cut.map((entry) => entry.shotId), ['a']);
  assert.equal(after.shots.length, 1);
});

test('a shot pointing at a beat that is gone keeps the shot and loses the link', () => {
  const production = normalizeProduction({ boards: [], shots: [shot('a', { boardId: 'gone' })] }, 'p');
  assert.equal(production.shots.length, 1);
  assert.equal(production.shots[0].boardId, undefined);
});

test('a selection pointing at a take that is gone is dropped', () => {
  const production = normalizeProduction({ shots: [shot('a', { takes: [take('t1')], selectedTakeId: 'nope' })] }, 'p');
  assert.equal(production.shots[0].selectedTakeId, undefined);
});

test('one malformed shot costs that shot, not the production around it', () => {
  const production = normalizeProduction(
    { shots: [shot('keep'), { slug: 'no id' }, null, shot('keep2'), shot('keep')] },
    'p'
  );
  assert.deepEqual(production.shots.map((entry) => entry.id), ['keep', 'keep2']);
});

test('a trim that ends before it starts is not a trim', () => {
  const production = normalizeProduction({ shots: [shot('a')], cut: [{ shotId: 'a', from: 3, to: 1 }] }, 'p');
  assert.equal(production.cut[0].from, 3);
  assert.equal(production.cut[0].to, undefined);
});

test('a trim shortens the entry without touching the take', () => {
  const production = apply(sample(), { op: 'cut-trim', shotId: 'b', from: 1, to: 3 });
  const entry = production.cut.find((item) => item.shotId === 'b')!;
  assert.equal(entrySeconds(production, entry), 2);
  assert.equal(production.shots.find((item) => item.id === 'b')?.takes[0].seconds, 4, 'the take is intact');
});

test('authorship cannot be patched, on a document a model also writes to', () => {
  const production = apply(sample(), {
    op: 'update-shot',
    id: 'a',
    // The cast is the point: this is what a tool call that tried it would look like.
    patch: { author: { kind: 'model', name: 'someone else' }, at: '1999-01-01' } as never,
  });
  assert.deepEqual(production.shots.find((entry) => entry.id === 'a')?.author, { kind: 'person' });
  assert.equal(production.shots.find((entry) => entry.id === 'a')?.at, '2026-11-25T00:00:00.000Z');
});

test('an edit for something that is not there changes nothing at all', () => {
  const before = sample();
  const after = applyProductionEdits(before, [
    { op: 'update-shot', id: 'ghost', patch: { slug: 'x' } },
    { op: 'remove-shot', id: 'ghost' },
    { op: 'add-take', shotId: 'ghost', take: take('t') },
    { op: 'select-take', shotId: 'a', takeId: 'ghost' },
    { op: 'cut-insert', shotId: 'ghost', before: null },
    { op: 'cut-remove', shotId: 'ghost' },
  ]);
  assert.equal(after, before, 'no change means the same object, so nothing re-renders or re-saves');
});

test('a shot is inserted where it was asked for, and ordering survives a save', () => {
  const production = apply(
    sample(),
    { op: 'add-shot', shot: shot('middle'), before: 'b' },
    { op: 'cut-insert', shotId: 'middle', before: 'b' }
  );
  assert.deepEqual(production.shots.map((entry) => entry.id), ['a', 'middle', 'b']);
  assert.deepEqual(production.cut.map((entry) => entry.shotId), ['a', 'middle', 'b']);
});

test('moving a shot in the cut is a remove and an insert, in one write', () => {
  const production = apply(sample(), { op: 'cut-remove', shotId: 'b' }, { op: 'cut-insert', shotId: 'b', before: 'a' });
  assert.deepEqual(production.cut.map((entry) => entry.shotId), ['b', 'a']);
});

test('a beat can be reordered without touching the shots under it', () => {
  const production = normalizeProduction(
    {
      boards: [
        { id: 'one', title: 'One', summary: '', author: { kind: 'person' }, at: '2026-01-01' },
        { id: 'two', title: 'Two', summary: '', author: { kind: 'person' }, at: '2026-01-01' },
      ],
      shots: [shot('a', { boardId: 'two' })],
    },
    'p'
  );
  const moved = apply(production, { op: 'move-board', id: 'two', before: 'one' });
  assert.deepEqual(moved.boards.map((entry) => entry.id), ['two', 'one']);
  assert.equal(moved.shots[0].boardId, 'two');
});

test('the document is bounded, because a tool call also writes to it', () => {
  const many = Array.from({ length: PRODUCTION_SHOT_LIMIT + 50 }, (_, index) => shot(`s${index}`));
  assert.equal(normalizeProduction({ shots: many }, 'p').shots.length, PRODUCTION_SHOT_LIMIT);

  const takes = Array.from({ length: PRODUCTION_TAKE_LIMIT + 10 }, (_, index) => take(`t${index}`));
  assert.equal(normalizeProduction({ shots: [shot('a', { takes })] }, 'p').shots[0].takes.length, PRODUCTION_TAKE_LIMIT);

  const long = normalizeProduction({ shots: [shot('a', { seconds: 100_000 })] }, 'p');
  assert.ok(long.shots[0].seconds <= 300);
});

test('timecode reads the way a cut is read', () => {
  assert.equal(timecode(0), '00:00');
  assert.equal(timecode(9.4), '00:09');
  assert.equal(timecode(61), '01:01');
  assert.equal(timecode(-5), '00:00');
});

test('the production reads as a document a model can act on', () => {
  const text = describeProduction(sample());
  assert.match(text, /Production "Test film"/);
  assert.match(text, /a: shot a/);
  assert.match(text, /no footage yet/);
  assert.match(text, /cut position 1/);
  assert.match(text, /Cut: 2 shots, 00:08/);
  // Takes are counted, not listed: a production late in the work has thousands of paths.
  assert.equal(/\.mp4/.test(text), false);
});

test('an empty production says so rather than reading as broken', () => {
  assert.match(describeProduction(emptyProduction('p', 'Nothing yet')), /No shots yet/);
});

// ------------------------------------------------------------------ the store

test('a production id reaches a file name and a directory, so it is strict', () => {
  assert.equal(movie.assertProductionId('prod-1'), 'prod-1');
  for (const bad of ['../escape', 'a/b', '', '.', 'x'.repeat(200), 'has space']) {
    assert.throws(() => movie.assertProductionId(bad), /Invalid production id/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('a production is created, edited, listed and re-read', (t) => {
  root(t);
  const created = movie.create('A short');
  assert.equal(created.title, 'A short');
  assert.ok(existsSync(movie.assetsDir(created.id)));

  movie.edit(created.id, [
    { op: 'add-shot', shot: shot('a', { slug: 'the coast' }) },
    { op: 'cut-insert', shotId: 'a', before: null },
  ]);

  const reread = movie.read(created.id);
  assert.deepEqual(reread.shots.map((entry) => entry.slug), ['the coast']);
  assert.deepEqual(reread.cut.map((entry) => entry.shotId), ['a']);

  const listed = movie.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].shots, 1);
  assert.equal(listed[0].unrendered, 1);
});

test('the list is ordered by what was worked on last', (t) => {
  root(t);
  const first = movie.create('First');
  const second = movie.create('Second');
  // The documents are written within the same millisecond, so the order has to be forced for
  // this to be a test of the sort rather than of the clock.
  movie.save(first.id, { ...movie.read(first.id), updatedAt: '2026-01-01T00:00:00.000Z' });
  movie.save(second.id, { ...movie.read(second.id), updatedAt: '2026-06-01T00:00:00.000Z' });
  assert.deepEqual(movie.list().map((entry) => entry.title), ['Second', 'First']);
});

test('an unreadable production shows as empty and the file is left alone', (t) => {
  const directory = root(t);
  const file = join(directory, 'movie', 'productions', 'prod-x.json');
  mkdirSync(join(directory, 'movie', 'productions'), { recursive: true });
  writeFileSync(file, 'half a document');
  const read = movie.read('prod-x');
  assert.equal(read.shots.length, 0);
  assert.equal(readFileSync(file, 'utf8'), 'half a document', 'weeks of work must not be overwritten by a reader');
  // It is still listed, because it exists; it just has nothing in it.
  assert.equal(movie.list().length, 1);
});

test('deleting a production takes its assets with it', (t) => {
  root(t);
  const created = movie.create('To delete');
  const clip = join(movie.assetsDir(created.id), 'take.bin');
  writeFileSync(clip, Buffer.alloc(2048));
  assert.equal(movie.assetBytes(created.id), 2048);

  movie.remove(created.id);
  assert.equal(existsSync(clip), false);
  assert.equal(existsSync(movie.assetsDir(created.id)), false);
  assert.equal(movie.list().length, 0);
});

test('an empty library lists nothing rather than throwing', (t) => {
  root(t);
  assert.deepEqual(movie.list(), []);
  assert.equal(movie.assetBytes('prod-missing'), 0);
});
