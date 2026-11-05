import assert from 'node:assert/strict';
import test from 'node:test';
import type { RemoteDesktopTurnsSnapshot } from '../src/api/remoteDesktopTurns';
import type { ProviderConfig } from '../renderer/src/types';
import { beginTurn, noteAlive, updateStats } from '../renderer/src/lib/liveTurns';
import { reconcileRemoteTurns, remoteTurnForRun, subscribeRemoteTurns } from '../renderer/src/lib/remoteDesktopTurns';

const source = { id: 'source', name: 'Local' } as ProviderConfig;
const active: RemoteDesktopTurnsSnapshot = { revision: 1, turns: [{
  threadId: 'phone-chat', runId: 'request', responseMessageId: 'assistant', providerId: 'source',
  modelId: 'model', sourceName: 'Local', startedAt: 10,
}] };

test('phone turns have distinct control and response identities and do not replace unrelated desktop work', () => {
  const local = beginTurn({}, 'desktop-chat', { runId: 'desktop-run', source, startedAt: 1 });
  let turns = reconcileRemoteTurns(local, active, [source], 20);
  assert.equal(turns['desktop-chat'], local['desktop-chat']);
  assert.equal(turns['phone-chat'].runId, 'request');
  assert.equal(remoteTurnForRun(turns, 'request')?.remote?.responseMessageId, 'assistant');
  turns = noteAlive(turns, { id: 'request', at: 30 });
  turns = updateStats(turns, 'request', (stats) => ({ ...stats, chunks: 3, chars: 12 }));
  const duplicate = reconcileRemoteTurns(turns, active, [source], 40);
  assert.equal(duplicate, turns);
  turns = reconcileRemoteTurns(turns, { revision: 2, turns: [], finished: { runId: 'request', failed: true, finishedAt: 50 } }, [source], 60);
  assert.equal(turns['phone-chat'].runId, null);
  assert.equal(turns['phone-chat'].stats.phase, 'error');
  assert.equal(turns['phone-chat'].stats.finishedAt, 50);
  assert.equal(turns['phone-chat'].stats.chunks, 3);
  assert.equal(turns['desktop-chat'], local['desktop-chat']);
  assert.ok(remoteTurnForRun(turns, 'request'), 'retain retired identity to suppress late raw text');
});

test('an authoritative reconnect clears missed remote completion and accepts a new run', () => {
  let turns = reconcileRemoteTurns({}, active, [], 20);
  turns = reconcileRemoteTurns(turns, { revision: 4, turns: [] }, [], 40);
  assert.equal(turns['phone-chat'].runId, null);
  const next = { revision: 5, turns: [{ ...active.turns[0], runId: 'next', responseMessageId: 'next-answer', startedAt: 50 }] };
  turns = reconcileRemoteTurns(turns, next, [source], 60);
  assert.equal(turns['phone-chat'].runId, 'next');
  assert.equal(turns['phone-chat'].source, source);
  assert.equal(turns['phone-chat'].stats.chunks, 0);
});

test('a delayed initial snapshot cannot erase an event or revive a completed phone turn', async () => {
  let resolve!: (value: RemoteDesktopTurnsSnapshot) => void;
  const pending = new Promise<RemoteDesktopTurnsSnapshot>((done) => { resolve = done; });
  let listener!: (value: RemoteDesktopTurnsSnapshot) => void;
  const accepted: RemoteDesktopTurnsSnapshot[] = [];
  let stopped = false;
  const cleanup = subscribeRemoteTurns({ snapshot: () => pending, subscribe: (value) => {
    listener = value; return () => { stopped = true; };
  } }, (value) => accepted.push(value), (error) => { throw error; });
  listener(active);
  listener({ revision: 2, turns: [] });
  resolve(active);
  await pending;
  await Promise.resolve();
  assert.deepEqual(accepted.map((value) => value.revision), [1, 2]);
  cleanup();
  assert.equal(stopped, true);
  listener({ revision: 3, turns: active.turns });
  assert.equal(accepted.length, 2);
});
