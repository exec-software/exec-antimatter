import assert from 'node:assert/strict';
import test from 'node:test';
import { beginTurn, NO_TURNS, runOf } from '../renderer/src/lib/liveTurns';
import { currentTurns, subscribeTurns, updateTurns } from '../renderer/src/lib/liveTurnsStore';
import type { ProviderConfig } from '../renderer/src/types';

const source = { id: 'local', name: 'Local' } as ProviderConfig;

test('the live-turn record lives in the store, not in a component', () => {
  updateTurns(() => NO_TURNS);
  let notifications = 0;
  const stop = subscribeTurns(() => {
    notifications += 1;
  });

  updateTurns((current) => beginTurn(current, 'alpha', { runId: 'run-alpha', source, startedAt: 1_000 }));
  assert.equal(runOf(currentTurns(), 'alpha'), 'run-alpha');
  assert.equal(notifications, 1, 'a change wakes its subscribers');

  // A change that returns the same map does not notify, so a settled run's late frame is free.
  updateTurns((current) => current);
  assert.equal(notifications, 1);

  stop();
  updateTurns(() => NO_TURNS);
  assert.equal(notifications, 1, 'an unsubscribed listener is not called');
  assert.equal(currentTurns(), NO_TURNS);
});
