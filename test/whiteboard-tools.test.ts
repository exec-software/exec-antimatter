import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBoardEdits, emptyBoard, type Board, type BoardEdit } from '../src/api/whiteboard';
import { WHITEBOARD_TOOL_NAMES, whiteboardToolHandler } from '../src/main/whiteboardTools';
import { TURN_CONTEXT_TOOL_ARGUMENT } from '../src/api/toolArguments';
import { toolArgumentsForTransport } from '../src/main/mcp';
import { BUILTIN_ID } from '../src/main/mcpStore';
import { whiteboardTools } from '../mcp/tools/whiteboard';

/** An in-memory board, standing in for the store so the handler is tested on its own. */
function fixture(enabled = true) {
  const boards = new Map<string, Board>();
  const handler = whiteboardToolHandler({
    enabled: () => enabled,
    read: (threadId) => boards.get(threadId) ?? emptyBoard(threadId),
    edit: (threadId, edits: readonly BoardEdit[]) => {
      const next = applyBoardEdits(boards.get(threadId) ?? emptyBoard(threadId), edits);
      boards.set(threadId, next);
      return next;
    },
  });
  return { handler, boards };
}

const turn = { thread: 'thread-1', turn: 'run-9', model: 'laguna-s-2.1' };

test('off means the tools refuse rather than quietly starting a board', async () => {
  const { handler, boards } = fixture(false);
  await assert.rejects(handler('whiteboard_read', {}, turn), /experimental feature and is switched off/);
  assert.equal(boards.size, 0);
});

test('the conversation is never a tool argument', async () => {
  const { handler } = fixture();
  // A model that could name the thread could name somebody else's, so it comes from the turn.
  await assert.rejects(handler('whiteboard_read', { thread: 'thread-2' }, undefined), /not attached to a conversation/);
  // None of the schemas offer it either.
  for (const tool of whiteboardTools) {
    assert.ok(!Object.keys(tool.inputSchema.properties ?? {}).includes('thread'), `${tool.name} must not take a thread`);
  }
});

test('what the model adds is recorded as the model, with the turn that did it', async () => {
  const { handler, boards } = fixture();
  const said = await handler('whiteboard_add', { kind: 'note', text: 'rate limit the login path', x: 40, y: 80 }, turn);
  assert.match(said, /Added note n-/);
  const [object] = boards.get('thread-1')!.objects;
  assert.deepEqual(object.author, { kind: 'model', name: 'laguna-s-2.1' });
  assert.equal(object.turn, 'run-9');
  assert.deepEqual([object.x, object.y], [40, 80]);
});

test('a delegated agent is named as one, and a turn with no model is still not a person', async () => {
  const { handler, boards } = fixture();
  await handler('whiteboard_add', { kind: 'note', text: 'from an agent' }, { ...turn, actor: 'code-reviewer' });
  assert.deepEqual(boards.get('thread-1')!.objects[0].author, { kind: 'agent', name: 'code-reviewer' });

  const bare = fixture();
  await bare.handler('whiteboard_add', { kind: 'note', text: 'no model named' }, { thread: 't' });
  // The one thing authorship must never do is attribute a machine's work to the person.
  assert.equal(bare.boards.get('t')!.objects[0].author.kind, 'model');
});

test('a note with no position is scattered rather than stacked on the origin', async () => {
  const { handler, boards } = fixture();
  for (let i = 0; i < 6; i += 1) await handler('whiteboard_add', { kind: 'note', text: `n${i}` }, turn);
  const xs = new Set(boards.get('thread-1')!.objects.map((object) => object.x));
  assert.ok(xs.size > 1, 'everything landing on one spot would hide all but the last');
});

test('a comment must be about something that is really there', async () => {
  const { handler, boards } = fixture();
  await assert.rejects(handler('whiteboard_add', { kind: 'comment', text: 'no anchor' }, turn), /needs an anchor/);
  // Named rather than silently dropped: the model chose that id for a reason.
  await assert.rejects(
    handler('whiteboard_add', { kind: 'comment', text: 'about a ghost', anchor: 'nope' }, turn),
    /No object nope is on the whiteboard/
  );
  await handler('whiteboard_add', { kind: 'note', text: 'auth' }, turn);
  const noteId = boards.get('thread-1')!.objects[0].id;
  await handler('whiteboard_add', { kind: 'comment', text: 'needs a limit', anchor: noteId }, turn);
  assert.equal(boards.get('thread-1')!.objects[1].anchor, noteId);
});

test('update changes text and position, and refuses an object that is not there', async () => {
  const { handler, boards } = fixture();
  await handler('whiteboard_add', { kind: 'note', text: 'first' }, turn);
  const id = boards.get('thread-1')!.objects[0].id;
  await handler('whiteboard_update', { id, text: 'second', x: 10, y: 20 }, turn);
  const object = boards.get('thread-1')!.objects[0];
  assert.deepEqual([object.text, object.x, object.y], ['second', 10, 20]);
  // Authorship survives an update by anyone.
  assert.equal(object.author.kind, 'model');
  await assert.rejects(handler('whiteboard_update', { id: 'ghost', text: 'x' }, turn), /No object ghost/);
  await assert.rejects(handler('whiteboard_update', { id }, turn), /needs text, a position, or both/);
});

test('removing says when it took away something the person had put there', async () => {
  const { handler, boards } = fixture();
  boards.set('thread-1', applyBoardEdits(emptyBoard('thread-1'), [{
    op: 'add',
    object: { id: 'mine', kind: 'note', x: 0, y: 0, text: 'my idea', author: { kind: 'person' }, at: '2026-11-17T00:00:00.000Z' },
  }]));
  // The reply is the only place a person finds out, so it has to say so rather than "done".
  assert.match(await handler('whiteboard_remove', { id: 'mine' }, turn), /which the person had put there/);
  assert.equal(boards.get('thread-1')!.objects.length, 0);
  await assert.rejects(handler('whiteboard_remove', { id: 'mine' }, turn), /No object mine/);
});

test('reading the board is the text projection, which is how it is seen without vision', async () => {
  const { handler } = fixture();
  assert.match(await handler('whiteboard_read', {}, turn), /empty/);
  await handler('whiteboard_add', { kind: 'note', text: 'auth flow', x: 5, y: 6 }, turn);
  const described = await handler('whiteboard_read', {}, turn);
  assert.match(described, /note n-\w+, at 5,6, "auth flow", by laguna-s-2\.1/);
});

test('the declared tools and the answered tools are the same set', () => {
  // A name declared by the server but not intercepted would reach the child and throw its
  // "handled by the app itself" error at a model that did nothing wrong.
  assert.deepEqual(whiteboardTools.map((tool) => tool.name).sort(), [...WHITEBOARD_TOOL_NAMES].sort());
  for (const tool of whiteboardTools) {
    assert.rejects(tool.run({}, { workspace: '/w' } as never), /handled by the Antimatter app itself/);
  }
});

test('the turn context reaches the whiteboard tools and no others', () => {
  for (const name of WHITEBOARD_TOOL_NAMES) {
    const sent = toolArgumentsForTransport(BUILTIN_ID, name, {}, false, turn);
    assert.deepEqual(sent[TURN_CONTEXT_TOOL_ARGUMENT], turn, `${name} should carry the turn`);
  }
  assert.ok(!Object.hasOwn(toolArgumentsForTransport(BUILTIN_ID, 'read_file', {}, false, turn), TURN_CONTEXT_TOOL_ARGUMENT));
});
