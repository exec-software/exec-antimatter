import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ServiceConfig } from '../src/main/orchestrator/config';
import { Orchestrator, type WorkflowSnapshot } from '../src/main/orchestrator/orchestrator';
import type { Tracker } from '../src/main/orchestrator/tracker';
import type { Issue } from '../src/main/orchestrator/types';

const issue: Issue = {
  id: 'issue-1', identifier: 'AM-1', title: 'Retry correctly', description: null,
  priority: 1, state: 'Todo', branchName: null, url: null, labels: [], blockedBy: [],
  createdAt: 1, updatedAt: 1,
};

function config(root: string): ServiceConfig {
  return {
    tracker: {
      kind: 'file', endpoint: '/tmp/issues', apiKey: null, projectSlug: null,
      activeStates: ['Todo'], terminalStates: ['Done'],
    },
    pollIntervalMs: 1_000,
    workspaceRoot: root,
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1_000 },
    agent: { maxConcurrentAgents: 1, maxTurns: 2, maxRetryBackoffMs: 300_000, maxConcurrentAgentsByState: {} },
    runner: {
      command: 'antimatter', turnTimeoutMs: 5_000, readTimeoutMs: 1_000, stallTimeoutMs: 0,
      approvalPolicy: 'never', providerId: null, model: null,
    },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface FakeTimer { callback: () => void; delay: number; active: boolean }

async function fakeTimers<T>(run: (timers: FakeTimer[]) => Promise<T>): Promise<T> {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers: FakeTimer[] = [];
  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    const timer: FakeTimer = { callback, delay: Number(delay), active: true };
    timers.push(timer);
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: FakeTimer) => {
    timer.active = false;
  }) as unknown as typeof clearTimeout;
  try {
    return await run(timers);
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
}

test('startup rejects an invalid workflow instead of becoming a healthy idle service', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-orchestrator-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot: WorkflowSnapshot = { config: config(root), promptTemplate: '', problems: ['tracker is broken'] };
  const orchestrator = new Orchestrator({
    loadWorkflow: () => snapshot,
    createTracker: () => { throw new Error('unused'); },
    runAgent: async () => undefined,
    log: () => undefined,
  });
  await assert.rejects(() => orchestrator.start(), /workflow validation failed: tracker is broken/);
});

test('failure retries carry their exponent forward', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-orchestrator-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot: WorkflowSnapshot = { config: config(root), promptTemplate: 'work', problems: [] };
  const tracker: Tracker = {
    fetchCandidateIssues: async () => [issue],
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => new Map([[issue.id, issue.state]]),
  };

  await fakeTimers(async (timers) => {
    const attempts: Array<number | null> = [];
    const orchestrator = new Orchestrator({
      loadWorkflow: () => snapshot,
      createTracker: () => tracker,
      runAgent: async (job) => {
        attempts.push(job.attempt);
        throw new Error('boom');
      },
      log: () => undefined,
      now: () => 1_000,
    });

    await orchestrator.start();
    await flush();
    assert.equal(orchestrator.snapshot().retrying[0]?.attempt, 1);
    assert.equal(orchestrator.snapshot().retrying[0]?.dueAt, 11_000);

    const retry = timers.find((timer) => timer.active && timer.delay === 10_000);
    assert.ok(retry);
    retry.active = false;
    retry.callback();
    await flush();
    await flush();

    assert.deepEqual(attempts, [null, 1]);
    assert.equal(orchestrator.snapshot().retrying[0]?.attempt, 2);
    assert.equal(orchestrator.snapshot().retrying[0]?.dueAt, 21_000);
    await orchestrator.stop();
  });
});

