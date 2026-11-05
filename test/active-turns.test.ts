import assert from 'node:assert/strict';
import test from 'node:test';
import { ActiveTurns } from '../src/main/activeTurns';

test('only one interactive turn owns a conversation at a time', () => {
  const active = new ActiveTurns();
  active.begin('thread', 'run-one');

  assert.equal(active.runFor('thread'), 'run-one');
  assert.throws(() => active.begin('thread', 'run-two'), /already has a turn running/i);
  assert.throws(() => active.begin('thread', 'run-one'), /already running/i);

  active.finish('thread', 'run-one');
  active.begin('thread', 'run-two');
  assert.equal(active.runFor('thread'), 'run-two');
});

test('a stale cleanup cannot release the current turn', () => {
  const active = new ActiveTurns();
  active.begin('thread', 'current');
  active.finish('thread', 'stale');
  assert.equal(active.runFor('thread'), 'current');
});

test('turn records preserve owner metadata and are defensive snapshots', () => {
  const turns = new ActiveTurns();
  turns.begin('thread', 'run', {
    owner: { kind: 'remote', deviceId: 'phone' },
    projectId: 'project',
    responseMessageId: 'response',
    startedAt: 123,
  });

  const record = turns.recordForRun('run');
  assert.deepEqual(record, {
    threadId: 'thread',
    runId: 'run',
    owner: { kind: 'remote', deviceId: 'phone' },
    projectId: 'project',
    responseMessageId: 'response',
    startedAt: 123,
  });
  const listed = turns.list();
  assert.deepEqual(listed, [record]);
  (listed[0].owner as { kind: 'remote'; deviceId: string }).deviceId = 'mutated';
  assert.equal((turns.recordForRun('run')?.owner as { kind: 'remote'; deviceId: string }).deviceId, 'phone');
});
