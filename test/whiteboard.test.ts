import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BOARD_OBJECT_LIMIT,
  applyBoardEdits,
  describeBoard,
  emptyBoard,
  normalizeBoard,
  normalizeBoardObject,
  type Board,
} from '../src/api/whiteboard';
import { DEFAULT_WHITEBOARD, normalizeWhiteboard } from '../src/main/developerSettings';
import { assertThreadId, edit, read, save, useRoot } from '../src/main/whiteboard';

const note = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, kind: 'note', x: 10, y: 20, text: `note ${id}`, author: { kind: 'person' }, at: '2026-11-17T00:00:00.000Z', ...over });

function boards(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-board-'));
  t.after(() => {
    useRoot(join(root, 'unused'));
    rmSync(root, { recursive: true, force: true });
  });
  useRoot(root);
  return root;
}

test('experimental and off by default', () => {
  assert.deepEqual(DEFAULT_WHITEBOARD, { enabled: false });
  assert.deepEqual(normalizeWhiteboard(undefined), { enabled: false });
  assert.deepEqual(normalizeWhiteboard({ enabled: 'yes' }), { enabled: false });
  assert.deepEqual(normalizeWhiteboard({ enabled: true }), { enabled: true });
});

test('a thread id reaches a file name, so it is strict about what it accepts', () => {
  assert.equal(assertThreadId('thread-1'), 'thread-1');
  for (const bad of ['../escape', 'a/b', '', '.', 'x'.repeat(200), 'has space']) {
    assert.throws(() => assertThreadId(bad), /Invalid conversation id/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('one malformed object costs that object, not the board around it', () => {
  const board = normalizeBoard({
    objects: [
      note('keep'),
      { id: 'no-kind', x: 1, y: 1 },
      { id: 'bad-kind', kind: 'wormhole', x: 1, y: 1 },
      { kind: 'note', x: 1, y: 1 },
      note('nan', { x: Number.NaN }),
      note('keep2'),
    ],
  }, 'thread-1');
  assert.deepEqual(board.objects.map((object) => object.id), ['keep', 'keep2']);
});

test('a duplicate id would make every later reference ambiguous, so the first wins', () => {
  const board = normalizeBoard({ objects: [note('a', { text: 'first' }), note('a', { text: 'second' })] }, 't');
  assert.equal(board.objects.length, 1);
  assert.equal(board.objects[0].text, 'first');
});

test('a parent or anchor pointing at nothing is dropped rather than stranding the object', () => {
  const board = normalizeBoard({
    objects: [note('a', { parent: 'ghost' }), note('b', { anchor: 'ghost' }), note('c', { parent: 'a' })],
  }, 't');
  const byId = new Map(board.objects.map((object) => [object.id, object]));
  assert.equal(byId.get('a')!.parent, undefined);
  assert.equal(byId.get('b')!.anchor, undefined);
  // A reference that does resolve is kept.
  assert.equal(byId.get('c')!.parent, 'a');
  // An object cannot be its own parent, which would be an unbreakable cycle.
  assert.equal(normalizeBoard({ objects: [note('a', { parent: 'a' })] }, 't').objects[0].parent, undefined);
});

test('ink keeps whole coordinate pairs only', () => {
  // An odd tail would be read as a point at an undefined coordinate.
  assert.deepEqual(normalizeBoardObject(note('i', { kind: 'ink', points: [0, 0, 5, 5, 9] }))!.points, [0, 0, 5, 5]);
  assert.equal(normalizeBoardObject(note('i', { kind: 'ink', points: [1] }))!.points, undefined);
});

test('authorship is recorded and cannot be rewritten by a later edit', () => {
  const board: Board = normalizeBoard({ objects: [note('a', { author: { kind: 'model', name: 'laguna' } })] }, 't');
  assert.deepEqual(board.objects[0].author, { kind: 'model', name: 'laguna' });
  // The one thing a board is relied on to answer is who put this here. An update that could
  // rewrite it would make that editable by whoever came second.
  const after = applyBoardEdits(board, [
    { op: 'update', id: 'a', patch: { author: { kind: 'person' }, at: 'later' } as never },
  ]);
  assert.deepEqual(after.objects[0].author, { kind: 'model', name: 'laguna' });
  assert.equal(after.objects[0].at, '2026-11-17T00:00:00.000Z');
  // An unknown author kind is a person rather than a forgery.
  assert.deepEqual(normalizeBoardObject(note('b', { author: { kind: 'root' } }))!.author, { kind: 'person' });
});

test('edits add, move and remove, and removing takes dangling references with it', () => {
  let board = normalizeBoard({ objects: [note('group', { kind: 'group' })] }, 't');
  board = applyBoardEdits(board, [{ op: 'add', object: note('child', { parent: 'group' }) }]);
  assert.equal(board.objects.length, 2);
  // Dragging is editing x and y.
  board = applyBoardEdits(board, [{ op: 'update', id: 'child', patch: { x: 400, y: 500 } }]);
  assert.deepEqual([board.objects[1].x, board.objects[1].y], [400, 500]);
  board = applyBoardEdits(board, [{ op: 'remove', id: 'group' }]);
  assert.deepEqual(board.objects.map((object) => object.id), ['child']);
  assert.equal(board.objects[0].parent, undefined, 'the child must not point at a group that is gone');
  // Adding an id that already exists is ignored rather than replacing what is there.
  const before = board.objects.length;
  assert.equal(applyBoardEdits(board, [{ op: 'add', object: note('child') }]).objects.length, before);
});

test('the board is bounded, because it is a document read back from disk', () => {
  const objects = Array.from({ length: BOARD_OBJECT_LIMIT + 50 }, (_, i) => note(`n${i}`));
  assert.equal(normalizeBoard({ objects }, 't').objects.length, BOARD_OBJECT_LIMIT);
  // A coordinate past the limit is clamped rather than dropped: the object is still real.
  assert.equal(normalizeBoardObject(note('far', { x: 1e12 }))!.x, 1_000_000);
});

test('the board reads as text, which is how a model sees it without vision', () => {
  assert.match(describeBoard(emptyBoard('t')), /empty/);
  const board = normalizeBoard({
    objects: [
      note('n1', { text: 'auth flow' }),
      note('c1', { kind: 'comment', text: 'needs rate limiting', anchor: 'n1', author: { kind: 'model', name: 'laguna' } }),
    ],
  }, 't');
  const described = describeBoard(board);
  // Positions are included: on a planning surface, two notes side by side are related, and a
  // model that cannot see the layout is guessing.
  assert.match(described, /note n1, at 10,20, "auth flow", by you/);
  assert.match(described, /comment c1.*about n1.*by laguna/);
  assert.match(described, /holds 2 objects/);
});

test('a board survives a round trip and an unreadable one is empty, not fatal', (t) => {
  const root = boards(t);
  save('thread-1', { objects: [note('a')] });
  assert.equal(read('thread-1').objects[0].text, 'note a');
  // Written normalized, so what is on disk is what will be read back.
  assert.match(readFileSync(join(root, 'thread-1.json'), 'utf8'), /"version": 1/);

  writeFileSync(join(root, 'broken.json'), '{ not json');
  assert.deepEqual(read('broken').objects, []);
  // The file is left alone: overwriting it would destroy the only salvageable copy.
  assert.match(readFileSync(join(root, 'broken.json'), 'utf8'), /not json/);
});

test('edits go through main, so two writers cannot overwrite each other wholesale', (t) => {
  boards(t);
  edit('thread-2', [{ op: 'add', object: note('a') }]);
  // A second edit reads the stored board first rather than sending a whole one, so this keeps a.
  const board = edit('thread-2', [{ op: 'add', object: note('b', { author: { kind: 'model', name: 'laguna' } }) }]);
  assert.deepEqual(board.objects.map((object) => object.id), ['a', 'b']);
  assert.deepEqual(read('thread-2').objects.map((object) => object.author.kind), ['person', 'model']);
});
