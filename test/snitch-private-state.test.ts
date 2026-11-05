import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as snitch from '../src/main/snitch/store';

const permissions = (path: string): number => statSync(path).mode & 0o777;

test('default Snitch state and config migrate to private modes while custom roots remain user-owned', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'antimatter-private-snitch-'));
  const previousHome = process.env.HOME;
  const originalHome = homedir();
  const privateHome = join(base, 'home');
  const configRoot = join(base, 'user-data');
  const configPath = join(configRoot, 'snitch.json');
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    snitch.useConfigPath(join(originalHome, '.antimatter', 'snitch.json'));
    rmSync(base, { recursive: true, force: true });
  });

  process.env.HOME = privateHome;
  mkdirSync(configRoot, { recursive: true, mode: 0o755 });
  writeFileSync(configPath, JSON.stringify({ version: 1, root: null }), { mode: 0o644 });
  chmodSync(configRoot, 0o755);
  chmodSync(configPath, 0o644);
  snitch.useConfigPath(configPath);

  const defaultRoot = join(privateHome, '.antimatter', 'snitch');
  mkdirSync(defaultRoot, { recursive: true, mode: 0o755 });
  chmodSync(defaultRoot, 0o755);
  let project = snitch.createProject('Private');
  project = snitch.addItem(project.name, 'issue', { title: 'Private issue', description: 'Sensitive detail' });
  const issueDirectory = join(defaultRoot, project.issuesDir);
  const requestDirectory = join(defaultRoot, project.requestsDir);
  const itemPath = join(issueDirectory, `${project.items[0].id}.md`);

  assert.equal(permissions(configRoot), 0o700);
  assert.equal(permissions(configPath), 0o600);
  assert.equal(permissions(defaultRoot), 0o700);
  assert.equal(permissions(project.path), 0o600);
  assert.equal(permissions(issueDirectory), 0o700);
  assert.equal(permissions(requestDirectory), 0o700);
  assert.equal(permissions(itemPath), 0o600);

  // Simulate a store created by an older build, then exercise the read-side migration.
  for (const directory of [configRoot, defaultRoot, issueDirectory, requestDirectory]) chmodSync(directory, 0o755);
  for (const file of [configPath, project.path, itemPath]) chmodSync(file, 0o644);
  snitch.loadProject(project.name);
  assert.equal(permissions(configRoot), 0o700);
  assert.equal(permissions(configPath), 0o600);
  assert.equal(permissions(defaultRoot), 0o700);
  assert.equal(permissions(project.path), 0o600);
  assert.equal(permissions(issueDirectory), 0o700);
  assert.equal(permissions(requestDirectory), 0o700);
  assert.equal(permissions(itemPath), 0o600);

  const customRoot = join(base, 'shared-snitch-checkout');
  mkdirSync(customRoot, { mode: 0o755 });
  snitch.setRoot(customRoot);
  let shared = snitch.createProject('Shared');
  shared = snitch.addItem(shared.name, 'issue', { title: 'Shared issue' });
  const sharedIssueDirectory = join(customRoot, shared.issuesDir);
  const sharedItem = join(sharedIssueDirectory, `${shared.items[0].id}.md`);
  chmodSync(customRoot, 0o755);
  chmodSync(shared.path, 0o644);
  chmodSync(sharedIssueDirectory, 0o755);
  chmodSync(sharedItem, 0o644);

  snitch.loadProject(shared.name);
  assert.equal(permissions(customRoot), 0o755);
  assert.equal(permissions(shared.path), 0o644);
  assert.equal(permissions(sharedIssueDirectory), 0o755);
  assert.equal(permissions(sharedItem), 0o644);
  assert.deepEqual(
    [...readdirSync(configRoot), ...readdirSync(defaultRoot), ...readdirSync(customRoot)].filter((name) =>
      name.endsWith('.tmp')
    ),
    []
  );
});
