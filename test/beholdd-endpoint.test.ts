import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { isModelListResponse, LifecycleQueue, terminateChildProcess } from '../src/main/beholdd';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

test('recognizes a successful OpenAI-compatible model list', async () => {
  assert.equal(isModelListResponse(200, JSON.stringify({ object: 'list', data: [] })), true);
  assert.equal(
    isModelListResponse(200, JSON.stringify({ object: 'list', data: [{ id: 'qwen', object: 'model' }] })),
    true
  );
});

test('does not adopt an unrelated, unauthorized, or malformed HTTP listener', async () => {
  assert.equal(isModelListResponse(401, JSON.stringify({ data: [] })), false);
  assert.equal(isModelListResponse(503, JSON.stringify({ data: [] })), false);
  assert.equal(isModelListResponse(200, '<html>not a model server</html>'), false);
  assert.equal(isModelListResponse(200, JSON.stringify({ ok: true })), false);
  assert.equal(isModelListResponse(200, JSON.stringify({ data: [] })), false);
});

test('serializes lifecycle mutations and continues after a rejected operation', async () => {
  const queue = new LifecycleQueue();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.run(async () => {
    events.push('first:start');
    await gate;
    events.push('first:end');
  });
  const second = queue.run(async () => {
    events.push('second');
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second']);

  await assert.rejects(queue.run(async () => Promise.reject(new Error('expected'))), /expected/);
  assert.equal(await queue.run(async () => 'still runs'), 'still runs');
});

test('forced termination waits for child exit instead of resolving when SIGKILL is sent', async () => {
  const child = new FakeChild();
  let settled = false;
  const stopping = terminateChildProcess(child, 1, 100).then((exited) => {
    settled = true;
    return exited;
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(settled, false);

  child.emit('exit', null, 'SIGKILL');
  assert.equal(await stopping, true);
});

test('forced termination has a bounded failure result when no exit arrives', async () => {
  const child = new FakeChild();
  assert.equal(await terminateChildProcess(child, 1, 5), false);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});
