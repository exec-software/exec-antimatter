import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DevElectronProcess } from '../src/main/devElectronProcess';
import { DEV_PARENT_PID_ENV } from '../src/main/devParentWatch';

const silentLog = {
  info() {},
  warn() {},
};

test('serializes rebuilds and leaves sibling dev processes alive', { timeout: 8_000 }, async () => {
  const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
  });
  const manager = new DevElectronProcess({
    executable: process.execPath,
    argv: ['-e', 'setInterval(() => {}, 1_000)'],
    shutdownTimeoutMs: 500,
    log: silentLog,
  });

  try {
    await spawned(sibling);
    await manager.restart('initial test build');
    const firstPid = manager.pid;
    assert.ok(firstPid);

    // Rapid watcher notifications must coalesce behind the in-flight owner
    // operation rather than creating concurrent Electron children.
    await Promise.all([
      manager.restart('main test rebuild'),
      manager.restart('MCP test rebuild'),
    ]);

    const secondPid = manager.pid;
    assert.ok(secondPid);
    assert.notEqual(secondPid, firstPid);
    assert.equal(isAlive(firstPid), false);
    assert.equal(isAlive(sibling.pid), true);
    assert.equal(isAlive(secondPid), true);
  } finally {
    await manager.stop();
    sibling.kill('SIGKILL');
  }
});

test('an Electron child exit does not terminate its Vite owner', { timeout: 4_000 }, async () => {
  const manager = new DevElectronProcess({
    executable: process.execPath,
    argv: ['-e', 'process.exit(0)'],
    shutdownTimeoutMs: 200,
    log: silentLog,
  });

  await manager.restart('short-lived test build');
  await waitUntil(() => !manager.isRunning());

  // Reaching this assertion is the regression check: the plugin default binds
  // Electron's exit to process.exit(), while the project-side owner leaves Vite
  // alive and ready for the next rebuild.
  assert.equal(manager.pid, undefined);
});

test(
  'waits for and force-stops residual descendants before launching the replacement',
  { timeout: 8_000, skip: process.platform !== 'linux' },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'antimatter-dev-process-'));
    const descendantPidPath = join(scratch, 'descendant.pid');
    const descendantScript = [
      "process.on('SIGTERM', () => {})",
      "require('node:fs').writeFileSync(process.env.ANTIMATTER_TEST_DESCENDANT_PID, String(process.pid))",
      'setInterval(() => {}, 1_000)',
    ].join(';');
    const ownerScript = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' })`,
      'setInterval(() => {}, 1_000)',
    ].join(';');
    const manager = new DevElectronProcess({
      executable: process.execPath,
      argv: ['-e', ownerScript],
      env: {
        ...process.env,
        ANTIMATTER_TEST_DESCENDANT_PID: descendantPidPath,
      },
      shutdownTimeoutMs: 250,
      log: silentLog,
    });

    try {
      await manager.restart('descendant test build');
      const firstPid = manager.pid;
      assert.ok(firstPid);
      await waitUntil(() => existsSync(descendantPidPath));
      const stubbornDescendantPid = Number(readFileSync(descendantPidPath, 'utf8'));
      assert.ok(stubbornDescendantPid);

      await manager.restart('descendant test rebuild');

      assert.notEqual(manager.pid, firstPid);
      assert.equal(isAlive(firstPid), false);
      await waitUntil(() => !isAlive(stubbornDescendantPid), 2_000);
      assert.equal(isAlive(stubbornDescendantPid), false);
    } finally {
      await manager.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }
);

test(
  'stops Electron when the Vite owner is signalled instead of exiting cleanly',
  { timeout: 8_000, skip: process.platform !== 'linux' },
  async () => {
    // Ctrl-C terminates Vite by signal, and a signal death runs no `exit` handlers.
    // Electron sits in its own process group so the terminal's SIGINT never reaches
    // it either, and a survivor holds the single-instance lock — the next
    // `npm run dev` then quits and focuses the stale window.
    //
    // Absorb SIGINT for the duration: the manager re-raises it, and without a
    // listener of our own Node would apply the default action and kill this runner.
    const absorb = () => {};
    process.on('SIGINT', absorb);
    const preexisting = new Set(process.listeners('SIGINT'));

    const manager = new DevElectronProcess({
      executable: process.execPath,
      // Ignore SIGTERM so only the manager's SIGKILL of the whole group can end it.
      argv: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
      shutdownTimeoutMs: 250,
      log: silentLog,
    });

    const registered = process
      .listeners('SIGINT')
      .filter((listener) => !preexisting.has(listener));

    try {
      assert.equal(registered.length, 1, 'the owner registers exactly one SIGINT handler');

      await manager.restart('signal test build');
      const pid = manager.pid;
      assert.ok(pid);
      assert.equal(isAlive(pid), true);

      // Invoking the registered handler is what the kernel does on Ctrl-C.
      (registered[0] as () => void)();

      await waitUntil(() => !isAlive(pid), 2_000);
      assert.equal(isAlive(pid), false, 'Electron must not outlive an interrupted Vite');
    } finally {
      for (const listener of registered) process.removeListener('SIGINT', listener as never);
      process.removeListener('SIGINT', absorb);
      await manager.stop();
    }
  }
);

