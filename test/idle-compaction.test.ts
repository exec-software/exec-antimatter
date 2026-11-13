import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IdleCompaction } from '../src/main/idleCompaction';
import { validateIdleCompactionPatch } from '../src/api/idleCompaction';

function fixture(t: test.TestContext, options: { hold?: boolean; fail?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-idle-'));
  let now = 0, busy = false, fingerprint = 'first', calls = 0, commits = 0;
  let signal: AbortSignal | undefined;
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const file = join(root, 'settings.json');
  const scheduler = new IdleCompaction({
    file, now: () => now, busy: () => busy,
    candidate: (threadId) => fingerprint ? { threadId, fingerprint, estimatedTokens: 10_000, payload: [] } : null,
    compact: async (_candidate, currentSignal) => {
      calls++; signal = currentSignal;
      if (options.hold) await pending;
      if (options.fail) throw new Error('Provider unavailable');
      return { compactedMessages: 4, payload: [] };
    },
    commit: () => { commits++; fingerprint = 'compacted'; return true; },
  });
  t.after(() => { scheduler.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { scheduler, file, finish, advance: () => { now += 61_000; }, busy: (value: boolean) => { busy = value; },
    change: (value: string) => { fingerprint = value; }, calls: () => calls, commits: () => commits, signal: () => signal };
}

test('defaults off; persists opt-in and waits for active-chat idle time', async (t) => {
  const f = fixture(t);
  f.scheduler.activity('chat'); f.advance(); await f.scheduler.poll();
  assert.equal(f.calls(), 0);
  f.scheduler.update({ enabled: true, idleMinutes: 1 });
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).preferences.enabled, true);
  await f.scheduler.poll(); assert.equal(f.calls(), 0);
  f.advance(); await f.scheduler.poll();
  assert.equal(f.commits(), 1); assert.equal(f.scheduler.state().phase, 'complete');
  f.advance(); await f.scheduler.poll(); assert.equal(f.calls(), 1, 'unchanged compacted context is not summarized repeatedly');
});

test('never competes with active inference; only one background request runs', async (t) => {
  const f = fixture(t, { hold: true });
  f.scheduler.update({ enabled: true, idleMinutes: 1 }); f.scheduler.activity('chat'); f.advance();
  f.busy(true); await f.scheduler.poll(); assert.equal(f.calls(), 0);
  f.busy(false); const first = f.scheduler.poll();
  await f.scheduler.poll(); assert.equal(f.calls(), 1);
  f.busy(true); f.finish(); await first;
  assert.equal(f.commits(), 0); assert.equal(f.scheduler.state().phase, 'waiting');
});

test('foreground cancellation waits for release and cannot commit an old summary', async (t) => {
  const f = fixture(t, { hold: true });
  f.scheduler.update({ enabled: true, idleMinutes: 1 }); f.scheduler.activity('chat'); f.advance();
  const run = f.scheduler.poll(); let released = false;
  const cancellation = f.scheduler.cancelAndWait().then(() => { released = true; });
  assert.equal(f.signal()?.aborted, true);
  await Promise.resolve(); assert.equal(released, false);
  f.finish(); await Promise.all([run, cancellation]);
  assert.equal(released, true); assert.equal(f.commits(), 0);
});

test('chat selection, deletion, and concurrent edits invalidate summaries', async (t) => {
  for (const action of ['selection', 'deleted', 'edited'] as const) {
    const f = fixture(t, { hold: true });
    f.scheduler.update({ enabled: true, idleMinutes: 1 }); f.scheduler.activity('chat'); f.advance();
    const run = f.scheduler.poll();
    if (action === 'selection') f.scheduler.activity('other');
    else f.change(action === 'deleted' ? '' : 'new revision');
    f.finish(); await run; assert.equal(f.commits(), 0, action);
  }
});

test('failure does not loop paid inference and settings writes fail without changing state', async (t) => {
  const f = fixture(t, { fail: true });
  f.scheduler.update({ enabled: true, idleMinutes: 1 }); f.scheduler.activity('chat'); f.advance();
  await f.scheduler.poll(); assert.equal(f.scheduler.state().phase, 'error');
  f.advance(); await f.scheduler.poll(); assert.equal(f.calls(), 1);
  const failing = new IdleCompaction({ file: f.file, candidate: () => null, busy: () => false,
    compact: async () => null, commit: () => true, write: () => { throw new Error('Disk full'); } });
  assert.throws(() => failing.update({ enabled: false }), /Disk full/);
  assert.equal(failing.state().preferences.enabled, true);
});

test('validates thresholds and rejects unknown settings', () => {
  for (const value of [null, [], { enabled: 'yes' }, { idleMinutes: 0 }, { idleMinutes: 1.1 }, { minimumTokens: 0 }, { model: 'other' }]) {
    assert.throws(() => validateIdleCompactionPatch(value));
  }
});