test('an invalid reload keeps the last-good reconciliation active and stop does not resurrect work', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-orchestrator-reload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot: WorkflowSnapshot = { config: config(root), promptTemplate: 'work', problems: [] };
  let invalid = false;
  let present = true;
  const logs: string[] = [];
  const tracker: Tracker = {
    fetchCandidateIssues: async () => [issue],
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => present ? new Map([[issue.id, issue.state]]) : new Map(),
  };

  await fakeTimers(async () => {
    const orchestrator = new Orchestrator({
      loadWorkflow: () => {
        if (invalid) throw new Error('bad yaml');
        return snapshot;
      },
      createTracker: () => tracker,
      runAgent: (job) => new Promise<void>((_resolve, reject) => {
        job.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
      log: (entry) => logs.push(entry.message),
    });

    await orchestrator.start();
    assert.equal(orchestrator.snapshot().running.length, 1);
    invalid = true;
    present = false;
    await orchestrator.tick();
    await flush();
    assert.equal(orchestrator.snapshot().running.length, 0);
    assert.equal(orchestrator.snapshot().retrying.length, 0);
    assert.ok(logs.some((message) => message.includes('workflow reload failed: bad yaml')));
    assert.ok(logs.some((message) => message.includes('missing from tracker; stopped')));

    await orchestrator.stop();
    await flush();
    assert.equal(orchestrator.snapshot().retrying.length, 0);
  });
});

test('an invalid reload reconciles existing work but does not dispatch new work', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-orchestrator-invalid-dispatch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot: WorkflowSnapshot = { config: config(root), promptTemplate: 'work', problems: [] };
  let invalid = false;
  let candidates: Issue[] = [];
  let runs = 0;
  const tracker: Tracker = {
    fetchCandidateIssues: async () => candidates,
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => new Map(),
  };

  await fakeTimers(async () => {
    const orchestrator = new Orchestrator({
      loadWorkflow: () => {
        if (invalid) throw new Error('unfinished edit');
        return snapshot;
      },
      createTracker: () => tracker,
      runAgent: async () => {
        runs += 1;
      },
      log: () => undefined,
    });

    await orchestrator.start();
    invalid = true;
    candidates = [issue];
    await orchestrator.tick();
    assert.equal(runs, 0);
    assert.equal(orchestrator.snapshot().running.length, 0);
    await orchestrator.stop();
  });
});

test('stop waits out an in-flight poll and prevents it from launching afterward', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-orchestrator-stop-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot: WorkflowSnapshot = { config: config(root), promptTemplate: 'work', problems: [] };
  let fetchCount = 0;
  let releaseFetch!: (issues: Issue[]) => void;
  const delayedCandidates = new Promise<Issue[]>((resolve) => {
    releaseFetch = resolve;
  });
  let runs = 0;
  const tracker: Tracker = {
    fetchCandidateIssues: async () => (++fetchCount === 1 ? [] : delayedCandidates),
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => new Map(),
  };

  await fakeTimers(async () => {
    const orchestrator = new Orchestrator({
      loadWorkflow: () => snapshot,
      createTracker: () => tracker,
      runAgent: async () => {
        runs += 1;
      },
      log: () => undefined,
    });

    await orchestrator.start();
    const poll = orchestrator.tick();
    await flush();
    const stopping = orchestrator.stop();
    releaseFetch([issue]);
    await Promise.all([poll, stopping]);

    assert.equal(runs, 0);
    assert.equal(orchestrator.snapshot().running.length, 0);
    await orchestrator.tick();
    assert.equal(runs, 0);
  });
});

test('startup cleanup gates external polls and workflow changes until activation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-orchestrator-startup-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot: WorkflowSnapshot = { config: config(root), promptTemplate: 'work', problems: [] };
  const cleanupEntered = deferred();
  const releaseCleanup = deferred();
  let candidateFetches = 0;
  let runs = 0;
  const tracker: Tracker = {
    fetchCandidateIssues: async () => {
      candidateFetches += 1;
      return [issue];
    },
    fetchIssuesByStates: async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      return [];
    },
    fetchIssueStatesByIds: async () => new Map([[issue.id, issue.state]]),
  };

  await fakeTimers(async () => {
    const orchestrator = new Orchestrator({
      loadWorkflow: () => snapshot,
      createTracker: () => tracker,
      runAgent: async () => {
        runs += 1;
      },
      log: () => undefined,
    });

    const starting = orchestrator.start();
    await cleanupEntered.promise;
    assert.equal(orchestrator.snapshot().active, false);

    await Promise.all([orchestrator.tick(), orchestrator.workflowChanged()]);
    assert.equal(candidateFetches, 0, 'external poll paths must not run during terminal cleanup');
    assert.equal(runs, 0, 'startup cleanup must finish before any issue dispatch');

    releaseCleanup.resolve();
    await starting;
    await flush();
    assert.equal(orchestrator.snapshot().active, true);
    assert.equal(candidateFetches, 1, 'startup should perform exactly one immediate poll');
    assert.equal(runs, 1);
    await orchestrator.stop();
  });
});

