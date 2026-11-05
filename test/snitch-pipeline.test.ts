import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clipHandoff, encodeIssueId, ownsSnitchTarget, Pipeline } from '../src/main/snitch/pipeline';
import * as store from '../src/main/snitch/store';

function fixture(t: Parameters<typeof test>[1] extends (arg: infer T) => unknown ? T : never) {
  const base = mkdtempSync(join(tmpdir(), 'antimatter-snitch-pipeline-'));
  const root = join(base, 'snitch');
  mkdirSync(root);
  store.useConfigPath(join(base, 'snitch.json'));
  store.setRoot(root);
  t.after(() => {
    store.useConfigPath(join(homedir(), '.antimatter', 'snitch.json'));
    rmSync(base, { recursive: true, force: true });
  });
  return { root };
}

test('fix-to-QA handoff preserves the closing report instead of opening narration', () => {
  const opening = `Opening investigation.\n${'looked around\n'.repeat(180)}`;
  const closing = 'FINAL SUMMARY\nsrc/main/example.ts: fixed the race.\nTests: focused regression passes.';
  const note = clipHandoff(`${opening}${closing}`, 240);

  assert.match(note, /^…\[\d+ earlier characters omitted\]/);
  assert.doesNotMatch(note, /Opening investigation/);
  assert.match(note, /FINAL SUMMARY/);
  assert.match(note, /focused regression passes\.$/);
});

test('live orchestrator ownership matches exact Snitch deletion targets', () => {
  const issue = encodeIssueId('Product', 'BUG-1', 'fixing', 4);

  assert.equal(ownsSnitchTarget(issue, 'Product'), true);
  assert.equal(ownsSnitchTarget(issue, 'Product', new Set(['BUG-1'])), true);
  assert.equal(ownsSnitchTarget(issue, 'Product', new Set(['BUG-10'])), false);
  assert.equal(ownsSnitchTarget(issue, 'Product-copy'), false);
  assert.equal(ownsSnitchTarget('not-snitch', 'Product'), false);
});

test('the fix pipeline stores the tail report and emits structured stage audit fields', (t) => {
  fixture(t);
  let project = store.createProject('Audit');
  project = store.addItem(project.name, 'issue', { title: 'Keep the summary' });
  const item = project.items[0];
  const logs: Array<Record<string, unknown>> = [];
  const pipeline = new Pipeline({ wake: () => undefined, log: (entry) => logs.push(entry) });
  pipeline.dispatch(project.name, item.id);
  pipeline.onTurnStart(encodeIssueId(project.name, item.id, 'fixing', 1));

  const closing = 'FINAL SUMMARY: changed the parser and added its regression test.';
  pipeline.onTurnEnd(encodeIssueId(project.name, item.id, 'fixing', 1), {
    ok: true,
    content: `${'early narration '.repeat(200)}${closing}`,
    runId: 'run-1',
    sessionId: 'session-1',
    rounds: 8,
    toolCalls: 7,
    reason: 'finished',
  });

  const saved = store.findItem(project.name, item.id);
  assert.equal(saved?.pipeline.stage, 'qa');
  assert.match(saved?.pipeline.note ?? '', /FINAL SUMMARY/);
  assert.doesNotMatch(saved?.pipeline.note ?? '', /^early narration/);
  assert.ok(logs.some((entry) =>
    entry.message === 'fix finished; queued for QA' &&
    entry.previousStage === 'fixing' &&
    entry.stage === 'qa' &&
    entry.runId === 'run-1' &&
    entry.rounds === 8 &&
    entry.toolCalls === 7
  ));
});

test('the first pipeline snapshot wakes persisted active work after a process restart', (t) => {
  fixture(t);
  let project = store.createProject('Resume');
  project = store.addItem(project.name, 'issue', { title: 'Resume me' });
  const item = project.items[0];
  store.setPipeline(project.name, item.id, { stage: 'qa', note: 'Fix summary.' }, 'in_progress');

  let wakes = 0;
  const logs: string[] = [];
  const restarted = new Pipeline({
    wake: () => {
      wakes += 1;
    },
    log: (entry) => logs.push(entry.message),
  });

  assert.equal(wakes, 0);
  assert.equal(restarted.snapshot()[0]?.stage, 'qa');
  assert.equal(wakes, 1);
  restarted.snapshot();
  assert.equal(wakes, 1, 'later UI refreshes must not create a wake loop');
  assert.deepEqual(logs, ['resuming 1 persisted pipeline item']);
});

