import assert from 'node:assert/strict';
import test from 'node:test';
import { projectInferenceProgress, RemoteInferenceState } from '../src/main/remote/inferenceProgress';

const event = { round: 1, metrics: { phase: 'prefill', requestStartedAt: 100, requestDurationMs: 40,
  promptProgress: { total: 1000, cached: 600, processed: 700, elapsedMs: 30 },
  promptTokens: 1000, cachedPromptTokens: 600, prefillTokens: 100,
  request: { payloadFingerprint: 'private', messageCharacters: 99999 }, secret: 'private' } };

test('remote progress carries only actual public timing fields and strips host request diagnostics', () => {
  assert.deepEqual(projectInferenceProgress(event), { round: 1, phase: 'prefill', requestStartedAt: 100,
    requestDurationMs: 40, promptProgress: { total: 1000, cached: 600, processed: 700, elapsedMs: 30 },
    promptTokens: 1000, cachedPromptTokens: 600, prefillTokens: 100 });
  assert.equal(projectInferenceProgress({ content: 'private' }), null);
  assert.equal(projectInferenceProgress({ ...event, round: -1 }), null);
  assert.equal(projectInferenceProgress({ ...event, metrics: { ...event.metrics, requestDurationMs: Infinity } }), null);
  const invalid = projectInferenceProgress({ ...event, metrics: { ...event.metrics,
    promptProgress: { total: 10, cached: 8, processed: 4, elapsedMs: 0 } } });
  assert.equal(invalid?.promptProgress, undefined);
  assert.equal(projectInferenceProgress({ round: 1, metrics: { phase: 'started', requestStartedAt: 100, requestDurationMs: 0 } })?.cachedPromptTokens, undefined);
});

test('reconnect state is isolated by run and request round and removed when the turn ends', () => {
  const state = new RemoteInferenceState();
  state.update('a', event);
  assert.equal(state.get('b'), undefined);
  const copy = state.get('a')!; copy.promptProgress!.cached = 0;
  assert.equal(state.get('a')!.promptProgress!.cached, 600);
  assert.equal(state.update('a', { ...event, metrics: { ...event.metrics, requestDurationMs: 20 } }), null);
  state.update('a', { ...event, metrics: { ...event.metrics, phase: 'streaming', requestDurationMs: 45 } });
  assert.equal(state.update('a', { ...event, metrics: { ...event.metrics, requestDurationMs: 50 } }), null);
  state.update('a', { round: 2, metrics: { phase: 'started', requestStartedAt: 200, requestDurationMs: 0 } });
  assert.equal(state.get('a')?.promptProgress, undefined);
  assert.equal(state.update('a', event), null);
  state.finish('a'); assert.equal(state.get('a'), undefined);
});
