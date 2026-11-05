import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatHeader } from '../renderer/src/components/layout/ChatHeader';
import { IDLE_STATS } from '../renderer/src/lib/liveTurns';
import type { StreamStats } from '../renderer/src/types';
import type { InferenceMetrics } from '../src/api/types';

const NOW = 1_800_000;
const render = (patch: Partial<StreamStats> = {}, inference?: InferenceMetrics) => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: true }) } });
  try {
    return renderToStaticMarkup(createElement(ChatHeader, {
      stats: { ...IDLE_STATS, phase: 'thinking', startedAt: NOW - 15 * 60_000, lastAliveAt: NOW - 1_000, ...patch },
      sessionStartedAt: NOW - 20 * 60_000, error: '', context: null, thread: null, source: null, viewMode: 'transcript', onChangeViewMode() {},
      inference,
    }));
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
};

test('a recent heartbeat after a long wait describes connectivity without claiming inference progress', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const html = render();
  assert.match(html, /role="status"[^>]*>Waiting for reply</);
  assert.match(html, />connected</);
  assert.match(html, /not how far prompt processing or generation has progressed/);
  assert.match(html, /No answer text has arrived yet/);
  assert.doesNotMatch(html, /Source working|>alive</);
  assert.doesNotMatch(html, /quiet /);
});

test('reported prefill progress appears while waiting and never takes priority over agent waiting or model loading', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const inference: InferenceMetrics = {
    phase: 'prefill', requestStartedAt: NOW - 1000, requestDurationMs: 1000,
    promptProgress: { total: 10000, processed: 8000, cached: 6000, elapsedMs: 900 },
    cachedPromptTokens: 6000, promptTokens: 10000,
  };
  const html = render({}, inference);
  assert.match(html, /role="status"[^>]*>Processing prompt</);
  assert.match(html, /8,000 \/ 10,000 prompt tokens ready/);
  assert.match(html, /6,000 reused · 2,000 newly processed/);
  assert.match(html, /role="progressbar"[^>]*aria-valuemax="10000"[^>]*aria-valuenow="8000"/);
  const waiting = render({ waitingSince: NOW - 1_000 }, inference);
  assert.match(waiting, />Waiting on agents</);
  assert.doesNotMatch(waiting, /role="progressbar"/);
  const loading = render({ aliveNote: { label: 'Loading model' } }, inference);
  assert.match(loading, />Loading model</);
  assert.doesNotMatch(loading, /role="progressbar"/);
  const done = render({ phase: 'done', finishedAt: NOW }, inference);
  assert.doesNotMatch(done, /Processing prompt|role="progressbar"/);
});

test('the header distinguishes connecting, quiet, explicit loading, agent waiting, and visible output', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const connecting = render({ lastAliveAt: 0 });
  assert.match(connecting, /role="status"[^>]*>Connecting</);
  assert.doesNotMatch(connecting, />connected</);
  const quiet = render({ lastAliveAt: NOW - 60_000 });
  assert.match(quiet, /role="status"[^>]*>Waiting</);
  assert.match(quiet, />quiet /);
  assert.doesNotMatch(quiet, />connected</);
  assert.match(render({ aliveNote: { label: 'Loading model', seconds: 70 } }), /role="status"[^>]*>Loading model</);
  assert.match(render({ waitingSince: NOW - 30_000 }), /role="status"[^>]*>Waiting on agents</);
  const streaming = render({ phase: 'streaming', firstTokenAt: NOW - 5_000, lastTokenAt: NOW, chunks: 10, chars: 40 });
  assert.match(streaming, /role="status"[^>]*>Working</);
  assert.doesNotMatch(streaming, />connected<|Waiting for reply/);
  const done = render({ phase: 'done', finishedAt: NOW });
  assert.match(done, /role="status"[^>]*>Done</);
  assert.doesNotMatch(done, />connected</);
});
