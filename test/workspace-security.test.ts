import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileTools } from '../mcp/tools/files';
import { insideWorkspace } from '../mcp/workspace';
import { ensureWorkspace, removeWorkspace } from '../src/main/orchestrator/workspace';

function fixture(t: TestContext): { outside: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-workspace-security-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { outside, workspace };
}

test('insideWorkspace accepts existing and new paths whose real ancestors stay inside', (t) => {
  const { workspace } = fixture(t);
  const existing = join(workspace, 'existing.txt');
  writeFileSync(existing, 'safe');

  assert.equal(insideWorkspace(workspace, 'existing.txt'), existing);
  assert.equal(insideWorkspace(workspace, 'new/deep/file.txt'), join(workspace, 'new/deep/file.txt'));
});

test('insideWorkspace rejects an existing file reached through an escaping symlink', (t) => {
  const { outside, workspace } = fixture(t);
  writeFileSync(join(outside, 'secret.txt'), 'outside');
  symlinkSync(join(outside, 'secret.txt'), join(workspace, 'linked.txt'));

  assert.throws(() => insideWorkspace(workspace, 'linked.txt'), /resolves outside the workspace/);
});

test('insideWorkspace checks the nearest existing ancestor before allowing a new path', (t) => {
  const { outside, workspace } = fixture(t);
  symlinkSync(outside, join(workspace, 'linked-directory'), 'dir');

  assert.throws(
    () => insideWorkspace(workspace, 'linked-directory/new/deep/file.txt'),
    /resolves outside the workspace/
  );
});

test('write_file refuses a staging directory that is a symlink outside the workspace', async (t) => {
  const { outside, workspace } = fixture(t);
  const outsideFile = join(outside, 'victim.txt');
  writeFileSync(outsideFile, 'untouched');
  // The durable write stages through .antimatter-tmp; a symlink planted there would route the
  // staged bytes — and the mkdir call itself — outside the workspace.
  symlinkSync(outside, join(workspace, '.antimatter-tmp'), 'dir');
  const writeFile = fileTools.find((tool) => tool.name === 'write_file');
  assert.ok(writeFile);

  await assert.rejects(
    writeFile.run({ path: 'result.txt', content: 'safe result' }, { workspace }),
    /staging directory is not a real directory/
  );

  assert.equal(readFileSync(outsideFile, 'utf8'), 'untouched');
  assert.equal(existsSync(join(workspace, 'result.txt')), false);
});

test('ensureWorkspace rejects a symlink in place of an issue workspace', (t) => {
  const { outside, workspace } = fixture(t);
  symlinkSync(outside, join(workspace, 'ABC-123'), 'dir');

  assert.throws(
    () => ensureWorkspace(workspace, 'ABC-123'),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'workspace_escape' &&
      /symbolic link/.test(error.message)
  );
});

test('ensureWorkspace also rejects a broken workspace symlink', (t) => {
  const { outside, workspace } = fixture(t);
  symlinkSync(join(outside, 'missing'), join(workspace, 'ABC-124'), 'dir');

  assert.throws(
    () => ensureWorkspace(workspace, 'ABC-124'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'workspace_escape'
  );
});

test('terminal cleanup unlinks a substituted workspace symlink without running its hook outside', async (t) => {
  const { outside, workspace } = fixture(t);
  const issuePath = join(workspace, 'ABC-125');
  symlinkSync(outside, issuePath, 'dir');

  assert.equal(
    await removeWorkspace(workspace, 'ABC-125', {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: 'touch hook-ran',
      timeoutMs: 1_000,
    }),
    true
  );

  assert.equal(existsSync(issuePath), false);
  assert.equal(existsSync(join(outside, 'hook-ran')), false);
});

test('terminal cleanup reports a failing before_remove hook and still removes the workspace', async (t) => {
  const { workspace } = fixture(t);
  const issuePath = join(workspace, 'ABC-126');
  mkdirSync(issuePath);
  writeFileSync(join(issuePath, 'work.txt'), 'finished');
  const warnings: string[] = [];

  assert.equal(
    await removeWorkspace(
      workspace,
      'ABC-126',
      {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: 'echo cleanup-detail >&2; exit 7',
        timeoutMs: 1_000,
      },
      (message) => warnings.push(message)
    ),
    true
  );

  assert.equal(existsSync(issuePath), false);
  assert.deepEqual(warnings, ['before_remove hook exited 7: cleanup-detail']);
});
