import test from 'node:test';
import assert from 'node:assert/strict';
import { recordInferenceMetrics, type InferenceMetricsEvent, type InferenceHistory } from '../renderer/src/lib/inferenceMetrics';

const event = (id: string, round = 0, requestDurationMs = 1, phase: InferenceMetricsEvent['metrics']['phase'] = 'streaming'): InferenceMetricsEvent => ({
  id, round, providerId: 'source', model: 'model', metrics: { phase, requestStartedAt: 100, requestDurationMs },
});

test('late prefill telemetry cannot change a decoding request back to processing its prompt', () => {
  const state = recordInferenceMetrics({}, event('a', 0, 10, 'streaming'));
  assert.equal(recordInferenceMetrics(state, event('a', 0, 11, 'prefill')), state);
  const nextRound = recordInferenceMetrics(state, event('a', 1, 1, 'prefill'));
  assert.equal(nextRound.a[1].metrics.phase, 'prefill');
});

test('diagnostics isolate simultaneous chats, retain rounds, and reject late partial events', () => {
  let state = recordInferenceMetrics({}, event('a'));
  state = recordInferenceMetrics(state, event('b'));
  state = recordInferenceMetrics(state, event('a', 0, 20, 'complete'));
  assert.equal(recordInferenceMetrics(state, event('a', 0, 10)), state);
  assert.equal(recordInferenceMetrics(state, event('a', 0, 20)), state);
  state = recordInferenceMetrics(state, event('a', 1));
  assert.equal(state.a.length, 2);
  assert.equal(state.b[0].metrics.requestDurationMs, 1);
  assert.equal(state.a[0].metrics.phase, 'complete');
});

test('diagnostics bound both retained requests and conversation runs', () => {
  let state: InferenceHistory = {};
  for (let i = 0; i < 60; i++) state = recordInferenceMetrics(state, event(`run-${i}`));
  assert.equal(Object.keys(state).length, 48);
  assert.equal(state['run-0'], undefined);
  for (let round = 0; round < 110; round++) state = recordInferenceMetrics(state, event('run-59', round));
  assert.equal(state['run-59'].length, 100);
  assert.equal(state['run-59'][0].round, 10);
});
