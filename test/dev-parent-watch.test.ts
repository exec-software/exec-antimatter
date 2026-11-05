import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { DEV_PARENT_PID_ENV, devParentPid, watchDevParent } from '../src/main/devParentWatch';

test('reads the owner pid only when the environment names a real one', () => {
  assert.equal(devParentPid({ [DEV_PARENT_PID_ENV]: '4321' }), 4321);
  // A packaged build sets nothing, and must not start watching pid NaN.
  assert.equal(devParentPid({}), null);
  assert.equal(devParentPid({ [DEV_PARENT_PID_ENV]: '' }), null);
  assert.equal(devParentPid({ [DEV_PARENT_PID_ENV]: 'vite' }), null);
  assert.equal(devParentPid({ [DEV_PARENT_PID_ENV]: '1.5' }), null);
  // 0 and 1 are not owners anyone spawned from; treating them as such would mean a window that
  // closes itself on launch.
  assert.equal(devParentPid({ [DEV_PARENT_PID_ENV]: '0' }), null);
  assert.equal(devParentPid({ [DEV_PARENT_PID_ENV]: '1' }), null);
});

test('fires once when the owner goes away, and not before', async () => {
  let alive = true;
  let fired = 0;
  const stop = watchDevParent({
    parentPid: 4321,
    onParentGone: () => (fired += 1),
    intervalMs: 10,
    alive: () => alive,
  });

  try {
    await delay(40);
    assert.equal(fired, 0, 'a living owner must not close the window');

    alive = false;
    await delay(60);
    assert.equal(fired, 1);

    // The interval is cleared on the first sighting, so a long-dead owner cannot queue up quits.
    await delay(60);
    assert.equal(fired, 1);
  } finally {
    stop();
  }
});

test('stopping the watch prevents the quit', async () => {
  let fired = 0;
  const stop = watchDevParent({
    parentPid: 4321,
    onParentGone: () => (fired += 1),
    intervalMs: 10,
    alive: () => false,
  });
  stop();
  await delay(50);
  assert.equal(fired, 0);
});

test('a pid that could not be an owner is never watched', async () => {
  let fired = 0;
  for (const parentPid of [0, 1, -7, Number.NaN]) {
    const stop = watchDevParent({
      parentPid,
      onParentGone: () => (fired += 1),
      intervalMs: 10,
      alive: () => false,
    });
    stop();
  }
  await delay(50);
  assert.equal(fired, 0, 'launching must not be mistaken for the owner having died');
});

test('detects a real process exiting, via the default kill(pid, 0) probe', async () => {
  // No injected `alive` here: this exercises the ESRCH path that runs in production.
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    owner.once('spawn', resolve);
    owner.once('error', reject);
  });

  let fired = 0;
  const stop = watchDevParent({ parentPid: owner.pid!, onParentGone: () => (fired += 1), intervalMs: 20 });
  try {
    await delay(60);
    assert.equal(fired, 0, 'the owner is still running');

    owner.kill('SIGKILL');
    await new Promise<void>((resolve) => owner.once('exit', () => resolve()));
    // The child is reaped by this process, so kill(pid, 0) now reports ESRCH rather than EPERM.
    await waitUntil(() => fired === 1, 2_000);
    assert.equal(fired, 1);
  } finally {
    stop();
  }
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the watch to fire.');
    await delay(10);
  }
}
