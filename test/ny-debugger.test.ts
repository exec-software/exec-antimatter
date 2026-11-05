import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { DapClient, DapReader } from '../src/main/environment/dap';
import { NyDebugSession } from '../src/main/environment/nyDebug';
import { resolveNyToolchain } from '../src/main/environment/ny';
import { debuggable, type DebugState } from '../src/main/environment/debug';
import * as debuggerIntegration from '../src/main/environment/debug';

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

test('DAP framing survives bytewise UTF-8 paths and multiple messages in one read', () => {
  const first = { type: 'event', event: 'output', body: { output: 'space λ/source.ny\n' } };
  const second = { type: 'response', request_seq: 3, success: true, body: { result: '42' } };
  const reader = new DapReader();
  const messages = [];
  for (const byte of frame(first)) messages.push(...reader.push(Buffer.from([byte])));
  assert.deepEqual(messages, [first]);
  assert.deepEqual(reader.push(Buffer.concat([frame(first), frame(second)])), [first, second]);
});

test('DAP rejects ambiguous, unbounded and malformed protocol data', () => {
  for (const bytes of [
    'Content-Length: 1\r\nContent-Length: 1\r\n\r\n0',
    'Content-Length: 0\r\n\r\n',
    'Content-Length: 999999999\r\n\r\n',
    'Content-Length: 2\r\n\r\n[]',
    'Content-Length: 1\r\n\r\n{',
    'x'.repeat(8193),
  ]) assert.throws(() => new DapReader().push(Buffer.from(bytes)));
});

test('adapter exit rejects outstanding requests instead of leaving Debug stuck', async () => {
  const client = new DapClient(process.execPath, process.cwd(), {
    event() {}, error() {}, stderr() {}, exit() {},
  });
  try {
    await assert.rejects(client.request('initialize'), /exited|EPIPE|write/i);
    await assert.rejects(client.request('launch'), /no longer running/);
  } finally { client.close(); }
});

test('Ny source and mapped NIL are eligible for debugging; unsupported native files stay disabled', () => {
  assert.equal(debuggable('src/main.ny'), true);
  assert.equal(debuggable('src/main.matrix'), true);
  assert.equal(debuggable('src/MAIN.MAT'), true);
  assert.equal(debuggable('build/PROGRAM.NIL'), true);
  assert.equal(debuggable('main.js'), true);
  assert.equal(debuggable('program.exe'), false);
  assert.equal(debuggable('main.py'), false);
});

const sdk = process.env.ANTIMATTER_NY_TEST_SDK;
const integration = sdk ? {} : { skip: 'Set ANTIMATTER_NY_TEST_SDK to run the installed Ny SDK integration.' };

async function waitFor(session: NyDebugSession, predicate: (state: DebugState) => boolean): Promise<DebugState> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate(session.state)) return session.state;
    if (session.state.error) throw new Error(session.state.error);
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`Timed out waiting for Ny debug state: ${JSON.stringify(session.state)}`);
}

test('installed Ny SDK: source breakpoints, caller locals, stepping, evaluation, clear and exit', integration, async () => {
  const root = await mkdtemp(join(tmpdir(), 'antimatter-ny-source-'));
  const file = join(root, 'space λ main.ny');
  await writeFile(file, [
    'fn helper(value: i64) -> i64',
    '    let inner = value + 2',
    '    println(inner)',
    '    return inner',
    'end fn',
    'fn main() -> i32',
    '    let value: i64 = 40',
    '    let answer = helper(value)',
    '    println(answer)',
    '    return 0',
    'end fn',
    '',
  ].join('\n'));
  let output = '';
  const exits: number[] = [];
  const session = new NyDebugSession({ file, root, nySdkPath: sdk, breakpoints: [{ file: 'space λ main.ny', line: 8 }] }, {
    onState() {}, onData(data) { output += data; }, onExit(exit) { exits.push(exit.code); },
  });
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('antimatter-ny-debug-')));
  try {
    await session.start();
    const entry = await waitFor(session, (state) => state.phase === 'paused');
    assert.equal(entry.reason, 'entry');
    assert.deepEqual(entry.resolved, [{ file: 'space λ main.ny', line: 8 }]);
    await session.step('continue');
    const breakpoint = await waitFor(session, (state) => state.phase === 'paused' && state.reason === 'breakpoint');
    assert.equal(breakpoint.frames[0].line, 8);
    assert.equal(await session.evaluate('value'), '40');
    await session.step('stepIn');
    const helper = await waitFor(session, (state) => state.phase === 'paused' && state.frames[0]?.name.includes('helper'));
    assert.equal(helper.frames[0].file, 'space λ main.ny');
    assert.equal(helper.frames.length, 2);
    const callerId = helper.frames[1].id;
    await session.selectFrame(callerId);
    assert.equal(session.state.selectedFrameId, callerId);
    assert.equal(session.state.variables.find((value) => value.name === 'value')?.value, '40');
    assert.equal(await session.evaluate('value'), '40');
    await assert.rejects(session.evaluate('inner'), /undefined|not_visible|unknown/i);
    await session.selectFrame(helper.frames[0].id);
    const oldFrame = helper.frames[0].id;
    await session.step('next');
    await waitFor(session, (state) => state.phase === 'paused' && state.frames[0]?.id !== oldFrame);
    assert.equal(await session.evaluate('inner'), '42');
    await assert.rejects(session.selectFrame(oldFrame), /no longer available/);
    await session.applyBreakpoints([]);
    assert.deepEqual(session.state.resolved, []);
    await session.step('stepOut');
    await waitFor(session, (state) => state.phase === 'paused' && state.frames[0]?.name.includes('main'));
    if (session.state.frames[0].line === 8) {
      await session.step('next');
      await waitFor(session, (state) => state.phase === 'paused' && state.frames[0]?.line === 9);
    }
    assert.equal(await session.evaluate('answer'), '42');
    await session.step('continue');
    await waitFor(session, (state) => state.phase === 'stopped');
    assert.match(output, /42/);
    assert.deepEqual(exits, [0]);
  } finally {
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
  // Cleanup may finish immediately after the stopped event is published.
  await new Promise((done) => setTimeout(done, 50));
  const after = (await readdir(tmpdir())).filter((name) => name.startsWith('antimatter-ny-debug-'));
  assert.ok(after.every((name) => before.has(name)), 'debug artifacts leaked after exit');
});

