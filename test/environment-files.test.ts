import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as files from '../src/main/environment/files';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'antimatter-editor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace'); mkdirSync(root); files.useRoot(root);
  return { directory, root };
}

test('editor saves compare file content on the host and preserve permissions', (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'run.sh'), '#!/bin/sh\necho before\n'); chmodSync(join(root, 'run.sh'), 0o755);
  const initial = files.read('run.sh');
  const saved = files.write('run.sh', '#!/bin/sh\necho after\n', { root, revision: initial.revision! });
  assert.notEqual(saved.revision, initial.revision);
  assert.equal(readFileSync(join(root, 'run.sh'), 'utf8'), saved.text);
  assert.equal(statSync(join(root, 'run.sh')).mode & 0o777, 0o755);
  assert.throws(() => files.write('run.sh', 'stale', { root, revision: initial.revision! }), /changed on disk/);
  assert.deepEqual(readdirSync(root), ['run.sh']);
});

test('same-mtime external writes and workspace switches cannot overwrite another edit', (t) => {
  const { directory, root } = fixture(t);
  writeFileSync(join(root, 'main.cpp'), 'original');
  const before = files.read('main.cpp');
  writeFileSync(join(root, 'main.cpp'), 'external');
  utimesSync(join(root, 'main.cpp'), before.modified / 1000, before.modified / 1000);
  assert.throws(() => files.write('main.cpp', 'editor', { root, revision: before.revision! }), /changed on disk/);
  assert.equal(readFileSync(join(root, 'main.cpp'), 'utf8'), 'external');
  const next = join(directory, 'next'); mkdirSync(next); files.useRoot(next);
  assert.throws(() => files.write('main.cpp', 'wrong project', { root, revision: before.revision! }), /folder/);
  assert.equal(existsSync(join(next, 'main.cpp')), false);
});

test('all file operations reject traversal and symbolic-link parents', (t) => {
  const { directory, root } = fixture(t);
  const outside = join(directory, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret'), 'untouched');
  symlinkSync(outside, join(root, 'linked'));
  symlinkSync(join(outside, 'secret'), join(root, 'linked-file'));
  assert.throws(() => files.read('../outside/secret'), /outside/);
  assert.throws(() => files.read('linked/secret'), /symbolic link/);
  assert.throws(() => files.write('linked/new', 'bad'), /symbolic link/);
  assert.throws(() => files.create('linked/new', 'file'), /symbolic link/);
  assert.throws(() => files.read('linked-file'), /symbolic link/);
  assert.throws(() => files.list('linked'), /symbolic link/);
  assert.throws(() => files.rename('linked-file', 'other'), /symbolic link/);
  assert.throws(() => files.remove('linked'), /symbolic link/);
  assert.throws(() => files.remove(''), /directory itself/);
  assert.throws(() => files.rename('', 'nested'), /directory itself/);
  assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'untouched');
});

test('non-UTF8 and binary files are read-only and input validation leaves files intact', (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'binary.dat'), Buffer.from([0xff, 0xfe, 0x61]));
  assert.equal(files.read('binary.dat').binary, true);
  assert.equal(files.read('binary.dat').text, '');
  assert.throws(() => files.write('file.txt', 'x\0y'), /UTF-8/);
  assert.throws(() => files.write('file.txt', 'ü'.repeat(3 * 1024 * 1024)), /4 MiB/);
  assert.throws(() => files.create('file.txt', 'device' as 'file'), /entry type/);
  assert.deepEqual(readdirSync(root), ['binary.dat']);
});
