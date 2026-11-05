import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AutomaticRestartCoordinator,
  automaticRestartBlockers,
  type AutomaticRestartReport,
} from '../src/main/updates/coordinator';

const ready = { automatic: true, status: 'ready', readyVersion: '0.1.0-alpha.2' };

test('the desktop policy accounts for every process-local source of work', () => {
  assert.deepEqual(
    automaticRestartBlockers({
      chatTurns: 1,
      providerBusy: true,
      agentRunnerBusy: true,
      runningAgentTasks: 1,
      orchestratorActive: true,
      orchestratorRuns: 1,
      orchestratorRetries: 1,
      recoveryBusy: true,
      liveTerminals: 1,
      environmentRun: true,
      debuggerActive: true,
      editBusy: true,
    }),
    [
      'A chat turn is still running.',
      'An inference request is still running.',
      'An agent task is still running.',
      'The orchestrator is active; stop it before Antimatter restarts automatically.',
      'The recovery shell is still running a request.',
      'A terminal session is still open.',
      'An environment command is still running.',
      'A debug session is still active.',
      'A file edit is still being committed.',
    ]
  );
});

test('automatic restart waits for process and renderer blockers, rechecks, then commits once', async (t) => {
  let processBlockers = ['A chat turn is still running.'];
  let rendererBlockers: string[] = [];
  let prepares = 0;
  let releases = 0;
  let claims = 0;
  let relaunches = 0;
  let quits = 0;
  let committing = false;
  const reports: AutomaticRestartReport[] = [];
  const coordinator = new AutomaticRestartCoordinator({
    state: () => ready,
    blockers: () => [...processBlockers],
    prepareRenderer: async () => {
      prepares += 1;
      return { blockers: rendererBlockers, release: () => releases += 1 };
    },
    target: () => ({ execPath: '/opt/antimatter', args: ['--one'] }),
    claim: () => {
      claims += 1;
      return true;
    },
    beginCommit: () => {
      committing = true;
    },
    endCommit: () => {
      committing = false;
    },
    relaunch: async () => {
      assert.equal(committing, true);
      relaunches += 1;
    },
    quit: () => {
      assert.equal(committing, true);
      quits += 1;
    },
    report: (report) => reports.push(report),
    retryMs: 60_000,
  });
  t.after(() => coordinator.stop());

  coordinator.offer();
  await coordinator.checkNow();
  assert.equal(prepares, 0, 'the renderer is not disturbed while process work is live');
  assert.deepEqual(reports.at(-1)?.blockers, processBlockers);

  processBlockers = [];
  rendererBlockers = ['Unsaved editor buffer: src/main/index.ts'];
  await coordinator.checkNow();
  assert.equal(prepares, 1);
  assert.deepEqual(reports.at(-1)?.blockers, rendererBlockers);

  rendererBlockers = [];
  processBlockers = [];
  await coordinator.checkNow();
  assert.equal(prepares, 2);
  assert.equal(claims, 1);
  assert.equal(relaunches, 1);
  assert.equal(quits, 1);
  assert.equal(releases, 1, 'a blocked attempt releases the renderer; the committed attempt keeps it frozen');
});

test('work that appears during the renderer save blocks the final commit', async (t) => {
  let blockers: string[] = [];
  let claims = 0;
  let releases = 0;
  const reports: AutomaticRestartReport[] = [];
  const coordinator = new AutomaticRestartCoordinator({
    state: () => ready,
    blockers: () => [...blockers],
    prepareRenderer: async () => {
      blockers = ['An environment command is still running.'];
      return { blockers: [], release: () => releases += 1 };
    },
    target: () => ({ execPath: '/opt/antimatter', args: [] }),
    claim: () => {
      claims += 1;
      return true;
    },
    beginCommit: () => {},
    endCommit: () => {},
    relaunch: async () => {},
    quit: () => {},
    report: (report) => reports.push(report),
    retryMs: 60_000,
  });
  t.after(() => coordinator.stop());

  coordinator.offer();
  await coordinator.checkNow();
  assert.equal(claims, 0);
  assert.deepEqual(reports.at(-1)?.blockers, blockers);
  assert.equal(releases, 1);
});

test('disabling automatic updates while the renderer prepares cancels the restart', async (t) => {
  const state = { ...ready };
  let release!: () => void;
  const prepared = new Promise<void>((resolve) => {
    release = resolve;
  });
  let claims = 0;
  let releases = 0;
  const coordinator = new AutomaticRestartCoordinator({
    state: () => state,
    blockers: () => [],
    prepareRenderer: async () => {
      await prepared;
      return { blockers: [], release: () => releases += 1 };
    },
    target: () => ({ execPath: '/opt/antimatter', args: [] }),
    claim: () => {
      claims += 1;
      return true;
    },
    beginCommit: () => {},
    endCommit: () => {},
    relaunch: async () => {},
    quit: () => assert.fail('a cancelled restart must not quit'),
    report: () => {},
  });
  t.after(() => coordinator.stop());

  coordinator.offer();
  const attempt = coordinator.checkNow();
  state.automatic = false;
  coordinator.cancel();
  release();
  await attempt;
  assert.equal(claims, 0);
  assert.equal(releases, 1);
});

test('a relaunch helper failure leaves the app running and does not retry the claimed pair', async (t) => {
  let claimed = false;
  let relaunches = 0;
  let quits = 0;
  let ended = 0;
  let releases = 0;
  const reports: AutomaticRestartReport[] = [];
  const coordinator = new AutomaticRestartCoordinator({
    state: () => ready,
    blockers: () => [],
    prepareRenderer: async () => ({ blockers: [], release: () => releases += 1 }),
    target: () => ({ execPath: '/opt/antimatter', args: [] }),
    claim: () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    beginCommit: () => {},
    endCommit: () => {
      ended += 1;
    },
    relaunch: async () => {
      relaunches += 1;
      throw new Error('spawn ENOENT');
    },
    quit: () => {
      quits += 1;
    },
    report: (report) => reports.push(report),
  });
  t.after(() => coordinator.stop());

  coordinator.offer();
  await coordinator.checkNow();
  coordinator.offer();
  await coordinator.checkNow();
  assert.equal(relaunches, 1);
  assert.equal(quits, 0);
  assert.equal(ended, 2, 'the commit gate is released after failure and after the rejected repeat claim');
  assert.equal(releases, 2, 'every non-quitting path releases the renderer hold');
  assert.match(reports.find((entry) => entry.error)?.error ?? '', /spawn ENOENT/);
});
