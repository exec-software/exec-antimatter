import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as tasks from '../src/main/agents/tasks';
import * as carbon from '../src/main/carbon';
import * as conversations from '../src/main/conversations';

const permissions = (path: string): number => statSync(path).mode & 0o777;

test('conversation and task stores migrate old permissions and atomically remain private', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-private-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o755);

  const conversationPath = join(root, 'conversations.json');
  writeFileSync(
    conversationPath,
    JSON.stringify({ version: 1, threads: [], activeThreadId: null, pinned: [], drafts: {} }),
    { mode: 0o644 }
  );
  conversations.useStorePath(conversationPath);
  conversations.load();
  assert.equal(permissions(root), 0o700);
  assert.equal(permissions(conversationPath), 0o600);
  conversations.save({ activeThreadId: null });
  assert.equal(permissions(conversationPath), 0o600);

  chmodSync(root, 0o755);
  const taskPath = join(root, 'tasks.json');
  writeFileSync(taskPath, JSON.stringify({ version: 1, tasks: [] }), { mode: 0o644 });
  tasks.useConfigPath(taskPath);
  tasks.list();
  assert.equal(permissions(root), 0o700);
  assert.equal(permissions(taskPath), 0o600);
  tasks.add({ agentId: 'security-test', title: 'private', prompt: 'keep this private' });
  assert.equal(permissions(taskPath), 0o600);

  assert.deepEqual(
    readdirSync(root).filter((name) => name.endsWith('.tmp')),
    []
  );
});

test('carbon roots and existing and newly written carbon files are private', (t) => {
  const previousRoot = carbon.location();
  const root = mkdtempSync(join(tmpdir(), 'antimatter-private-carbon-'));
  t.after(() => {
    carbon.useRoot(previousRoot);
    rmSync(root, { recursive: true, force: true });
  });
  chmodSync(root, 0o755);
  const existing = join(root, 'carbon-existing.md');
  writeFileSync(existing, '# existing\n', { mode: 0o644 });

  carbon.useRoot(root);
  carbon.migratePermissions();
  assert.equal(permissions(root), 0o700);
  assert.equal(permissions(existing), 0o600);

  const record = carbon.ensure({
    threadId: `private-${Date.now()}`,
    model: 'coder',
    sourceName: 'local',
    workspace: '/tmp/project',
    accessMode: 'ask',
  });
  assert.equal(permissions(record.path), 0o600);
  assert.deepEqual(
    readdirSync(root).filter((name) => name.endsWith('.tmp')),
    []
  );
});

test('permission migration does not follow a symlinked carbon root', (t) => {
  const previousRoot = carbon.location();
  const base = mkdtempSync(join(tmpdir(), 'antimatter-private-carbon-link-'));
  const outside = join(base, 'outside');
  const linked = join(base, 'linked');
  const existing = join(outside, 'carbon-existing.md');
  t.after(() => {
    carbon.useRoot(previousRoot);
    rmSync(base, { recursive: true, force: true });
  });

  mkdirSync(outside, { mode: 0o755 });
  writeFileSync(existing, '# existing\n', { mode: 0o644 });
  chmodSync(outside, 0o755);
  chmodSync(existing, 0o644);
  symlinkSync(outside, linked, 'dir');
  carbon.useRoot(linked);
  carbon.migratePermissions();

  assert.equal(permissions(outside), 0o755);
  assert.equal(permissions(existing), 0o644);
});
