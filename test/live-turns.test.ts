import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginTurn,
  deliverSteer,
  dropSteer,
  endTurn,
  forget,
  IDLE_TURN,
  isRunning,
  noteContext,
  noteError,
  NO_TURNS,
  queueSteer,
  runningCount,
  runningThreads,
  runOf,
  threadOf,
  turnFor,
  updateStats,
  type LiveTurns,
} from '../renderer/src/lib/liveTurns';
import type { ContextReport, ProviderConfig } from '../renderer/src/types';

const source = { id: 'beholdd', name: 'beholdd' } as ProviderConfig;
const other = { id: 'anthropic', name: 'Anthropic' } as ProviderConfig;

const start = (turns: LiveTurns, threadId: string, runId: string, startedAt = 1_000): LiveTurns =>
  beginTurn(turns, threadId, { runId, source, startedAt });

test('conversations run at the same time and each keeps its own run', () => {
  let turns = start(NO_TURNS, 'alpha', 'run-alpha');
  turns = beginTurn(turns, 'beta', { runId: 'run-beta', source: other, startedAt: 2_000 });

  assert.equal(runOf(turns, 'alpha'), 'run-alpha');
  assert.equal(runOf(turns, 'beta'), 'run-beta');
  assert.deepEqual(runningThreads(turns).sort(), ['alpha', 'beta']);
  assert.equal(runningCount(turns), 2);

  // Each conversation reports the source that actually received its own turn.
  assert.equal(turnFor(turns, 'alpha').source, source);
  assert.equal(turnFor(turns, 'beta').source, other);

  // A third conversation is idle, and is not a reason to refuse anything.
  assert.equal(runOf(turns, 'gamma'), null);
  assert.equal(isRunning(turns, 'gamma'), false);
  assert.equal(turnFor(turns, 'gamma'), IDLE_TURN);
  assert.equal(turnFor(turns, null), IDLE_TURN);
});

test('one conversation finishing leaves the others running', () => {
  let turns = start(NO_TURNS, 'alpha', 'run-alpha');
  turns = beginTurn(turns, 'beta', { runId: 'run-beta', source: other, startedAt: 2_000 });
  turns = endTurn(turns, 'run-alpha', { failed: false, finishedAt: 9_000 });

  assert.equal(runOf(turns, 'alpha'), null);
  assert.equal(runOf(turns, 'beta'), 'run-beta');
  assert.deepEqual(runningThreads(turns), ['beta']);

  // The settled record stays readable: this is what the header shows on the way back to it.
  const settled = turnFor(turns, 'alpha');
  assert.equal(settled.stats.phase, 'done');
  assert.equal(settled.stats.finishedAt, 9_000);
  assert.equal(settled.source, null);
});

test('stream events are routed by run, never by whichever chat is open', () => {
  let turns = start(NO_TURNS, 'alpha', 'run-alpha');
  turns = beginTurn(turns, 'beta', { runId: 'run-beta', source: other, startedAt: 2_000 });

  turns = updateStats(turns, 'run-beta', (stats) => ({ ...stats, chunks: stats.chunks + 1, chars: stats.chars + 4 }));

  assert.equal(turnFor(turns, 'beta').stats.chunks, 1);
  assert.equal(turnFor(turns, 'alpha').stats.chunks, 0);
  assert.equal(threadOf(turns, 'run-beta'), 'beta');
  assert.equal(threadOf(turns, 'nobody'), null);
  assert.equal(threadOf(turns, null), null);
});

test('a late frame from an abandoned run changes nothing', () => {
  let turns = start(NO_TURNS, 'alpha', 'old');
  turns = endTurn(turns, 'old', { failed: false, finishedAt: 5_000 });
  turns = start(turns, 'alpha', 'new', 6_000);

  const before = turns;
  turns = updateStats(turns, 'old', (stats) => ({ ...stats, chunks: stats.chunks + 99 }));
  assert.equal(turns, before);

  // And an old `finally` unwinding late cannot release the run that replaced it.
  turns = endTurn(turns, 'old', { failed: true, finishedAt: 7_000 });
  assert.equal(runOf(turns, 'alpha'), 'new');
  assert.equal(turnFor(turns, 'alpha').stats.phase, 'thinking');
});

