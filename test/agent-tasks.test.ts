import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as tasks from '../src/main/agents/tasks';

test('queue is FIFO, cancellation is terminal, and interrupted running work recovers', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-tasks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  tasks.useConfigPath(join(root, 'tasks.json'));

  const first = tasks.add({ agentId: 'a', title: 'first', prompt: 'one' });
  const second = tasks.add({ agentId: 'a', title: 'second', prompt: 'two' });
  tasks.update(first.id, { createdAt: 1 });
  tasks.update(second.id, { createdAt: 2 });

  assert.equal(tasks.claim()?.id, first.id);
  tasks.cancel(first.id);
  tasks.settle(first.id, { ok: true, summary: 'late success' });
  assert.equal(tasks.find(first.id)?.state, 'cancelled');

  assert.equal(tasks.claim()?.id, second.id);
  assert.equal(tasks.requeueRunning(), 1);
  assert.equal(tasks.find(second.id)?.state, 'queued');
  assert.equal(tasks.find(second.id)?.startedAt, null);
});

test('a routed task keeps its reply address, and rows from older builds read back as null', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-tasks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'tasks.json');
  tasks.useConfigPath(path);

  // The address has to survive the round trip through disk: the run that needs it starts after
  // the turn that recorded it is over, and on a scheduled task, after a restart as well.
  const reply = { threadId: 'thread-1', messageId: 'assistant-1' };
  const routed = tasks.add({ agentId: 'researcher', title: 'explore', prompt: 'look around', source: 'router', reply });
  assert.deepEqual(tasks.find(routed.id)?.reply, reply);

  assert.equal(tasks.claim()?.reply?.messageId, 'assistant-1');
  tasks.settle(routed.id, { ok: true, summary: '8 round(s), 7 tool call(s)' });
  assert.deepEqual(tasks.find(routed.id)?.reply, reply, 'settling must not drop the address');

  // Dispatched by hand rather than routed: nothing is waiting, and that is a null, not an absence.
  const manual = tasks.add({ agentId: 'researcher', title: 'manual', prompt: 'go' });
  assert.equal(manual.reply, null);

  // A store written before tasks had the field at all.
  const older = join(root, 'older.json');
  writeFileSync(
    older,
    JSON.stringify({
      version: 1,
      tasks: [{ id: 'old', agentId: 'a', title: 't', prompt: 'p', source: 'manual', state: 'queued', workspace: null, createdAt: 1, startedAt: null, finishedAt: null, carbonId: null, schedule: null, dueAt: null, error: null, summary: null }],
    })
  );
  tasks.useConfigPath(older);
  assert.equal(tasks.find('old')?.reply, null);
});

test('a subagent is running from the moment it exists, and is not resumed after a restart', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-tasks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  tasks.useConfigPath(join(root, 'tasks.json'));

  const queued = tasks.add({ agentId: 'a', title: 'scheduled', prompt: 'later' });
  const subagent = tasks.add({
    agentId: 'a',
    title: 'for a chat turn',
    prompt: 'now',
    source: 'chat',
    parent: { threadId: 't', messageId: 'm' },
    startNow: true,
  });
  assert.equal(subagent.state, 'running');
  assert.ok(subagent.startedAt);
  assert.deepEqual(subagent.parent, { threadId: 't', messageId: 'm' });
  // The queue's worker must never pick up work somebody is already running.
  assert.equal(tasks.claim()?.id, queued.id);
  assert.equal(tasks.claim(), null);

  // The turn that waited for it ended with the app; running it again would help nobody.
  assert.equal(tasks.requeueRunning(), 2);
  assert.equal(tasks.find(subagent.id)?.state, 'failed');
  assert.equal(tasks.find(subagent.id)?.error, 'Interrupted when Antimatter stopped.');
  assert.equal(tasks.find(queued.id)?.state, 'queued');
  assert.equal(tasks.find(queued.id)?.parent, null);
});

test('pausing a schedule persists without losing its next run or history', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-schedule-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'tasks.json');
  tasks.useConfigPath(path);
  const task = tasks.add({ agentId: 'a', title: 'Daily check', prompt: 'Review', everyMinutes: 60 });
  tasks.setSchedulePaused(task.id, true);
  tasks.useConfigPath(path);
  assert.equal(tasks.find(task.id)?.paused, true);
  assert.equal(tasks.find(task.id)?.schedule, 'every 60m');
  assert.equal(tasks.claim(), null);
  assert.deepEqual(tasks.activity(new Map()), []);
  const resumed = tasks.setSchedulePaused(task.id, false);
  assert.ok(resumed.dueAt! > Date.now() + 59 * 60_000);
  tasks.update(task.id, { dueAt: 0 });
  assert.equal(tasks.claim()?.id, task.id);
  tasks.setSchedulePaused(task.id, true);
  tasks.settle(task.id, { ok: true, summary: 'Completed first check.' });
  assert.equal(tasks.find(task.id)?.state, 'queued');
  assert.equal(tasks.find(task.id)?.paused, true);
  assert.equal(tasks.find(task.id)?.summary, 'Completed first check.');
  tasks.update(task.id, { dueAt: 0 });
  assert.equal(tasks.claim(), null, 'pausing in flight prevents a later run');
});

test('invalid repeat intervals are rejected instead of becoming one-shot or unclaimable work', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-schedule-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  tasks.useConfigPath(join(root, 'tasks.json'));
  for (const everyMinutes of [0, -1, 0.5, Infinity, NaN, 525_601]) {
    assert.throws(() => tasks.add({ agentId: 'a', title: 'test', prompt: 'test', everyMinutes }), /repeat interval/);
  }
  const once = tasks.add({ agentId: 'a', title: 'one-off', prompt: 'test' });
  assert.throws(() => tasks.setSchedulePaused(once.id, true), /does not have a recurring schedule/);
});
