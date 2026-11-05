import assert from 'node:assert/strict';
import test from 'node:test';

import * as editLock from '../src/main/editLock';

test('an edit lease keeps the lock busy until it is released, and release is idempotent', () => {
  assert.equal(editLock.busy(), false);
  assert.equal(editLock.inFlight(), 0);

  const lease = editLock.acquire();
  assert.equal(editLock.busy(), true);
  assert.equal(editLock.inFlight(), 1);

  // A second lease stacks; the lock stays busy until both are gone.
  const second = editLock.acquire();
  assert.equal(editLock.inFlight(), 2);
  lease.release();
  lease.release();
  assert.equal(editLock.inFlight(), 1);
  assert.equal(editLock.busy(), true);
  second.release();
  assert.equal(editLock.busy(), false);
});

test('waitIdle resolves at once when nothing is being edited', async () => {
  assert.equal(await editLock.waitIdle(50), true);
});

test('waitIdle waits for an in-flight edit rather than quitting into it', async () => {
  const lease = editLock.acquire();
  let settled = false;
  const waiting = editLock.waitIdle(1_000).then((idle) => {
    settled = true;
    return idle;
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false);

  lease.release();
  assert.equal(await waiting, true);
  assert.equal(settled, true);
});

test('waitIdle gives up at the timeout rather than hanging a quit on a stuck write', async () => {
  const lease = editLock.acquire();
  try {
    const started = Date.now();
    assert.equal(await editLock.waitIdle(40), false);
    assert.ok(Date.now() - started >= 40);
    assert.equal(editLock.busy(), true);
  } finally {
    lease.release();
  }
});
