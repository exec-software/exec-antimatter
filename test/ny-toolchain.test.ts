import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { nyCompileArgs, requireNyTool, resolveNyToolchain } from '../src/main/environment/ny';

const tools = ['nycompiler', 'nyinterpreter', 'nylsp', 'nydebugger'];
function sdk(directory: string, commands = tools): void {
  mkdirSync(directory, { recursive: true });
  for (const command of commands) {
    const path = join(directory, command + (process.platform === 'win32' ? '.exe' : ''));
    writeFileSync(path, 'fixture'); chmodSync(path, 0o755);
  }
}
function fixture(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-ny-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Ny discovers a flat v1 SDK through explicit folder, repository root, and supported environment roots', (t) => {
  const root = fixture(t), repository = join(root, 'Ny SDK with spaces'), installed = join(repository, 'build', 'sdk');
  sdk(installed);
  for (const options of [{ sdkPath: installed }, { sdkPath: repository }, { environment: { NY_HOME: repository } },
    { environment: { NY_SDK_PATH: installed } }, { environment: { NY_SDK_DIR: installed } }]) {
    const found = resolveNyToolchain(root, { environment: {}, ...options });
    assert.equal(found.sdkPath, installed); assert.equal(found.error, null);
    assert.equal(found.lsp, join(installed, `nylsp${process.platform === 'win32' ? '.exe' : ''}`));
  }
});

test('Ny configured folder is authoritative and never silently changes compiler version', (t) => {
  const root = fixture(t), other = join(root, 'other'); sdk(other);
  const options = { sdkPath: join(root, 'missing'), environment: { PATH: other } };
  assert.equal(resolveNyToolchain(root, options).compiler, null);
  assert.throws(() => requireNyTool(root, 'compiler', options), /configured SDK path/);
});

test('Ny discovers the sibling language project from app directory even for a separate workspace', (t) => {
  const root = fixture(t), app = join(root, 'projects', 'exec-antimatter'), installed = join(root, 'projects', 'exec-lang-ny', 'build', 'sdk');
  sdk(installed);
  const found = resolveNyToolchain(join(root, 'workspace', 'consumer'), { appDirectory: app, environment: {} });
  assert.equal(found.sdkPath, installed); assert.equal(found.source, 'sibling');
});

test('Ny never combines compiler and runtime from different PATH installations', (t) => {
  const root = fixture(t), first = join(root, 'first'), second = join(root, 'second');
  sdk(first, ['nycompiler']); sdk(second, ['nyinterpreter', 'nylsp', 'nydebugger']);
  const found = resolveNyToolchain(root, { environment: { PATH: [first, second].join(delimiter) }, appDirectory: root });
  assert.equal(found.compiler, join(first, `nycompiler${process.platform === 'win32' ? '.exe' : ''}`));
  assert.equal(found.interpreter, null); assert.match(found.error!, /missing/);
});

test('Ny compile invocation preserves source paths literally and emits unbundled debug NIL', () => {
  const source = '/project/a $(literal); file.ny', output = '/private temp/result.nil';
  assert.deepEqual(nyCompileArgs(source, output, { debugInfo: true, sdkPath: '/SDK path' }),
    ['--no-bundle', '--quiet', '--debug-info', '--sdk-path', '/SDK path', '--output', output, source]);
  assert.ok(!nyCompileArgs(source, output).includes('--no-stdlib'));
});

test('NIL Framework resolves current names and nilbuild as one SDK while honoring NIL environment configuration', t => {
  const root = fixture(t), repository = join(root, 'exec-nil-framework'), installed = join(repository, 'build', 'sdk');
  sdk(installed, ['nilcompiler', 'nilinterpreter', 'nillsp', 'nildebugger', 'nilbuild']);
  for (const options of [{ sdkPath: repository }, { environment: { NIL_SDK_PATH: repository } }, { environment: { NIL_HOME: installed } }]) {
    const found = resolveNyToolchain(root, { environment: {}, ...options });
    assert.equal(found.family, 'nil'); assert.equal(found.sdkPath, installed); assert.equal(found.error, null);
    assert.equal(found.builder, join(installed, `nilbuild${process.platform === 'win32' ? '.exe' : ''}`));
  }
});

test('NIL Framework discovery prefers the current sibling checkout and does not mix executable families', t => {
  const root = fixture(t), app = join(root, 'projects', 'exec-antimatter');
  const current = join(root, 'projects', 'exec-nil-framework', 'build', 'sdk');
  const legacy = join(root, 'projects', 'exec-lang-ny', 'build', 'sdk');
  sdk(current, ['nilcompiler', 'nilinterpreter', 'nillsp', 'nildebugger', 'nilbuild']); sdk(legacy);
  assert.equal(resolveNyToolchain(root, { appDirectory: app, environment: {} }).sdkPath, current);
  const mixed = join(root, 'mixed'); sdk(mixed, ['nilcompiler', 'nyinterpreter', 'nylsp', 'nydebugger']);
  const partial = resolveNyToolchain(root, { sdkPath: mixed, environment: {} });
  assert.equal(partial.family, 'nil'); assert.equal(partial.interpreter, null); assert.equal(partial.builder, null);
  assert.match(partial.error!, /missing/);
});

test('project debug compilation keeps import roots literal and emits source metadata', () => {
  const args = nyCompileArgs('/project/main.matrix', '/private/program.nil', { debugInfo: true, includePaths: ['/project/imports with spaces', '/other/$(literal)'] });
  assert.deepEqual(args, ['--no-bundle', '--quiet', '--debug-info', '-I', '/project/imports with spaces', '-I', '/other/$(literal)', '--output', '/private/program.nil', '/project/main.matrix']);
});