test('an interrupted startup relinquishes running state before a queued restart', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-orchestrator-interrupted-start-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot: WorkflowSnapshot = { config: config(root), promptTemplate: 'work', problems: [] };
  const cleanupEntered = deferred();
  const releaseCleanup = deferred();
  let cleanupCalls = 0;
  let candidateFetches = 0;
  const tracker: Tracker = {
    fetchCandidateIssues: async () => {
      candidateFetches += 1;
      return [];
    },
    fetchIssuesByStates: async () => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) {
        cleanupEntered.resolve();
        await releaseCleanup.promise;
      }
      return [];
    },
    fetchIssueStatesByIds: async () => new Map(),
  };

  await fakeTimers(async () => {
    const orchestrator = new Orchestrator({
      loadWorkflow: () => snapshot,
      createTracker: () => tracker,
      runAgent: async () => undefined,
      log: () => undefined,
    });

    const interruptedStart = orchestrator.start();
    await cleanupEntered.promise;
    const queuedStop = orchestrator.stop();
    // This continuation runs after startup observes the stop intent, but before the queued stop
    // transition. It recreates the exact ordering that used to leave running=true unscheduled.
    const queuedRestart = interruptedStart.then(() => orchestrator.start());
    releaseCleanup.resolve();
    await Promise.all([interruptedStart, queuedStop, queuedRestart]);

    assert.equal(cleanupCalls, 2, 'the newer start should execute a complete startup');
    assert.equal(candidateFetches, 1, 'the newer start should perform its immediate poll');
    await orchestrator.tick();
    assert.equal(candidateFetches, 2, 'the restarted service should remain active');
    await orchestrator.stop();
  });
});

function drainingLifecycleHarness(snapshot: WorkflowSnapshot) {
  const entered = deferred();
  const aborted = deferred();
  const release = deferred();
  let candidateFetches = 0;
  let runs = 0;

  const tracker: Tracker = {
    fetchCandidateIssues: async () => (++candidateFetches === 1 ? [issue] : []),
    fetchIssuesByStates: async () => [],
    fetchIssueStatesByIds: async () => new Map([[issue.id, issue.state]]),
  };
  const orchestrator = new Orchestrator({
    loadWorkflow: () => snapshot,
    createTracker: () => tracker,
    runAgent: async (job) => {
      runs += 1;
      entered.resolve();
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          aborted.resolve();
          void release.promise.then(() => resolve());
        };
        if (job.signal.aborted) onAbort();
        else job.signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    log: () => undefined,
  });

  return {
    orchestrator,
    entered,
    aborted,
    release,
    candidateFetches: () => candidateFetches,
    runs: () => runs,
  };
}

test('a start requested while stop is draining workers is not lost', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-orchestrator-restart-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot: WorkflowSnapshot = { config: config(root), promptTemplate: 'work', problems: [] };

  await fakeTimers(async () => {
    const harness = drainingLifecycleHarness(snapshot);
    await harness.orchestrator.start();
    await harness.entered.promise;

    const stopping = harness.orchestrator.stop();
    await harness.aborted.promise;
    const restarting = harness.orchestrator.start();
    harness.release.resolve();
    await Promise.all([stopping, restarting]);

    assert.equal(harness.runs(), 1);
    assert.equal(harness.candidateFetches(), 2, 'restart should perform its immediate poll');
    await harness.orchestrator.tick();
    assert.equal(harness.candidateFetches(), 3, 'the restarted service should accept a later poll');
    await harness.orchestrator.stop();
  });
});

test('a later stop cancels a start queued behind an in-flight stop', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-orchestrator-stop-wins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot: WorkflowSnapshot = { config: config(root), promptTemplate: 'work', problems: [] };

  await fakeTimers(async () => {
    const harness = drainingLifecycleHarness(snapshot);
    await harness.orchestrator.start();
    await harness.entered.promise;

    const stopping = harness.orchestrator.stop();
    await harness.aborted.promise;
    const queuedStart = harness.orchestrator.start();
    const finalStop = harness.orchestrator.stop();
    harness.release.resolve();
    await Promise.all([stopping, queuedStart, finalStop]);

    assert.equal(harness.candidateFetches(), 1, 'the superseded start must not poll');
    await harness.orchestrator.tick();
    assert.equal(harness.candidateFetches(), 1, 'the final requested state should remain stopped');
  });
});

test('repeated concurrent lifecycle requests settle to the latest requested state', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-orchestrator-lifecycle-burst-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot: WorkflowSnapshot = { config: config(root), promptTemplate: 'work', problems: [] };

  await fakeTimers(async () => {
    const harness = drainingLifecycleHarness(snapshot);
    await harness.orchestrator.start();
    await harness.entered.promise;

    const requests = [harness.orchestrator.stop()];
    await harness.aborted.promise;
    requests.push(
      harness.orchestrator.start(),
      harness.orchestrator.stop(),
      harness.orchestrator.start(),
      harness.orchestrator.stop(),
      harness.orchestrator.start()
    );
    harness.release.resolve();
    await Promise.all(requests);

    assert.equal(harness.candidateFetches(), 2, 'only the final start should restart and poll');
    await harness.orchestrator.tick();
    assert.equal(harness.candidateFetches(), 3, 'the final requested state should be running');
    await harness.orchestrator.stop();
  });
});
