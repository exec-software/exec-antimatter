import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RemoteWorkspaceHost } from '../src/main/remote/host';
import { inferRemoteProjectName, RemoteProjectCatalog } from '../src/main/remote/projects';

const protector = {
  available: () => true,
  seal: (value: string) => Buffer.from(value, 'utf8').toString('base64'),
  open: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
};

test('remote projects expose opaque identity while roots stay host-private', () => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-project-'));
  const file = join(root, 'state', 'projects.json');
  const catalog = new RemoteProjectCatalog(file, () => 10, () => 'project-id');
  const summary = catalog.ensure(root, 'Antimatter');

  assert.deepEqual(summary, { id: 'project-id', name: 'Antimatter' });
  assert.deepEqual(catalog.list(), [summary]);
  assert.equal(catalog.resolve('project-id')?.root, root);
  assert.equal('root' in summary, false);
  assert.match(readFileSync(file, 'utf8'), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('remote projects de-duplicate canonical roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-project-dedupe-'));
  let ids = 0;
  const catalog = new RemoteProjectCatalog(join(root, 'projects.json'), () => 10, () => `p${++ids}`);
  assert.equal(catalog.ensure(root).id, 'p1');
  assert.equal(catalog.ensure(join(root, '.')).id, 'p1');
  assert.equal(catalog.list().length, 1);
});

test('inferred filesystem labels are bounded and printable without relaxing explicit project names', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-project-labels-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = new RemoteProjectCatalog(join(root, 'projects.json'));
  const names = ['x'.repeat(160), 'line\nbreak\tproject', ' \n\t '];
  const expected = ['x'.repeat(120), 'line break project', 'Project'];
  for (const [index, name] of names.entries()) {
    const project = join(root, name);
    mkdirSync(project);
    assert.equal(inferRemoteProjectName(project), expected[index]);
    assert.equal(catalog.ensure(project).name, expected[index]);
  }
  assert.equal(inferRemoteProjectName('/'), 'Project');
  assert.equal(inferRemoteProjectName(''), 'Project');
  const explicit = join(root, 'explicit');
  mkdirSync(explicit);
  for (const name of ['x'.repeat(121), 'line\nbreak', '   ', '']) {
    assert.throws(() => catalog.ensure(explicit, name), /120 printable characters/);
  }
});

test('the currently confirmed desktop project is first in a remote bootstrap catalog', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-project-current-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = join(root, 'first');
  const second = join(root, 'second');
  mkdirSync(first);
  mkdirSync(second);
  let selected = first;
  const host = new RemoteWorkspaceHost({
    userData: join(root, 'user-data'),
    appVersion: 'test',
    protector,
    callbacks: {
      currentProject: () => ({ root: selected }),
      bootstrap: () => ({}),
      thread: () => null,
      dispatch: () => undefined,
    },
  });

  const firstId = host.listProjects()[0].id;
  selected = second;
  const reordered = host.listProjects();
  assert.notEqual(reordered[0].id, firstId);
  assert.equal(reordered[1].id, firstId);
});

test('desktop task directories become remote projects even when they are not the current workspace', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-known-projects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const current = join(root, 'current');
  const task = join(root, 'task');
  mkdirSync(current);
  mkdirSync(task);
  const host = new RemoteWorkspaceHost({
    userData: join(root, 'user-data'),
    appVersion: 'test',
    protector,
    callbacks: {
      currentProject: () => ({ root: current }),
      knownProjects: () => [{ root: task }, { root: task }, { root: join(root, 'deleted') }],
      bootstrap: () => ({}),
      thread: () => null,
      dispatch: () => undefined,
    },
  });
  assert.deepEqual(host.listProjects().map((project) => project.name), ['current', 'task']);
  const taskId = host.projectForRoot(task)?.id;
  assert.ok(taskId);
  assert.equal(host.resolveProject(taskId)?.root, task);
  rmSync(current, { recursive: true });
  assert.deepEqual(host.listProjects().map((project) => project.name), ['task']);
  assert.equal(host.projectForRoot(current), null);
});

test('unavailable project roots are omitted and recover their stable identity when restored', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-remote-project-availability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const catalog = new RemoteProjectCatalog(join(root, 'projects.json'));
  const original = catalog.ensure(project);
  rmSync(project, { recursive: true });
  assert.deepEqual(catalog.list(), []);
  assert.equal(catalog.resolve(original.id), null);
  assert.equal(catalog.findByRoot(project), null);
  mkdirSync(project);
  assert.deepEqual(catalog.list(), [original]);
  assert.equal(catalog.ensure(project).id, original.id);

  rmSync(project, { recursive: true });
  const other = join(root, 'other');
  mkdirSync(other);
  symlinkSync(other, project);
  assert.deepEqual(catalog.list(), []);
  assert.equal(catalog.resolve(original.id), null, 'replacing an enrolled root with a symlink cannot redirect remote access');
});
