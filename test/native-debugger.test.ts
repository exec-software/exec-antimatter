import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NativeDebugSession, type NativeDebugSpec } from '../src/main/environment/nativeDebug';
import * as debug from '../src/main/environment/debug';

function fixture(t: { after(fn: () => void): void }): NativeDebugSpec {
  const base = mkdtempSync(join(tmpdir(), 'antimatter-native-debug-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'source'); const buildDirectory = join(base, 'build'); mkdirSync(root); mkdirSync(buildDirectory);
  const debuggerPath = join(base, 'adapter'); copyFileSync(resolve('test/fixtures/native-dap-adapter.cjs'), debuggerPath); chmodSync(debuggerPath, 0o700);
  const program = join(buildDirectory, 'program'); writeFileSync(program, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(join(root, 'main.cpp'), 'int main() { return 42; }');
  return { root, buildDirectory, debuggerPath, program, breakpoints: [{ file: 'main.cpp', line: 3 }], args: ['with spaces', '$literal'] };
}
const events = { onState() {}, onData() {}, onExit() {} };
async function wait(session: NativeDebugSession, predicate: (session: NativeDebugSession) => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate(session)) { if (session.state.error) throw Error(session.state.error); if (Date.now() > deadline) throw Error(`Timeout: ${JSON.stringify(session.state)}`); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('native DAP configures before launch response, then uses real thread IDs for frames and controls', async t => {
  const spec = fixture(t); const session = new NativeDebugSession(spec, events); t.after(() => session.stop());
  await session.start(); await wait(session, current => current.state.frames.length === 2);
  assert.deepEqual(session.state.resolved, [{ file: 'main.cpp', line: 3 }]);
  assert.equal(session.state.variables[0].name, 'value'); assert.equal(await session.evaluate('value'), '42');
  await session.selectFrame('43'); assert.equal(session.state.variables[0].name, 'caller'); assert.equal(await session.evaluate('caller'), '43');
  await assert.rejects(session.selectFrame('old'), /no longer available/);
  for (const command of ['next', 'stepIn', 'stepOut'] as const) { await session.step(command); await wait(session, current => current.state.phase === 'paused' && current.state.frames.length === 2); }
  await session.applyBreakpoints([]); assert.deepEqual(session.state.resolved, []);
  await session.step('continue'); assert.equal(session.state.phase, 'running');
  await assert.rejects(session.evaluate('value'), /Nothing is paused/);
  await session.pause(); assert.equal(session.state.phase, 'paused');
  await session.stop(); assert.equal(session.state.phase, 'stopped');
  const log = readFileSync(join(spec.root, 'protocol.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(log.findIndex(m => m.command === 'setBreakpoints') < log.findIndex(m => m.command === 'configurationDone'));
  assert.deepEqual(log.find(m => m.command === 'launch').arguments.args, ['with spaces', '$literal']);
  assert.equal(log.at(-1).command, 'disconnect');
  assert.ok(log.filter(m => ['stackTrace', 'continue', 'next', 'stepIn', 'stepOut', 'pause'].includes(m.command)).every(m => m.arguments.threadId === 73));
});

test('artifact provenance and workspace boundary reject escaped paths before adapter operations', async t => {
  const spec = fixture(t);
  const invalid = new NativeDebugSession({ ...spec, buildDirectory: spec.root }, events);
  await assert.rejects(invalid.start(), /verified artifact/);
  const session = new NativeDebugSession(spec, events); t.after(() => session.stop()); await session.start();
  symlinkSync(spec.program, join(spec.root, 'escaped.cpp'));
  await assert.rejects(session.applyBreakpoints([{ file: '../outside.cpp', line: 2 }]), /outside/);
  await assert.rejects(session.applyBreakpoints([{ file: 'escaped.cpp', line: 2 }]), /outside/);
  await assert.rejects(session.evaluate('x'.repeat(8193)), /8192/);
});

test('public debugger dispatch reaches native frames, evaluation, controls, and stop', async t => {
  const spec = fixture(t); t.after(() => debug.stop()); debug.connect(events);
  await debug.startNative(spec);
  const deadline = Date.now() + 5000;
  while (debug.state().frames.length !== 2) { if (Date.now() > deadline) throw Error('Dispatch did not receive frames'); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(await debug.evaluate('value'), '42'); await debug.selectFrame('43'); assert.equal(debug.state().selectedFrameId, '43');
  await debug.resume(); assert.equal(debug.state().phase, 'running'); await debug.pause(); assert.equal(debug.state().phase, 'paused');
  await debug.stop(); assert.equal(debug.state().phase, 'stopped');
});

const nativeAdapter = process.env.ANTIMATTER_LLDB_DAP;
test('installed LLDB: C++ source breakpoint, real locals, caller selection, evaluation, stepping and exit', nativeAdapter ? {} : { skip: 'Set ANTIMATTER_LLDB_DAP to a real lldb-dap/lldb-vscode binary.' }, async t => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const execute = promisify(execFile);
  const spec = fixture(t); spec.debuggerPath = nativeAdapter!;
  writeFileSync(join(spec.root, 'main.cpp'), '#include <cstdio>\nint helper(int value) {\n  int answer = value + 2;\n  return answer;\n}\nint main() {\n  int value = 40;\n  int result = helper(value);\n  std::printf("%d\\n", result);\n  return 0;\n}\n');
  await execute(process.env.CXX ?? 'c++', ['-g', '-O0', join(spec.root, 'main.cpp'), '-o', spec.program]);
  spec.breakpoints = [{ file: 'main.cpp', line: 4 }];
  let output = ''; const exits: number[] = [];
  const session = new NativeDebugSession(spec, { onState() {}, onData: data => { output += data; }, onExit: exit => { exits.push(exit.code); } });
  t.after(() => session.stop()); await session.start(); await wait(session, current => current.state.phase === 'paused' && current.state.frames.length > 1);
  assert.equal(session.state.frames[0].file, 'main.cpp'); assert.equal(session.state.frames[0].line, 4);
  assert.equal(session.state.variables.find(variable => variable.name === 'answer')?.value, '42');
  assert.equal(await session.evaluate('answer'), '42');
  const caller = session.state.frames.find(frame => frame.name.startsWith('main'))!;
  await session.selectFrame(caller.id); assert.equal(await session.evaluate('value'), '40');
  await session.selectFrame(session.state.frames[0].id); await session.step('next');
  await wait(session, current => current.state.phase === 'paused' && current.state.frames.length > 0);
  await session.applyBreakpoints([]); assert.deepEqual(session.state.resolved, []);
  await session.step('continue'); await wait(session, current => current.state.phase === 'stopped');
  assert.ok(output.includes('42')); assert.deepEqual(exits, [0]);
});

test('installed LLDB: Rust artifact stops on source and exposes locals before normal completion', nativeAdapter ? {} : { skip: 'Set ANTIMATTER_LLDB_DAP to a real lldb-dap/lldb-vscode binary.' }, async t => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const execute = promisify(execFile);
  const spec = fixture(t); spec.debuggerPath = nativeAdapter!;
  writeFileSync(join(spec.root, 'main.rs'), '#[inline(never)]\nfn helper(value: i32) -> i32 {\n    let answer = value + 2;\n    std::hint::black_box(answer);\n    answer\n}\nfn main() {\n    let value = 40;\n    let result = helper(value);\n    println!("{}", result);\n}\n');
  await execute(process.env.RUSTC ?? 'rustc', ['-g', '-C', 'opt-level=0', join(spec.root, 'main.rs'), '-o', spec.program]);
  spec.breakpoints = [{ file: 'main.rs', line: 4 }]; let output = '';
  const session = new NativeDebugSession(spec, { ...events, onData: data => { output += data; } }); t.after(() => session.stop());
  await session.start(); await wait(session, current => current.state.phase === 'paused' && current.state.frames.length > 0);
  assert.equal(session.state.frames[0].file, 'main.rs');
  assert.equal(session.state.frames[0].line, session.state.resolved.find(point => point.file === 'main.rs')?.line);
  assert.equal(session.state.variables.find(variable => variable.name === 'answer')?.value, '42', JSON.stringify(session.state));
  await session.step('continue'); await wait(session, current => current.state.phase === 'stopped'); assert.ok(output.includes('42'));
});