test('a new turn clears what the last one left behind', () => {
  let turns = noteError(NO_TURNS, 'alpha', 'Error: Failed to get response');
  assert.equal(turnFor(turns, 'alpha').error, 'Error: Failed to get response');

  turns = start(turns, 'alpha', 'run-alpha');
  const turn = turnFor(turns, 'alpha');
  assert.equal(turn.error, '');
  assert.equal(turn.context, null);
  assert.equal(turn.steer, null);
  assert.equal(turn.stats.phase, 'thinking');
  assert.equal(turn.stats.startedAt, 1_000);
  assert.equal(turn.stats.lastAliveAt, 0, 'the local click is not a heartbeat');
});

test('a failure is filed against the conversation it happened in', () => {
  let turns = start(NO_TURNS, 'alpha', 'run-alpha');
  turns = noteError(turns, 'beta', 'Stop the active turn before deleting this conversation.');

  assert.equal(turnFor(turns, 'alpha').error, '');
  assert.equal(turnFor(turns, 'beta').error, 'Stop the active turn before deleting this conversation.');
  assert.equal(runOf(turns, 'beta'), null, 'an error does not invent a run');

  // Clearing an error nobody recorded allocates nothing.
  const before = turns;
  assert.equal(noteError(before, 'gamma', ''), before);
  assert.equal(noteError(before, null, 'ignored'), before);
});

test('a window report lands on the conversation whose run it names', () => {
  let turns = start(NO_TURNS, 'alpha', 'run-alpha');
  turns = beginTurn(turns, 'beta', { runId: 'run-beta', source: other, startedAt: 2_000 });

  const report = { runId: 'run-beta', modelId: 'm', estimatedTokens: 12 } as ContextReport;
  turns = noteContext(turns, report);

  assert.equal(turnFor(turns, 'beta').context, report);
  assert.equal(turnFor(turns, 'alpha').context, null);
  assert.equal(noteContext(turns, { ...report, runId: 'gone' } as ContextReport), turns);
});

test('a steer belongs to one run, and its timer only takes its own note', () => {
  let turns = start(NO_TURNS, 'alpha', 'run-alpha');
  turns = beginTurn(turns, 'beta', { runId: 'run-beta', source: other, startedAt: 2_000 });

  turns = queueSteer(turns, 'run-alpha', 'check the logs');
  assert.deepEqual(turnFor(turns, 'alpha').steer, { runId: 'run-alpha', note: 'check the logs', delivered: false });
  assert.equal(turnFor(turns, 'beta').steer, null);

  turns = deliverSteer(turns, 'run-alpha', 'check the logs');
  assert.equal(turnFor(turns, 'alpha').steer?.delivered, true);

  // The note was replaced before the 1800ms timer fired: the timer must leave the new one alone.
  turns = queueSteer(turns, 'run-alpha', 'actually, stop');
  turns = dropSteer(turns, 'run-alpha', { note: 'check the logs', delivered: true });
  assert.equal(turnFor(turns, 'alpha').steer?.note, 'actually, stop');

  turns = dropSteer(turns, 'run-alpha');
  assert.equal(turnFor(turns, 'alpha').steer, null);

  // A turn that ends drops its own bubble rather than stranding it over the next one.
  turns = queueSteer(turns, 'run-beta', 'and here');
  turns = endTurn(turns, 'run-beta', { failed: false, finishedAt: 9_000 });
  assert.equal(turnFor(turns, 'beta').steer, null);
});

test('deleting a conversation takes its record with it', () => {
  let turns = start(NO_TURNS, 'alpha', 'run-alpha');
  turns = beginTurn(turns, 'beta', { runId: 'run-beta', source: other, startedAt: 2_000 });

  turns = forget(turns, 'alpha');
  assert.deepEqual(Object.keys(turns), ['beta']);
  assert.equal(forget(turns, 'alpha'), turns);
});
