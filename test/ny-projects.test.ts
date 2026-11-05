import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildNyFile, createNyProject, nySourcePath, parseNyDiagnostics } from '../src/main/environment/nyProjects';
import { resolveNyToolchain } from '../src/main/environment/ny';

test('Ny project creation is exclusive, bounded, and does not invent a package manager', t => {
  const parent = mkdtempSync(join(tmpdir(), 'ny-projects-')); t.after(() => rmSync(parent, { recursive: true, force: true }));
  const project = createNyProject(parent, 'New Ny project');
  assert.equal(project.entry, 'src/main.ny');
  assert.match(readFileSync(join(project.root, project.entry), 'utf8'), /Hello from Ny/);
  assert.match(readFileSync(join(project.root, 'tests/smoke.ny'), 'utf8'), /let value: i32/);
  assert.throws(() => createNyProject(parent, 'New Ny project'), /EEXIST/);
  for (const invalid of ['', '.', '..', '../escape', '/absolute', ' x', 'x/y', 'x'.repeat(81)]) assert.throws(() => createNyProject(parent, invalid));
  assert.throws(() => nySourcePath(project.root, '../outside.ny'));
  writeFileSync(join(parent, 'outside.ny'), 'outside');
  symlinkSync(join(parent, 'outside.ny'), join(project.root, 'outside.ny'));
  assert.throws(() => nySourcePath(project.root, 'outside.ny'), /inside this project/);
});

test('compiler diagnostics preserve file/line coordinates for parse and type errors', () => {
  const root = '/project'; const source = '/project/src/main.ny';
  const parsed = parseNyDiagnostics('Parse errors in /project/src/main.ny:\n  /project/src/main.ny:4: Expected expression\nType checking failed:\n  line 2: Undefined identifier\n/project/other.ny:3:7: Bad type', root, source);
  assert.deepEqual(parsed.map(d => [d.path, d.range.start.line, d.range.start.character, d.message]), [
    ['src/main.ny', 3, 0, 'Expected expression'], ['src/main.ny', 1, 0, 'Undefined identifier'], ['other.ny', 2, 6, 'Bad type'],
  ]);
});

const installed = resolveNyToolchain(process.cwd(), { sdkPath: process.env.ANTIMATTER_NY_TEST_SDK });
test('installed Ny SDK checks, builds, and runs generated source/test; errors leave source intact', { skip: !installed.compiler || !installed.interpreter }, async t => {
  const parent = mkdtempSync(join(tmpdir(), 'ny-project-real-')); t.after(() => rmSync(parent, { recursive: true, force: true }));
  const project = createNyProject(parent, 'project with spaces'); const options = { sdkPath: installed.sdkPath! };
  const checked = await buildNyFile(project.root, project.entry, 'check', options);
  assert.equal(checked.success, true, checked.output); assert.equal(checked.artifact, null);
  assert.equal(existsSync(join(project.root, '.antimatter')), false, 'Check never leaves generated artifacts');
  for (const file of [project.entry, 'tests/smoke.ny']) {
    const built = await buildNyFile(project.root, file, 'build', options);
    assert.equal(built.success, true, built.output); assert.ok(built.artifact);
    const output = execFileSync(installed.interpreter!, [built.artifact], { cwd: project.root, encoding: 'utf8', timeout: 15_000 });
    assert.match(output, file === project.entry ? /Hello from Ny/ : /Smoke test passed/);
  }
  const invalid = 'fn main() -> i32\n    return unknown_name\nend fn\n';
  writeFileSync(join(project.root, project.entry), invalid);
  const failed = await buildNyFile(project.root, project.entry, 'check', options);
  assert.equal(failed.success, false); assert.equal(failed.diagnostics[0].range.start.line, 1);
  assert.equal(readFileSync(join(project.root, project.entry), 'utf8'), invalid);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(buildNyFile(project.root, project.entry, 'build', options, aborted.signal), /cancelled/);
});
