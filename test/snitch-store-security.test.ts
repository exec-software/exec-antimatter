import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProject, deleteProject, loadProject, readProject, setRoot, useConfigPath } from '../src/main/snitch/store';

function fixture(t: Parameters<typeof test>[1] extends (arg: infer T) => unknown ? T : never) {
  const base = mkdtempSync(join(tmpdir(), 'antimatter-snitch-security-'));
  const root = join(base, 'snitch');
  mkdirSync(root);
  useConfigPath(join(base, 'snitch-config.json'));
  setRoot(root);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root };
}

test('a project cannot delete a prefix-sharing directory outside the Snitch root', (t) => {
  const { base, root } = fixture(t);
  const outside = join(base, 'snitch-backup');
  mkdirSync(outside);
  const sentinel = join(outside, 'keep.txt');
  writeFileSync(sentinel, 'keep');
  const projectPath = join(root, 'Evil.yaml');
  writeFileSync(projectPath, 'name: Evil\nissues_dir: ../snitch-backup\nrequests_dir: Evil-requests\n');

  assert.throws(() => deleteProject('Evil'), /issues_dir must name a child directory/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
  assert.equal(existsSync(projectPath), true);
});

test('absolute, root-equal, and escaping-symlink item directories are rejected on load', (t) => {
  const { base, root } = fixture(t);
  const outside = join(base, 'outside');
  mkdirSync(outside);

  writeFileSync(join(root, 'Absolute.yaml'), `name: Absolute\nissues_dir: ${outside}\nrequests_dir: safe\n`);
  assert.throws(() => readProject('Absolute'), /issues_dir must be a relative directory/);

  writeFileSync(join(root, 'Root.yaml'), 'name: Root\nissues_dir: .\nrequests_dir: safe\n');
  assert.throws(() => readProject('Root'), /issues_dir must name a child directory/);

  symlinkSync(outside, join(root, 'linked-items'));
  writeFileSync(join(root, 'Linked.yaml'), 'name: Linked\nissues_dir: linked-items\nrequests_dir: safe\n');
  assert.throws(() => readProject('Linked'), /issues_dir resolves outside/);
});

test('unsafe frontmatter ids are ignored rather than becoming write or delete paths', (t) => {
  const { root } = fixture(t);
  createProject('Safe');
  const itemDir = join(root, 'Safe-issues');
  writeFileSync(
    join(itemDir, 'BUG-MALICIOUS.md'),
    '---\nid: ../../outside-owned\ntitle: "Malicious"\nstatus: open\n---\n'
  );

  assert.deepEqual(loadProject('Safe').items, []);
  assert.equal(existsSync(join(root, '..', 'outside-owned.md')), false);
});