test('a queued fixing run keeps the same tracker id after it starts', async (t) => {
  fixture(t);
  let project = store.createProject('Stable identity');
  project = store.addItem(project.name, 'issue', { title: 'Stay owned during reconcile' });
  const item = project.items[0];
  const pipeline = new Pipeline({ wake: () => undefined, log: () => undefined });

  pipeline.dispatch(project.name, item.id);
  const issueId = (await pipeline.fetchCandidateIssues())[0].id;
  pipeline.onTurnStart(issueId);
  const states = await pipeline.fetchIssueStatesByIds([issueId]);

  assert.equal(states.get(issueId), 'Fixing');
  assert.equal(store.findItem(project.name, item.id)?.pipeline.stage, 'fixing');
});

test('runner failure ceilings survive process restarts', (t) => {
  fixture(t);
  let project = store.createProject('Retry');
  project = store.addItem(project.name, 'issue', { title: 'Do not retry forever' });
  const item = project.items[0];
  const issueId = encodeIssueId(project.name, item.id, 'fixing', 1);
  const makePipeline = () => new Pipeline({ wake: () => undefined, log: () => undefined });

  let pipeline = makePipeline();
  pipeline.dispatch(project.name, item.id);
  pipeline.onTurnStart(issueId);
  pipeline.onTurnEnd(issueId, { ok: false, content: '', error: 'source disconnected' });
  assert.equal(store.findItem(project.name, item.id)?.pipeline.failures, 1);

  pipeline = makePipeline();
  pipeline.onTurnEnd(issueId, { ok: false, content: '', error: 'source disconnected again' });
  assert.equal(store.findItem(project.name, item.id)?.pipeline.failures, 2);

  pipeline = makePipeline();
  pipeline.onTurnEnd(issueId, { ok: false, content: '', error: 'still disconnected' });
  const failed = store.findItem(project.name, item.id)?.pipeline;
  assert.equal(failed?.failures, 3);
  assert.equal(failed?.stage, 'failed');
});

test('deliberately cancelled turns do not spend the persisted failure budget', (t) => {
  fixture(t);
  let project = store.createProject('Cancel');
  project = store.addItem(project.name, 'issue', { title: 'Stop cleanly' });
  const item = project.items[0];
  const issueId = encodeIssueId(project.name, item.id, 'fixing', 1);
  const pipeline = new Pipeline({ wake: () => undefined, log: () => undefined });
  pipeline.dispatch(project.name, item.id);
  pipeline.onTurnStart(issueId);

  pipeline.onTurnEnd(issueId, {
    ok: false,
    cancelled: true,
    content: '',
    error: 'application shutdown',
  });

  const saved = store.findItem(project.name, item.id)?.pipeline;
  assert.equal(saved?.stage, 'fixing');
  assert.equal(saved?.failures, 0);
});

test('a cancelled worker cannot settle a newly dispatched generation', async (t) => {
  fixture(t);
  let project = store.createProject('Ownership');
  project = store.addItem(project.name, 'issue', { title: 'Ignore stale completion' });
  const item = project.items[0];
  const pipeline = new Pipeline({ wake: () => undefined, log: () => undefined });

  pipeline.dispatch(project.name, item.id);
  const oldId = (await pipeline.fetchCandidateIssues())[0].id;
  pipeline.onTurnStart(oldId);
  pipeline.cancel(project.name, item.id);
  pipeline.dispatch(project.name, item.id);
  const newId = (await pipeline.fetchCandidateIssues())[0].id;

  assert.notEqual(newId, oldId);
  pipeline.onTurnEnd(oldId, { ok: true, content: 'stale fix result' });

  const saved = store.findItem(project.name, item.id)?.pipeline;
  assert.equal(saved?.stage, 'queued');
  assert.equal(saved?.generation, 3);
  assert.doesNotMatch(saved?.note ?? '', /stale fix result/);
});
