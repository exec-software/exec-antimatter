import assert from 'node:assert/strict';
import test from 'node:test';
import { abortableRead, LocalInferenceQueue } from '../src/main/localInferenceQueue';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('queued cancellation settles promptly, skips its operation and keeps later work behind the running transition', async () => {
  const queue = new LocalInferenceQueue(); const barrier = deferred(); const calls: string[] = [];
  const first = queue.run(async () => { calls.push('first'); await barrier.promise; calls.push('first-end'); });
  const controller = new AbortController(); const reason = new Error('cancel queued');
  const canceled = queue.run(async () => { calls.push('canceled'); }, controller.signal);
  const rejected = assert.rejects(canceled, (error) => error === reason);
  const last = queue.run(async () => { calls.push('last'); });
  await turn(); controller.abort(reason); await rejected;
  assert.deepEqual(calls, ['first']);
  barrier.resolve(); await Promise.all([first, last]);
  assert.deepEqual(calls, ['first', 'first-end', 'last']);
});

test('running cancellation retains serialization until mutation cleanup has completed', async () => {
  const queue = new LocalInferenceQueue(); const read = deferred(); const cleanup = deferred();
  const controller = new AbortController(); const reason = new Error('cancel running'); const calls: string[] = [];
  const running = queue.run(async () => {
    calls.push('start');
    try { await abortableRead(read.promise, controller.signal); }
    finally { calls.push('cleanup'); await cleanup.promise; calls.push('retired'); }
  }, controller.signal);
  let settled = false; const rejection = assert.rejects(running, (error) => error === reason).then(() => { settled = true; });
  const next = queue.run(async () => { calls.push('next'); });
  await turn(); controller.abort(reason); await turn();
  assert.deepEqual(calls, ['start', 'cleanup']); assert.equal(settled, false);
  cleanup.resolve(); await Promise.all([rejection, next]); read.resolve();
  assert.deepEqual(calls, ['start', 'cleanup', 'retired', 'next']);
});

test('already-aborted requests do no work and a rejected transition does not poison the queue', async () => {
  const queue = new LocalInferenceQueue(); const controller = new AbortController(); controller.abort(new Error('already stopped'));
  let calls = 0;
  await assert.rejects(queue.run(async () => { calls++; }, controller.signal), /already stopped/);
  await assert.rejects(queue.run(async () => { throw new Error('startup failed'); }), /startup failed/);
  assert.equal(await queue.run(async () => ++calls), 1);
});

test('read cancellation tolerates a late failing read without changing the cancellation reason', async () => {
  let reject!: (reason: Error) => void;
  const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
  const controller = new AbortController(); const reason = new Error('stopped read');
  const result = abortableRead(pending, controller.signal); const rejection = assert.rejects(result, (error) => error === reason);
  controller.abort(reason); await rejection; reject(new Error('late socket failure')); await turn();
});
