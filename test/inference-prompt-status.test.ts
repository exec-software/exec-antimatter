import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InferencePromptStatus } from '../renderer/src/components/status/InferencePromptStatus';
import { InferenceDebugOverlay } from '../renderer/src/components/developer/InferenceDebugOverlay';
import type { InferenceMetrics } from '../src/api/types';

const metrics = (patch: Partial<InferenceMetrics> = {}): InferenceMetrics => ({
  phase: 'started', requestStartedAt: 100, requestDurationMs: 200, ...patch,
});
const render = (value: InferenceMetrics, active = true) => renderToStaticMarkup(createElement(InferencePromptStatus, { metrics: value, active }));

test('unreported cache and progress stay unknown instead of appearing as zero or a timer-derived percentage', () => {
  assert.equal(render(metrics()), '');
  assert.equal(render(metrics({ phase: 'streaming', promptTokens: 1000 })), '');
  const unknown = render(metrics({ phase: 'prefill' }));
  assert.match(unknown, /progress unreported/);
  assert.doesNotMatch(unknown, /progressbar|0 reused|%/);
  const empty = render(metrics({ phase: 'prefill', promptProgress: { total: 0, cached: 0, processed: 0, elapsedMs: 0 } }));
  assert.match(empty, /0 \/ 0 prompt tokens ready/);
  assert.doesNotMatch(empty, /progressbar|NaN|Infinity/);
});

test('reused tokens survive decoding and completion without leaving a prefill progress bar active', () => {
  for (const phase of ['streaming', 'complete'] as const) {
    const html = render(metrics({ phase, promptProgress: { total: 1000, cached: 800, processed: 1000, elapsedMs: 50 }, cachedPromptTokens: 800, promptTokens: 1000 }));
    assert.match(html, /800 prompt tokens reused \/ 1,000 input tokens/);
    assert.doesNotMatch(html, /progressbar|newly processed/);
  }
  assert.match(render(metrics({ phase: 'complete', cachedPromptTokens: 0 })), /0 prompt tokens reused/);
});

test('invalid progress cannot claim completed work or produce an invalid bar', () => {
  for (const progress of [
    { total: 100, processed: 110, cached: 0, elapsedMs: 10 },
    { total: 100, processed: 20, cached: 30, elapsedMs: 10 },
    { total: 100, processed: 20, cached: 0, elapsedMs: Number.NaN },
  ]) assert.doesNotMatch(render(metrics({ phase: 'prefill', promptProgress: progress })), /progressbar/);
});

test('the overlay identifies active prefill and distinguishes evaluated tokens from the reused prefix', () => {
  const html = renderToStaticMarkup(createElement(InferenceDebugOverlay, {
    active: true, onClose() {}, events: [{ id: 'run', round: 1, providerId: 'source', model: 'model', metrics: metrics({
      phase: 'prefill', promptProgress: { total: 1000, processed: 850, cached: 800, elapsedMs: 50 },
      cachedPromptTokens: 800, prefillTokens: 50, promptTokens: 1000,
    }) }],
  }));
  assert.match(html, />Processing prompt</);
  assert.match(html, /800 reused · 50 newly processed/);
  assert.match(html, /Reused prompt tokens/);
  assert.match(html, /Prefill tokens/);
  assert.match(html, /— means unreported/);
});
