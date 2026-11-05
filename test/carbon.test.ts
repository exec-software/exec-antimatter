import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as carbon from '../src/main/carbon';
import type { ToolActivity } from '../src/main/toolLoop';

test('public endpoint strips credentials, query tokens, and fragments', () => {
  assert.equal(
    carbon.publicEndpoint('https://user:password@example.test:8443/v1/?token=secret#fragment'),
    'https://example.test:8443/v1'
  );
  assert.equal(carbon.publicEndpoint('file:///tmp/socket'), undefined);
  assert.equal(carbon.publicEndpoint('not a URL'), undefined);
});

test('carbon headers preserve the non-secret inference endpoint', () => {
  const previousRoot = carbon.location();
  const root = mkdtempSync(join(tmpdir(), 'antimatter-carbon-'));
  carbon.useRoot(root);

  try {
    const record = carbon.ensure({
      threadId: `source-${Date.now()}`,
      model: 'qwen3-coder-30b',
      sourceName: 'beholdd',
      sourceUrl: 'http://127.0.0.1:6768/v1',
      workspace: '/tmp/project',
      accessMode: 'ask',
    });

    const markdown = readFileSync(record.path, 'utf8');
    assert.match(markdown, /\*\*source:\*\* http:\/\/127\.0\.0\.1:6768\/v1/);
  } finally {
    carbon.useRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test('carbon records an aborted approval as failed and interrupted, never declined', () => {
  const activity: ToolActivity = {
    runId: 'run',
    callId: 'call',
    activityId: '0:0:call',
    approvalId: 'run:0:0:call',
    serverId: 'antimatter',
    serverName: 'Antimatter tools',
    toolName: 'run_command',
    tier: 'danger',
    args: '{\n  "command": "pwd"\n}',
    status: 'failed',
    awaitingApproval: false,
    result: 'Interrupted while waiting for approval to run run_command; nothing ran.',
  };

  const entry = carbon.toolActivityEntry(activity);
  assert.equal(entry.label, 'run_command — failed');
  assert.match(entry.body, /Interrupted while waiting for approval/);
  assert.doesNotMatch(entry.body, /declined/i);
});

test('same-clock threads with the same readable prefix receive distinct markdown names', () => {
  const now = new Date('2026-09-19T12:34:56.789Z');
  const first = carbon.markdownName('snitch:Project/BUG-1#fixing@1', now);
  const second = carbon.markdownName('snitch:Project/BUG-2#fixing@1', now);

  assert.notEqual(first, second);
  assert.match(first, /^carbon-2026-09-19T12-34-56-789Z_snitch_P-[a-f0-9]{12}\.md$/);
  assert.match(second, /^carbon-2026-09-19T12-34-56-789Z_snitch_P-[a-f0-9]{12}\.md$/);
});

test('a conversation resumes the same carbon after process memory is lost', (t) => {
  const previousRoot = carbon.location();
  const root = mkdtempSync(join(tmpdir(), 'antimatter-carbon-resume-'));
  carbon.useRoot(root);
  t.after(() => {
    carbon.useRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  });

  const meta = {
    threadId: 'durable-thread',
    model: 'first-model',
    sourceName: 'local',
    workspace: '/tmp/project',
    accessMode: 'ask',
  };
  const first = carbon.ensure(meta);
  carbon.add(meta.threadId, {
    kind: 'user',
    body: 'before restart',
    runId: 'run-one',
    model: meta.model,
  });

  // Selecting the same root clears the in-memory map, as a new main process would.
  carbon.useRoot(root);
  const resumed = carbon.ensure({ ...meta, model: 'second-model' });
  carbon.add(meta.threadId, {
    kind: 'assistant',
    body: 'after restart',
    runId: 'run-two',
    model: 'second-model',
  });

  assert.equal(resumed.path, first.path);
  assert.equal(readdirSync(root).filter((name) => name.endsWith('.md')).length, 1);
  const markdown = readFileSync(first.path, 'utf8');
  assert.match(markdown, /before restart/);
  assert.match(markdown, /after restart/);
  assert.match(markdown, /run `run-one`/);
  assert.match(markdown, /model `second-model`/);
});

test('the first durable run adopts a legacy markdown carbon without erasing it', (t) => {
  const previousRoot = carbon.location();
  const root = mkdtempSync(join(tmpdir(), 'antimatter-carbon-legacy-'));
  const legacyPath = join(root, 'carbon-old_thread.md');
  writeFileSync(
    legacyPath,
    '# Carbon — old-thread\n\n- **started:** 2026-01-02T03:04:05.000Z\n\n## [0] user\n\noriginal evidence\n'
  );
  carbon.useRoot(root);
  t.after(() => {
    carbon.useRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  });

  const record = carbon.ensure({
    threadId: 'old-thread',
    model: 'new-model',
    sourceName: 'local',
    workspace: '/tmp/project',
    accessMode: 'ask',
  });
  carbon.note('old-thread', 'continued after upgrade');

  assert.equal(record.path, legacyPath);
  assert.equal(readdirSync(root).filter((name) => name.endsWith('.md')).length, 1);
  const markdown = readFileSync(legacyPath, 'utf8');
  assert.match(markdown, /original evidence/);
  assert.match(markdown, /# Continued — old-thread/);
  assert.match(markdown, /continued after upgrade/);
});

test('carbon viewer rejects sibling-prefix paths and symbolic links', (t) => {
  const previousRoot = carbon.location();
  const base = mkdtempSync(join(tmpdir(), 'antimatter-carbon-boundary-'));
  const root = join(base, 'carbons');
  const sibling = join(base, 'carbons-private');
  const secret = join(sibling, 'secret.md');
  mkdirSync(root);
  mkdirSync(sibling);
  writeFileSync(secret, 'not a carbon\n');
  symlinkSync(secret, join(root, 'linked.md'));
  carbon.useRoot(root);
  t.after(() => {
    carbon.useRoot(previousRoot);
    rmSync(base, { recursive: true, force: true });
  });

  assert.throws(() => carbon.read(secret), /not a carbon/i);
  assert.throws(() => carbon.read(join(root, 'linked.md')), /not a carbon/i);
  assert.deepEqual(carbon.list(), []);
});
