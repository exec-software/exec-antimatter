import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildNilProject, createNilProject, describeNilProject, nilProjectInvocation } from '../src/main/environment/nilProjects';
import { resolveNyToolchain } from '../src/main/environment/ny';
import { NyDebugSession } from '../src/main/environment/nyDebug';
import type { DebugState } from '../src/main/environment/debug';

const sdkPath = process.env.ANTIMATTER_NY_TEST_SDK;
const integration = sdkPath ? {} : { skip: 'Set ANTIMATTER_NY_TEST_SDK to validate the current NIL Framework SDK.' };
const execute = promisify(execFile);
function temporary(t: test.TestContext): string {
  const parent = mkdtempSync(join(tmpdir(), 'antimatter-nil-sdk-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return parent;
}
async function waitFor(session: NyDebugSession, predicate: (state: DebugState) => boolean): Promise<DebugState> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate(session.state)) return session.state;
    if (session.state.error) throw new Error(session.state.error);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for NIL debug state: ${JSON.stringify(session.state)}`);
}

for (const language of ['ny', 'matrix', 'mixed'] as const) {
  test(`installed NIL SDK: ${language} starter checks, builds, runs, and refuses stale output`, integration, async t => {
    const parent = temporary(t); const project = createNilProject(parent, `${language} project`, language);
    const options = { sdkPath }; const tools = resolveNyToolchain(project.root, options);
    assert.equal(tools.family, 'nil', 'Integration requires a current NIL Framework SDK'); assert.ok(tools.builder);
    const description = await describeNilProject(project.root, project.entry, options); assert.ok(description);
    assert.equal(description.entry, join(project.root, project.entry));
    const checked = await buildNilProject(project.root, project.entry, 'check', options);
    assert.equal(checked.success, true, checked.output); assert.equal(checked.artifact, null);
    assert.equal(existsSync(description.vmOutput), false, 'Check cannot compile a runnable artifact');
    const built = await buildNilProject(project.root, project.entry, 'build', options);
    assert.equal(built.success, true, built.output); assert.equal(built.artifact, description.vmOutput);
    const run = nilProjectInvocation(description, tools, 'run');
    const output = await execute(run.command, run.args, { cwd: run.cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    assert.match(output.stdout, language === 'ny' ? /Hello from Ny/ : language === 'matrix' ? /Hello from Matrix/ : /Hello from Ny and Matrix/);
    const smoke = await describeNilProject(project.root, 'tests/smoke.ny', options); assert.ok(smoke);
    const smokeRun = nilProjectInvocation(smoke, tools, 'run');
    const smokeOutput = await execute(smokeRun.command, smokeRun.args, { cwd: smokeRun.cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    assert.match(smokeOutput.stdout, /Smoke test passed/);
    const original = readFileSync(description.vmOutput);
    writeFileSync(description.entry, language === 'ny' ? 'fn main() -> i32\n    return missing_name\nend fn\n' : 'book invalid\nmain returns override integer begin paragraph\n    give missing_name\nend paragraph\n');
    const failed = await buildNilProject(project.root, project.entry, 'build', options);
    assert.equal(failed.success, false); assert.equal(failed.artifact, null); assert.ok(failed.diagnostics.length);
    assert.deepEqual(readFileSync(description.vmOutput), original, 'Failed builds preserve but do not select the old artifact');
    await assert.rejects(execute(run.command, run.args, { cwd: run.cwd, timeout: 30_000 }), error => {
      assert.doesNotMatch(String((error as { stdout?: string }).stdout ?? ''), /Hello from/);
      return true;
    });
  });
}

test('installed NIL SDK: Matrix project debug retains original lines, locals, stepping, and output', integration, async t => {
  const project = createNilProject(temporary(t), 'matrix-debug', 'matrix');
  writeFileSync(join(project.root, project.entry), [
    'book application', '', 'main returns override integer begin paragraph',
    '    value answer as number is 42', '    say answer', '    give 0', 'end paragraph', '',
  ].join('\n'));
  let output = ''; const exits: number[] = [];
  const session = new NyDebugSession({ root: project.root, file: join(project.root, 'nil.project.json'), nilProjectPath: 'nil.project.json', nySdkPath: sdkPath,
    breakpoints: [{ file: project.entry, line: 5 }] }, { onState() {}, onData(data) { output += data; }, onExit(exit) { exits.push(exit.code); } });
  try {
    await session.start();
    const entry = await waitFor(session, state => state.phase === 'paused'); assert.equal(entry.reason, 'entry');
    assert.deepEqual(entry.resolved, [{ file: project.entry, line: 5 }]);
    await session.step('continue');
    const paused = await waitFor(session, state => state.phase === 'paused' && state.reason === 'breakpoint');
    assert.equal(paused.frames[0].file, project.entry); assert.equal(paused.frames[0].line, 5);
    assert.equal(await session.evaluate('answer'), '42');
    assert.equal(paused.variables.find(value => value.name === 'answer')?.value, '42');
    await session.step('next');
    const stepped = await waitFor(session, state => state.phase === 'paused' && state.reason === 'step');
    assert.equal(stepped.frames[0].file, project.entry); assert.equal(stepped.frames[0].line, 6);
    await session.applyBreakpoints([]); await session.step('continue');
    await waitFor(session, state => state.phase === 'stopped');
    assert.match(output, /42/); assert.deepEqual(exits, [0]);
  } finally { await session.stop(); }
});

test('installed NIL SDK: mixed project steps from Matrix caller into Ny callee with each frame’s locals', integration, async t => {
  const project = createNilProject(temporary(t), 'mixed-debug', 'mixed');
  writeFileSync(join(project.root, project.entry), [
    'book application', 'read everything from helper', 'main returns override integer begin paragraph',
    '    value original as number is 40', '    value answer is helper with original',
    '    say answer', '    give 0', 'end paragraph', '',
  ].join('\n'));
  writeFileSync(join(project.root, 'src/helper.ny'), [
    'module helper', '', 'pub fn helper(input: i64) -> i64', '    let inner = input + 2', '    return inner', 'end fn', '',
  ].join('\n'));
  let output = '';
  const session = new NyDebugSession({ root: project.root, file: join(project.root, 'nil.project.json'), nilProjectPath: 'nil.project.json', nySdkPath: sdkPath,
    breakpoints: [{ file: project.entry, line: 5 }, { file: 'src/helper.ny', line: 5 }] }, { onState() {}, onData(data) { output += data; }, onExit() {} });
  try {
    await session.start();
    const entry = await waitFor(session, state => state.phase === 'paused');
    assert.deepEqual(entry.resolved, [{ file: project.entry, line: 5 }, { file: 'src/helper.ny', line: 5 }]);
    await session.step('continue');
    const caller = await waitFor(session, state => state.phase === 'paused' && state.reason === 'breakpoint' && state.frames[0]?.file === project.entry);
    assert.equal(caller.frames[0].line, 5); assert.equal(await session.evaluate('original'), '40');
    await session.step('stepIn');
    const callee = await waitFor(session, state => state.phase === 'paused' && state.frames[0]?.file === 'src/helper.ny');
    assert.match(callee.frames[0].name, /helper/); assert.ok(callee.frames.length >= 2);
    assert.equal(await session.evaluate('input'), '40');
    const callerFrame = callee.frames.find(frame => frame.file === project.entry); assert.ok(callerFrame);
    await session.selectFrame(callerFrame.id); assert.equal(await session.evaluate('original'), '40');
    await session.selectFrame(callee.frames[0].id);
    await session.step('continue');
    const returnLine = await waitFor(session, state => state.phase === 'paused' && state.reason === 'breakpoint' && state.frames[0]?.file === 'src/helper.ny' && state.frames[0]?.line === 5);
    assert.equal(returnLine.variables.find(value => value.name === 'inner')?.value, '42');
    assert.equal(await session.evaluate('inner'), '42');
    await session.applyBreakpoints([]); await session.step('continue');
    await waitFor(session, state => state.phase === 'stopped'); assert.match(output, /42/);
  } finally { await session.stop(); }
});

test('installed NIL SDK: Linux native project builds and runs through the published target', process.platform === 'linux' ? integration : { skip: 'The NIL project native route is qualified on Linux.' }, async t => {
  const project = createNilProject(temporary(t), 'native-project', 'matrix'); const options = { sdkPath };
  const tools = resolveNyToolchain(project.root, options);
  const description = await describeNilProject(project.root, project.entry, options); assert.ok(description);
  const built = await buildNilProject(project.root, project.entry, 'build', options, undefined, 'native');
  if (!built.success) {
    // A VM-only SDK or missing host linker is an explicit capability boundary,
    // not a successful native qualification and never a reason to run an old output.
    assert.equal(built.artifact, null);
    assert.match(built.output, /LLVM|native.*(?:not enabled|not available|unavailable)|(?:cannot|could not|failed to).*(?:linker|clang\+\+|g\+\+|c\+\+)/i);
    t.skip(`Native SDK/toolchain unavailable: ${built.output.trim().slice(0, 300)}`); return;
  }
  assert.equal(built.artifact, description.nativeOutput);
  const run = nilProjectInvocation(description, tools, 'run', 'native');
  const result = await execute(run.command, run.args, { cwd: run.cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  assert.match(result.stdout, /Hello from Matrix/);
});

test('installed NIL SDK: cancellation lets the driver retire a compiler that ignores SIGTERM', process.platform === 'linux' ? integration : { skip: 'NIL compiler descendant cancellation is qualified on Linux.' }, async t => {
  const parent = temporary(t); const project = createNilProject(parent, 'cancel-project');
  const actual = resolveNyToolchain(project.root, { sdkPath }); assert.ok(actual.builder);
  const fixture = join(parent, 'cancel SDK'); mkdirSync(fixture);
  for (const [name, executable] of [['nilbuild', actual.builder], ['nilinterpreter', actual.interpreter], ['nillsp', actual.lsp], ['nildebugger', actual.debugger]]) {
    assert.ok(executable); symlinkSync(executable, join(fixture, name!));
  }
  const fakeCompiler = join(fixture, 'nilcompiler');
  writeFileSync(fakeCompiler, `#!${process.execPath}\nconst fs=require('node:fs'); const path=require('node:path');\nprocess.on('SIGTERM',()=>{});\nfs.writeFileSync(path.join(process.cwd(),'compiler-started'),String(process.pid));\nsetInterval(()=>{},1000);\n`);
  chmodSync(fakeCompiler, 0o755);
  const controller = new AbortController(); const marker = join(project.root, 'compiler-started'); let childPid: number | undefined;
  const operation = buildNilProject(project.root, project.entry, 'check', { sdkPath: fixture }, controller.signal);
  const rejected = assert.rejects(operation, /cancelled/);
  try {
    for (let attempt = 0; attempt < 300 && !existsSync(marker); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(marker), 'the real nilbuild launched the fake compiler in its own process group');
    childPid = Number(readFileSync(marker, 'utf8')); assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    controller.abort(); await rejected;
    assert.throws(() => process.kill(childPid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH', 'the compiler must be reaped before cancellation completes');
  } finally {
    controller.abort(); await rejected;
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* already reaped */ } }
  }
});
