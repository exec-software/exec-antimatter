import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildNilProject, createNilProject, describeNilProject, findNilProject, nilProjectCompileArgs, nilProjectInvocation } from '../src/main/environment/nilProjects';
import { resolveNyToolchain } from '../src/main/environment/ny';
import { nySourcePath, parseNyDiagnostics } from '../src/main/environment/nyProjects';

function temporary(t: test.TestContext): string {
  const parent = mkdtempSync(join(tmpdir(), 'antimatter-nil-projects-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return parent;
}

// This fake records literal driver invocations. It never compiles or executes project source.
function driver(parent: string): string {
  const sdk = join(parent, 'SDK with spaces'); mkdirSync(sdk);
  const source = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const value = key => args[args.indexOf(key) + 1];
const file = value('--project'); const directory = path.dirname(file); const data = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(path.join(directory, 'invocations.jsonl'), JSON.stringify(args) + '\\n');
const outputDirectory = path.resolve(directory, data.outputDirectory || 'build');
if (args[0] === 'describe') {
 const description = { schema: 'nil.project.description.v1', projectFile: file, projectDirectory: directory, name: data.name,
 entry: path.resolve(directory, data.entry), includePaths: [directory, ...(data.includePaths || []).map(root => path.resolve(directory, root))],
 sdkPath: args.includes('--sdk') ? value('--sdk') : data.sdkPath ? path.resolve(directory, data.sdkPath) : null,
 outputDirectory, vmOutput: path.join(outputDirectory, data.name + '.nil'), nativeOutput: path.join(outputDirectory, data.name),
 analysis: { disabledRules: [], warningsAsErrors: false, ...data.analysis } };
 process.stdout.write(JSON.stringify(description));
} else if (fs.existsSync(path.join(directory, 'hang'))) {
 fs.writeFileSync(path.join(directory, 'started'), String(process.pid));
 setInterval(() => {}, 1000);
} else if (fs.existsSync(path.join(directory, 'fail'))) {
 console.error(path.resolve(directory, data.entry) + ':3:5: error NIL0002: Invalid type'); process.exitCode = 1;
} else {
 console.error(path.resolve(directory, data.entry) + ':2:7: warning NIL1001: Trailing whitespace');
 if (args[0] === 'build') { fs.mkdirSync(outputDirectory, { recursive: true }); fs.writeFileSync(path.join(outputDirectory, data.name + (value('--target') === 'native' ? '' : '.nil')), 'artifact'); }
}
`;
  for (const name of ['nilbuild', 'nilcompiler', 'nilinterpreter', 'nillsp', 'nildebugger']) {
    const file = join(sdk, name); writeFileSync(file, name === 'nilbuild' ? source : `#!${process.execPath}\nprocess.exit(0);\n`); chmodSync(file, 0o755);
  }
  return sdk;
}

function invocations(root: string): string[][] {
  return readFileSync(join(root, 'invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

test('Ny, Matrix, and mixed starters use real manifests, explicit smoke projects, and exclusive directories', t => {
  const parent = temporary(t);
  for (const language of ['ny', 'matrix', 'mixed'] as const) {
    const project = createNilProject(parent, `New ${language} project`, language);
    const manifest = JSON.parse(readFileSync(join(project.root, 'nil.project.json'), 'utf8'));
    assert.equal(manifest.schema, 'nil.project.v1'); assert.equal(manifest.name, `New-${language}-project`);
    assert.equal(manifest.entry, project.entry); assert.equal(project.entry, `src/main.${language === 'ny' ? 'ny' : 'matrix'}`);
    assert.deepEqual(manifest.includePaths, ['src']); assert.ok(existsSync(join(project.root, 'tests/nil.project.json')));
    assert.equal(findNilProject(project.root, project.entry), join(project.root, 'nil.project.json'));
    assert.equal(findNilProject(project.root, 'tests/smoke.ny'), join(project.root, 'tests/nil.project.json'));
    assert.equal(nySourcePath(project.root, project.entry), join(project.root, project.entry));
    assert.match(readFileSync(join(project.root, 'README.md'), 'utf8'), /nilbuild run --project tests\/nil.project.json/);
    if (language === 'mixed') assert.match(readFileSync(join(project.root, 'src/greeting.ny'), 'utf8'), /pub fn greeting/);
    assert.throws(() => createNilProject(parent, `New ${language} project`, language), /EEXIST/);
  }
  for (const bad of ['', '../escape', '/absolute', ' x', 'x/y', 'x'.repeat(81)]) assert.throws(() => createNilProject(parent, bad, 'matrix'));
  assert.throws(() => createNilProject(parent, 'Other', 'unknown' as 'ny'), /Choose Ny/);
});

test('manifest discovery stops at the workspace boundary and rejects external symlinks', t => {
  const parent = temporary(t); const project = createNilProject(parent, 'nested');
  const empty = join(project.root, 'child'); mkdirSync(empty);
  assert.equal(findNilProject(empty), null, 'parent manifests cannot take over a separately opened workspace');
  assert.throws(() => findNilProject(project.root, '../elsewhere/main.matrix'), /inside the open workspace/);
  const external = join(parent, 'outside'); mkdirSync(external); writeFileSync(join(external, 'nil.project.json'), '{}');
  symlinkSync(external, join(project.root, 'linked'));
  assert.throws(() => findNilProject(project.root, 'linked/main.matrix'), /inside the open workspace/);
});

test('discovery accepts every driver manifest format, nearest directory first and NILData ahead of legacy', t => {
  const parent = temporary(t);
  // v2 projects write nil.project.nildata. Finding only the legacy JSON name made them invisible:
  // no project actions, and Pensieve's automatic compiler feedback went quiet without reporting it.
  for (const name of ['nil.project.nildata', 'nil.project.json', 'nil.project.yaml', 'nil.project.yml']) {
    const root = join(parent, `only-${name}`); mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, name), 'schema is "nil.project.v1"\n');
    writeFileSync(join(root, 'src/main.matrix'), 'book application\n');
    assert.equal(findNilProject(root), join(root, name), `${name} must be discoverable`);
    assert.equal(findNilProject(root, 'src/main.matrix'), join(root, name));
  }

  // Within one directory the driver's documented order decides, so a converted project does not
  // keep building from the stale JSON its own conversion left behind.
  const mixed = join(parent, 'converted'); mkdirSync(mixed);
  for (const name of ['nil.project.yml', 'nil.project.yaml', 'nil.project.json', 'nil.project.nildata']) {
    writeFileSync(join(mixed, name), 'schema is "nil.project.v1"\n');
  }
  assert.equal(findNilProject(mixed), join(mixed, 'nil.project.nildata'), 'NILData outranks the compatibility formats');

  // The nearest directory still wins over format precedence further up.
  const nested = join(mixed, 'component'); mkdirSync(nested);
  writeFileSync(join(nested, 'nil.project.json'), '{"schema":"nil.project.v1"}\n');
  assert.equal(findNilProject(mixed, 'component/main.matrix'), join(nested, 'nil.project.json'),
    'a nearer legacy manifest outranks a NILData manifest in a parent directory');

  // The size guard names whichever format it actually rejected.
  const oversize = join(parent, 'oversize'); mkdirSync(oversize);
  writeFileSync(join(oversize, 'nil.project.nildata'), 'x'.repeat(1024 * 1024 + 1));
  assert.throws(() => findNilProject(oversize), /nil\.project\.nildata must be a regular UTF-8 file/);
});

test('nilbuild description owns configuration and project run preserves arguments and analyzer settings', { skip: process.platform === 'win32' }, async t => {
  const parent = temporary(t); const project = createNilProject(parent, 'Project with spaces', 'mixed'); const sdkPath = driver(parent);
  const manifest = JSON.parse(readFileSync(join(project.root, 'nil.project.json'), 'utf8'));
  manifest.analysis = { disabledRules: ['NIL1001'], warningsAsErrors: true }; manifest.sdkPath = './local SDK';
  writeFileSync(join(project.root, 'nil.project.json'), JSON.stringify(manifest));
  const options = { sdkPath }; const tools = resolveNyToolchain(project.root, options);
  const description = await describeNilProject(project.root, project.entry, options);
  assert.ok(description); assert.equal(description.language, 'matrix'); assert.equal(description.sdkPath, sdkPath);
  assert.deepEqual(description.analysis, manifest.analysis);
  assert.deepEqual(invocations(project.root)[0], ['describe', '--project', join(project.root, 'nil.project.json'), '--format', 'json', '--sdk', sdkPath]);
  const invocation = nilProjectInvocation(description, tools, 'run', 'vm', ['two words', '$(literal); *']);
  assert.equal(invocation.command, join(sdkPath, 'nilbuild')); assert.equal(invocation.cwd, project.root);
  assert.deepEqual(invocation.args, ['run', '--project', description.projectFile, '--target', 'vm', '--compiler', join(sdkPath, 'nilcompiler'), '--interpreter', join(sdkPath, 'nilinterpreter'), '--sdk', sdkPath, '--', 'two words', '$(literal); *']);
  assert.throws(() => nilProjectInvocation(description, tools, 'run', 'vm', ['bad\0argument']), /arguments/);
  const args = nilProjectCompileArgs(description, '/private/debug.nil', tools, { debugInfo: true });
  assert.ok(args.includes('--debug-info')); assert.deepEqual(args.slice(-3), ['--output', '/private/debug.nil', description.entry]);
  assert.deepEqual(args.filter((_, index) => args[index - 1] === '-I'), description.includePaths);
});

test('project checks do not produce artifacts, builds use fresh outputs, and failures never return an old artifact', { skip: process.platform === 'win32' }, async t => {
  const parent = temporary(t); const project = createNilProject(parent, 'example', 'matrix'); const options = { sdkPath: driver(parent) };
  const checked = await buildNilProject(project.root, project.entry, 'check', options);
  assert.equal(checked.success, true); assert.equal(checked.artifact, null); assert.equal(existsSync(join(project.root, 'build')), false);
  assert.deepEqual(checked.diagnostics.map(item => [item.path, item.severity, item.range.start.line, item.range.start.character]), [['src/main.matrix', 2, 1, 6]]);
  const built = await buildNilProject(project.root, project.entry, 'build', options);
  assert.equal(built.success, true); assert.equal(built.artifact, join(project.root, 'build/example.nil'));
  writeFileSync(join(project.root, 'fail'), '');
  const failed = await buildNilProject(project.root, project.entry, 'build', options);
  assert.equal(failed.success, false); assert.equal(failed.artifact, null); assert.equal(failed.diagnostics[0].severity, 1);
  assert.ok(existsSync(built.artifact!), 'an old artifact may remain on disk but is never returned as a successful build');
  assert.ok(invocations(project.root).every(args => ['describe', 'check', 'build'].includes(args[0])), 'checking and building cannot run source');
});

test('project description rejects output and entry escapes before a build invocation', { skip: process.platform === 'win32' }, async t => {
  const parent = temporary(t); const project = createNilProject(parent, 'example'); const options = { sdkPath: driver(parent) };
  const file = join(project.root, 'nil.project.json'); const manifest = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...manifest, outputDirectory: '../outside' }));
  await assert.rejects(buildNilProject(project.root, project.entry, 'build', options), /inside the open workspace/);
  writeFileSync(file, JSON.stringify({ ...manifest, entry: '../outside/main.matrix' }));
  await assert.rejects(describeNilProject(project.root, undefined, options), /inside the open workspace/);
  assert.ok(invocations(project.root).every(args => args[0] === 'describe'));
});

