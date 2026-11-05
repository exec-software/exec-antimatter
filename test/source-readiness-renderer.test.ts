import assert from 'node:assert/strict';
import test from 'node:test';
import { currentSourceReadiness, pollSourceReadiness, sourceReadinessBlock, type SourceReadinessObservation } from '../renderer/src/lib/sourceReadiness';
import type { SourceReadiness } from '../renderer/src/types';

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('changing sources immediately discards the previous unreachable/loading gate and loading clock', () => {
  for (const readiness of [{ state: 'unreachable' }, { state: 'loading' }] as SourceReadiness[]) {
    const previous = { providerId: 'old', readiness, loadingSince: 123 };
    assert.deepEqual(currentSourceReadiness('new', previous), { readiness: { state: 'unknown' }, loadingSince: null });
    assert.deepEqual(currentSourceReadiness(undefined, previous), { readiness: { state: 'unknown' }, loadingSince: null });
    assert.deepEqual(currentSourceReadiness(undefined, null), { readiness: { state: 'unknown' }, loadingSince: null });
    assert.equal(currentSourceReadiness('old', previous).readiness, readiness);
  }
});

test('a disposed old poll cannot publish late readiness or schedule another poll', async () => {
  let finish!: (state: SourceReadiness) => void;
  const observations: SourceReadinessObservation[] = [];
  let scheduled = 0;
  const stop = pollSourceReadiness('old', {
    read: () => new Promise((resolve) => { finish = resolve; }), changed: (value) => observations.push(value),
    schedule: () => { scheduled += 1; }, cancel: () => {},
  });
  stop(); finish({ state: 'unreachable' }); await settle();
  assert.deepEqual(observations, []); assert.equal(scheduled, 0);
});

test('loading duration belongs to one source and clears on startable, while transport errors reopen the gate', async () => {
  let clock = 10; let next!: () => void;
  const observations: SourceReadinessObservation[] = [];
  const replies: Array<SourceReadiness | Error> = [{ state: 'loading' }, { state: 'loading' },
    { state: 'startable' }, new Error('IPC unavailable'), { state: 'loading' }];
  const stop = pollSourceReadiness('source', {
    read: async () => { const reply = replies.shift()!; if (reply instanceof Error) throw reply; return reply; },
    changed: (value) => observations.push(value), now: () => clock,
    schedule: (callback, ms) => { assert.equal(ms, 4000); next = callback; return 1; }, cancel: () => {},
  });
  await settle();
  for (let i = 0; i < 4; i++) { clock += 10; next(); await settle(); }
  stop();
  assert.deepEqual(observations.map((value) => value.loadingSince), [10, 10, null, null, 50]);
  assert.equal(observations[3].readiness.state, 'unknown');
});

test('all submit paths accept verified startup and retain actionable loading/unavailable reasons', () => {
  for (const state of ['ready', 'unknown', 'startable'] as const) assert.equal(sourceReadinessBlock({ state }), undefined);
  assert.match(sourceReadinessBlock({ state: 'loading' })!, /still loading/);
  assert.equal(sourceReadinessBlock({ state: 'unreachable', detail: 'Missing model file.' }), 'Missing model file.');
});