test('tells the child which process owns it', { timeout: 6_000 }, async () => {
  // The child watches this pid so it can quit when Vite dies without cleaning up. If the variable
  // ever stops arriving, the watch silently never starts and stale windows come back.
  const scratch = mkdtempSync(join(tmpdir(), 'antimatter-dev-owner-'));
  const seen = join(scratch, 'owner.pid');
  const script = [
    `require('node:fs').writeFileSync(${JSON.stringify(seen)}, String(process.env.${DEV_PARENT_PID_ENV}))`,
    'setInterval(() => {}, 1_000)',
  ].join(';');
  const manager = new DevElectronProcess({
    executable: process.execPath,
    argv: ['-e', script],
    shutdownTimeoutMs: 250,
    log: silentLog,
  });

  try {
    await manager.restart('owner pid test build');
    await waitUntil(() => existsSync(seen));
    assert.equal(readFileSync(seen, 'utf8'), String(process.pid));
  } finally {
    await manager.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('relaunches after an abnormal exit, only once when the replacement is healthy', { timeout: 8_000 }, async () => {
  // The first child writes the marker then crashes (nonzero). The replacement sees the marker
  // and stays alive. This mirrors Electron dying with a startup fatal while Vite keeps running.
  const scratch = mkdtempSync(join(tmpdir(), 'antimatter-dev-relaunch-'));
  const marker = join(scratch, 'crashed-once');
  const script = [
    `const fs = require('node:fs')`,
    `const marker = ${JSON.stringify(marker)}`,
    `if (fs.existsSync(marker)) { setInterval(() => {}, 1_000); } else { fs.writeFileSync(marker, '1'); setTimeout(() => process.exit(3), 120); }`,
  ].join(';');
  const manager = new DevElectronProcess({
    executable: process.execPath,
    argv: ['-e', script],
    shutdownTimeoutMs: 250,
    log: silentLog,
  });

  try {
    await manager.restart('crash test build');
    const crashedPid = manager.pid;
    assert.ok(crashedPid);
    await waitUntil(() => manager.pid !== undefined && manager.pid !== crashedPid, 3_000);
    const relaunchedPid = manager.pid;
    assert.ok(relaunchedPid);
    assert.equal(isAlive(crashedPid), false);
    assert.equal(isAlive(relaunchedPid), true, 'the replacement must be running');

    // Give the replacement its own crash window: if the manager double-relaunched or the new
    // child also failed, the counter would climb. With no crash the counter stayed handled.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(manager.pid, relaunchedPid, 'a healthy replacement must not be cycled again');
  } finally {
    await manager.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('stops relaunching after the consecutive-crash allowance is exhausted', { timeout: 10_000 }, async () => {
  // Every child dies at the same point, so each auto-relaunch crashes again. After
  // MAX_UNEXPECTED_RESTARTS the manager must give up rather than relaunch forever.
  const scratch = mkdtempSync(join(tmpdir(), 'antimatter-dev-allowance-'));
  const script = `setTimeout(() => process.exit(1), 60); setInterval(() => {}, 1_000)`;
  const manager = new DevElectronProcess({
    executable: process.execPath,
    argv: ['-e', script],
    shutdownTimeoutMs: 250,
    log: silentLog,
  });

  try {
    await manager.restart('endless crash build');
    const firstPid = manager.pid;
    assert.ok(firstPid);

    // First crash relaunches, second crash relaunches, third crash relaunches; the fourth death
    // (of the third replacement) exceeds the allowance and must not spawn a fifth child.
    await waitUntil(() => !manager.isRunning(), 5_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(manager.pid, undefined, 'no further relaunch after the allowance is exhausted');
  } finally {
    await manager.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});

function spawned(child: ChildProcess): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for child process state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