test('project operations honor cancellation before and during the child and leave no successful result', { skip: process.platform === 'win32' }, async t => {
  const parent = temporary(t); const project = createNilProject(parent, 'example'); const options = { sdkPath: driver(parent) };
  const before = new AbortController(); before.abort();
  await assert.rejects(buildNilProject(project.root, project.entry, 'build', options, before.signal), /cancelled/);
  assert.equal(existsSync(join(project.root, 'invocations.jsonl')), false);
  writeFileSync(join(project.root, 'hang'), ''); const during = new AbortController(); t.after(() => during.abort());
  const operation = buildNilProject(project.root, project.entry, 'build', options, during.signal);
  const asserted = assert.rejects(operation, /cancelled/);
  for (let attempt = 0; attempt < 200 && !existsSync(join(project.root, 'started')); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(join(project.root, 'started')), 'fake compiler started');
  during.abort(); await asserted;
  assert.equal(existsSync(join(project.root, 'build/example.nil')), false);
});

test('Ny and Matrix diagnostics retain warning severity without treating compiler chatter as errors', () => {
  const parsed = parseNyDiagnostics('/project/main.mat:5:9: warning NIL1001: Trailing whitespace\nCompiling graph...', '/project', '/project/main.mat', false);
  assert.deepEqual(parsed.map(item => [item.path, item.range.start.line, item.range.start.character, item.severity]), [['main.mat', 4, 8, 2]]);
  assert.deepEqual(parseNyDiagnostics('Build complete', '/project', '/project/main.matrix', false), []);
});
