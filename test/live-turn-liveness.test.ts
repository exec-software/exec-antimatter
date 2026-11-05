import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleProvider } from '../src/api/providers/openai';
import type { ProviderConfig, StreamCallback } from '../src/api/types';
import { beginTurn, endTurn, NO_TURNS, noteAlive } from '../renderer/src/lib/liveTurns';
import { currentTurns, subscribeTurns, updateTurns } from '../renderer/src/lib/liveTurnsStore';

const begin = () => beginTurn(NO_TURNS, 'chat', { runId: 'run', source: null, startedAt: 500 });

test('redundant beats notify the UI store only once per second, with immediate first activity', (t) => {
  updateTurns(begin);
  let notifications = 0;
  const stop = subscribeTurns(() => notifications++);
  t.after(() => { stop(); updateTurns(() => NO_TURNS); });
  for (let at = 1_000; at < 3_000; at += 5) updateTurns((turns) => noteAlive(turns, { id: 'run', at }));
  assert.equal(notifications, 2);
  assert.equal(currentTurns().chat.stats.lastAliveAt, 2_000);
  assert.equal(currentTurns().chat.stats.phase, 'thinking');
  assert.equal(currentTurns().chat.stats.firstTokenAt, 0);
  updateTurns((turns) => noteAlive(turns, { id: 'run', at: 3_000 }));
  assert.equal(notifications, 3);
});

test('changed loading/status fields are immediate and duplicate notes use the same heartbeat budget', () => {
  let turns = noteAlive(begin(), { id: 'run', at: 1_000 });
  const loading = { label: 'Loading model', model: 'one', seconds: 0 };
  const firstNote = noteAlive(turns, { id: 'run', at: 1_001, note: loading });
  assert.notEqual(firstNote, turns);
  assert.equal(noteAlive(firstNote, { id: 'run', at: 1_002, note: { ...loading } }), firstNote);
  turns = firstNote;
  for (const [index, note] of [{ ...loading, seconds: 1 }, { ...loading, seconds: 1, model: 'two' }, { label: 'Waiting for slot' }].entries()) {
    const next = noteAlive(turns, { id: 'run', at: 1_003 + index, note });
    assert.notEqual(next, turns);
    assert.deepEqual(next.chat.stats.aliveNote, note);
    turns = next;
  }
  assert.equal(noteAlive(turns, { id: 'run', at: 1_999 }), turns);
  assert.equal(noteAlive(turns, { id: 'run', at: 2_005 }).chat.stats.aliveNote?.label, 'Waiting for slot');
});

test('coalescing is per run and cannot revive stopped, unknown or replaced runs', () => {
  let turns = noteAlive(begin(), { id: 'run', at: 1_000 });
  turns = beginTurn(turns, 'other', { runId: 'other-run', source: null, startedAt: 900 });
  turns = noteAlive(turns, { id: 'other-run', at: 1_001 });
  assert.equal(turns.other.stats.lastAliveAt, 1_001);
  assert.equal(noteAlive(turns, { id: 'unknown', at: 99_000 }), turns);
  turns = endTurn(turns, 'run', { failed: false, finishedAt: 1_002 });
  assert.equal(noteAlive(turns, { id: 'run', at: 99_000 }), turns);
  turns = beginTurn(turns, 'chat', { runId: 'replacement', source: null, startedAt: 1_003 });
  assert.equal(noteAlive(turns, { id: 'run', at: 99_000 }), turns);
  assert.equal(noteAlive(turns, { id: 'replacement', at: 1_004 }).chat.stats.lastAliveAt, 1_004);
});

test('a wall-clock correction does not suppress UI activity until the old time catches up', () => {
  const turns = noteAlive(begin(), { id: 'run', at: 5_000 });
  assert.equal(noteAlive(turns, { id: 'run', at: 1_000 }).chat.stats.lastAliveAt, 1_000);
});

test('provider watchdogs still receive every frame while renderer beats coalesce, without delaying output', async (t) => {
  const config: ProviderConfig = { id: 'source', name: 'Source', apiKey: '', baseUrl: 'http://test.invalid/v1', models: [], supportsStreaming: true };
  const frames = [
    ': keepalive',
    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hello.txt\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{"content":"answer"}}]}',
    'data: [DONE]',
  ];
  t.mock.method(globalThis, 'fetch', async () => new Response(frames.join('\n\n'), { headers: { 'content-type': 'text/event-stream' } }));
  updateTurns(begin);
  let renders = 0;
  let watchdogTouches = 0;
  const stop = subscribeTurns(() => renders++);
  t.after(() => { stop(); updateTurns(() => NO_TURNS); });
  const received: Parameters<StreamCallback>[0][] = [];
  const result = await new OpenAICompatibleProvider(config).stream({ providerId: config.id, model: 'model', requestId: 'run', messages: [] },
    (delta) => received.push(delta),
    (note) => {
      watchdogTouches++;
      updateTurns((turns) => noteAlive(turns, { id: 'run', at: 1_000, note }));
    });
  assert.equal(watchdogTouches, frames.length);
  assert.equal(renders, 1);
  assert.equal(result.content, 'answer');
  assert.equal(result.reasoning, 'thinking');
  assert.equal(result.toolCalls[0].function.arguments, '{"path":"hello.txt"}');
  assert.deepEqual(received.filter((delta) => delta.content).map((delta) => delta.content), ['answer']);
  assert.deepEqual(received.filter((delta) => delta.reasoning).map((delta) => delta.reasoning), ['thinking']);
  assert.equal(received.find((delta) => delta.metrics?.phase === 'streaming')?.metrics?.firstTokenKind, 'reasoning');
  assert.equal(result.metrics?.phase, 'complete');
});