test('installed Ny SDK: live output, pause, replacing running breakpoints and forced stop', integration, async () => {
  const root = await mkdtemp(join(tmpdir(), 'antimatter-ny-loop-'));
  const file = join(root, 'main.ny');
  await writeFile(file, 'fn main() -> i32\n    let mut value: i64 = 0\n    println("alive")\n    while true do\n        value = value + 1\n    end while\n    return 0\nend fn\n');
  let output = '';
  const session = new NyDebugSession({ file, root, nySdkPath: sdk, breakpoints: [] }, {
    onState() {}, onData(data) { output += data; }, onExit() {},
  });
  try {
    await session.start();
    await waitFor(session, (state) => state.phase === 'paused');
    await session.step('continue');
    await waitFor(session, (state) => state.phase === 'running' && output.includes('alive'));
    await session.pause();
    assert.equal(session.state.reason, 'pause');
    assert.ok(Number(await session.evaluate('value')) >= 0);
    await session.step('continue');
    await waitFor(session, (state) => state.phase === 'running');
    await session.applyBreakpoints([{ file: 'main.ny', line: 5 }]);
    const paused = await waitFor(session, (state) => state.phase === 'paused' && state.reason === 'breakpoint');
    assert.equal(paused.frames[0].line, 5);
    await session.applyBreakpoints([]);
    await session.step('continue');
    await session.stop();
    assert.equal(session.state.phase, 'stopped');
  } finally {
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('installed Ny SDK: invalid source and unmapped NIL fail without executing stale output', integration, async () => {
  const root = await mkdtemp(join(tmpdir(), 'antimatter-ny-invalid-'));
  const file = join(root, 'main.ny');
  const events = { onState() {}, onData() {}, onExit() {} };
  const invalid = new NyDebugSession({ file, root, nySdkPath: sdk, breakpoints: [] }, events);
  try {
    await writeFile(file, 'not valid Ny syntax\n');
    await assert.rejects(invalid.start(), /compilation failed/);
    assert.equal(invalid.state.phase, 'stopped');
    await writeFile(file, 'fn main() -> i32\n    return 0\nend fn\n');
    const program = join(root, 'ordinary.nil');
    await promisify(execFile)(resolveNyToolchain(root, { sdkPath: sdk }).compiler!, ['--no-bundle', '--quiet', '--output', program, file]);
    const unmapped = new NyDebugSession({ file: program, root, nySdkPath: sdk, breakpoints: [] }, events);
    try {
      await assert.rejects(unmapped.start(), /--debug-info/);
      assert.equal(unmapped.state.phase, 'stopped');
    } finally { await unmapped.stop(); }
  } finally {
    await invalid.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('installed Ny SDK: runtime exceptions retain their source location and error detail', integration, async () => {
  const root = await mkdtemp(join(tmpdir(), 'antimatter-ny-exception-'));
  const file = join(root, 'main.ny');
  await writeFile(file, 'fn main() -> i32\n    let zero: i32 = 0\n    return 10 / zero\nend fn\n');
  const session = new NyDebugSession({ file, root, nySdkPath: sdk, breakpoints: [] }, {
    onState() {}, onData() {}, onExit() {},
  });
  try {
    await session.start();
    await waitFor(session, (state) => state.phase === 'paused');
    await session.step('continue');
    const failure = await waitFor(session, (state) => state.phase === 'paused' && state.reason === 'exception');
    assert.equal(failure.frames[0].file, 'main.ny');
    assert.equal(failure.frames[0].line, 3);
    assert.match(failure.error ?? '', /zero|division/i);
  } finally {
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('installed Ny SDK: overlapping Debug clicks launch only the newest session', integration, async () => {
  const root = await mkdtemp(join(tmpdir(), 'antimatter-ny-double-start-'));
  const file = join(root, 'main.ny');
  await writeFile(file, 'fn main() -> i32\n    return 0\nend fn\n');
  let compiles = 0;
  debuggerIntegration.connect({ onState() {}, onData(data) { if (data.includes('Compiling with source maps')) compiles++; }, onExit() {} });
  try {
    const spec = { file, root, nySdkPath: sdk, breakpoints: [] };
    const [first, second] = await Promise.allSettled([debuggerIntegration.start(spec), debuggerIntegration.start(spec)]);
    assert.equal(first.status, 'rejected');
    if (first.status === 'rejected') assert.match(first.reason.message, /superseded/);
    assert.equal(second.status, 'fulfilled');
    assert.equal(compiles, 1);
    assert.notEqual(debuggerIntegration.state().phase, 'stopped');
    await debuggerIntegration.stop();
    assert.equal(debuggerIntegration.state().phase, 'stopped');
    const cancelled = debuggerIntegration.start(spec);
    void cancelled.catch(() => undefined);
    await Promise.resolve();
    await debuggerIntegration.stop();
    await assert.rejects(cancelled, /cancelled|stopped/);
  } finally {
    await debuggerIntegration.stop();
    await rm(root, { recursive: true, force: true });
  }
});
