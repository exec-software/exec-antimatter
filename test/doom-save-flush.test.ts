import assert from 'node:assert/strict';
import test from 'node:test';
import { flushDoomSaves, persistDoomSave, registerDoomSnapshot } from '../renderer/src/lib/doomSaves';

test('close waits for the current engine snapshot and queued durable save', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let snapshots = 0;
  const unregister = registerDoomSnapshot(async () => {
    snapshots++;
    await persistDoomSave('snapshot', () => pending);
  });
  let done = false;
  const closing = flushDoomSaves().then((errors) => { done = true; return errors; });
  await Promise.resolve();
  assert.equal(snapshots, 1); assert.equal(done, false);
  release();
  assert.deepEqual(await closing, []);
  unregister();
});

test('failed save remains retryable after its game panel is gone', async () => {
  let attempts = 0;
  await assert.rejects(persistDoomSave('retry', async () => {
    attempts++;
    if (attempts === 1) { throw new Error('disk temporarily unavailable'); }
  }));
  assert.deepEqual(await flushDoomSaves(), []);
  assert.equal(attempts, 2);
  assert.deepEqual(await flushDoomSaves(), []);
  assert.equal(attempts, 2, 'successful writes retire their retry entry');
});

test('persistent disk errors block close until a later successful write', async () => {
  await assert.rejects(persistDoomSave('failure', async () => { throw new Error('read-only storage'); }));
  assert.match((await flushDoomSaves()).join(' '), /could not be written/);
  await persistDoomSave('failure', async () => {});
  assert.deepEqual(await flushDoomSaves(), []);
});

test('an unresponsive game snapshot has a bounded close handshake', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unregister = registerDoomSnapshot(() => new Promise(() => {}));
  const closing = flushDoomSaves();
  t.mock.timers.tick(3000);
  assert.match((await closing).join(' '), /still saving/);
  unregister();
});
