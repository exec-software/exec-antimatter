import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { IPty } from 'node-pty';
import { createTerminalManager, type RunCommandOptions, type SessionInfo } from '../src/main/terminal';
import { withTerminal } from '../src/main/terminalTools';
import type { ToolRuntime, ToolActivity } from '../src/main/toolLoop';

class FakePty {
  pid = 999_900;
  writes: string[] = [];
  resizes: number[][] = [];
  killed: string[] = [];
  dataHandlers: Array<(data: string) => void> = [];
  exitHandlers: Array<(exit: { exitCode: number; signal?: number }) => void> = [];
  onData(listener: (data: string) => void) { this.dataHandlers.push(listener); return { dispose() {} }; }
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void) { this.exitHandlers.push(listener); return { dispose() {} }; }
  emit(data: string) { for (const listener of this.dataHandlers) listener(data); }
  exit(exitCode = 0, signal?: number) { for (const listener of this.exitHandlers) listener({ exitCode, signal }); }
  write(data: string) { this.writes.push(data); this.emit(`echo:${data}`); }
  resize(cols: number, rows: number) { this.resizes.push([cols, rows]); }
  kill(signal: string) { this.killed.push(signal); this.exit(-1, 9); }
}

function fixture(options: { noExitOnKill?: boolean; duringSpawn?(): void } = {}) {
  const children: FakePty[] = [];
  const launches: Array<{ shell: string; args: string[]; options: any }> = [];
  const kills: Array<{ pid: number; signal: string }> = [];
  const announced: SessionInfo[] = [];
  const chunks: Array<{ id: string; data: string; offset?: number }> = [];
  const manager = createTerminalManager({
    loadPty: async () => ({ spawn(shell, args, settings) {
      const child = new FakePty(); child.pid += children.length;
      children.push(child); launches.push({ shell, args: args as string[], options: settings });
      options.duringSpawn?.();
      return child as unknown as IPty;
    } }),
    killProcessGroup(pid, signal) {
      kills.push({ pid, signal });
      if (!options.noExitOnKill) children.find((child) => child.pid === pid)?.exit(-1, 9);
    },
  });
  manager.connect({ onData: (id, data, offset) => chunks.push({ id, data, offset }), onExit() {}, onCommand: (info) => announced.push(info) });
  return { manager, children, launches, kills, announced, chunks };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const spec = (patch: Partial<RunCommandOptions> = {}): RunCommandOptions => ({ command: 'echo hello', cwd: '/workspace/project', timeoutMs: 1_000, ...patch });

test('approved command uses its own nonlogin shell, fixed cwd and call identity; returns actual clean output', async () => {
  const f = fixture();
  const running = f.manager.runCommand(spec({ runId: 'r', threadId: 't', activityId: 'a' }));
  await flush();
  assert.equal(f.launches.length, 1);
  if (process.platform !== 'win32') assert.deepEqual([f.launches[0].shell, f.launches[0].args], ['/bin/bash', ['-c', 'echo hello']]);
  assert.equal(f.launches[0].options.cwd, '/workspace/project');
  assert.equal(f.announced[0].activityId, 'a');
  assert.equal(f.announced[0].threadId, 't');
  f.children[0].emit('\x1b[31mhello\x1b[0m\r\n');
  f.children[0].exit();
  const result = await running;
  assert.equal(result.ok, true);
  assert.match(result.text, /\[exit\] 0/);
  assert.match(result.text, /hello/);
  assert.doesNotMatch(result.text, /\x1b/);
  assert.equal(f.manager.list()[0].exit?.code, 0);
});

test('one byte of user input withholds the entire output, including earlier and echoed secret output', async () => {
  const f = fixture();
  const running = f.manager.runCommand(spec()); await flush();
  const id = f.announced[0].id;
  f.children[0].emit('before-private-output');
  f.manager.write(id, 'secret-typed-directly\r');
  f.children[0].emit('after-private-output');
  f.children[0].exit(2);
  const result = await running;
  assert.equal(result.ok, false);
  assert.match(result.text, /\[exit\] 2/);
  assert.match(result.text, /private interaction/);
  assert.doesNotMatch(result.text, /secret-typed|before-private|after-private|echo:/);
  assert.equal(f.manager.list()[0].privateInput, true);
  assert.deepEqual(f.children[0].writes, ['secret-typed-directly\r']);
});

test('empty input does not suppress ordinary output', async () => {
  const f = fixture(); const running = f.manager.runCommand(spec()); await flush();
  f.manager.write(f.announced[0].id, ''); f.children[0].emit('retained'); f.children[0].exit();
  assert.match((await running).text, /retained/);
  assert.equal(f.children[0].writes.length, 0);
});

test('snapshot offsets include trimmed history and chunk boundaries for lossless renderer attachment', async () => {
  const f = fixture(); const shell = await f.manager.create({ cwd: '/project' });
  f.children[0].emit('a'.repeat(250_000)); f.children[0].emit('🐈');
  const snapshot = f.manager.snapshot(shell.id);
  assert.equal(snapshot.data.length, 200_000);
  assert.equal(snapshot.offset, 250_002);
  assert.equal(f.chunks[1].offset, 250_002);
  assert.equal(f.manager.history(shell.id), snapshot.data);
  f.manager.shutdown();
});

test('command output and terminal history are bounded even for a single huge chunk', async () => {
  const f = fixture(); const running = f.manager.runCommand(spec()); await flush();
  f.children[0].emit('x'.repeat(500_000)); f.children[0].exit();
  const result = await running;
  assert.ok(result.text.length < 25_000);
  assert.match(result.text, /output truncated/);
  assert.equal(f.manager.history(f.announced[0].id).length, 200_000);
});

test('already cancelled and cancellation while native module loads never spawn a process', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture();
  assert.equal((await f.manager.runCommand(spec({ signal: controller.signal }))).attempted, false);
  assert.equal(f.launches.length, 0);
  const pending = new AbortController(); let release!: (module: any) => void; let spawned = false;
  const manager = createTerminalManager({ loadPty: () => new Promise((resolve) => { release = resolve; }) });
  const result = manager.runCommand(spec({ signal: pending.signal })); pending.abort();
  release({ spawn() { spawned = true; throw new Error('should not spawn'); } });
  assert.equal((await result).attempted, false);
  assert.equal(spawned, false);
});

test('cancellation in the spawn/listener gap still kills exactly the one spawned command', async () => {
  const controller = new AbortController();
  const f = fixture({ duringSpawn: () => controller.abort() });
  const result = await f.manager.runCommand(spec({ signal: controller.signal }));
  assert.equal(f.launches.length, 1);
  assert.equal(result.attempted, true);
  assert.match(result.text, /cancelled/);
  if (process.platform !== 'win32') assert.deepEqual(f.kills, [{ pid: f.children[0].pid, signal: 'SIGKILL' }]);
});

test('timeout stays bounded without renderer or native exit callback', async () => {
  const f = fixture({ noExitOnKill: true }); const start = Date.now();
  const result = await f.manager.runCommand(spec({ timeoutMs: 5 }));
  assert.ok(Date.now() - start < 1500);
  assert.equal(result.ok, false);
  assert.match(result.text, /\[timeout\]/);
  assert.match(result.text, /exit was not confirmed/);
  assert.equal(f.manager.list()[0].exit, null, 'unconfirmed termination must not make a live session prunable');
  f.children[0].exit(-1, 9);
  assert.equal(f.manager.list()[0].exit?.signal, 9, 'late real exit still reaches the session');
});

test('closing a command stops it and resolves its tool result without replay', async () => {
  const f = fixture(); const result = f.manager.runCommand(spec()); await flush();
  f.manager.kill(f.announced[0].id);
  assert.match((await result).text, /\[closed\]/);
  assert.equal(f.manager.list().length, 0);
  assert.equal(f.launches.length, 1);
});

test('closing without a confirmed native exit retains the live session and input privacy route', async () => {
  const f = fixture({ noExitOnKill: true }); const result = f.manager.runCommand(spec()); await flush();
  const id = f.announced[0].id;
  f.manager.kill(id);
  assert.equal(f.manager.list()[0].id, id);
  f.manager.write(id, 'synthetic-private-input');
  const report = await result;
  assert.match(report.text, /exit was not confirmed/);
  assert.match(report.text, /private interaction/);
  assert.doesNotMatch(report.text, /synthetic-private-input/);
  assert.equal(f.manager.list()[0].exit, null);
  f.children[0].exit(-1, 9);
  assert.equal(f.manager.list().length, 0);
});

test('renderer notification exceptions cannot strand command output, exit or execution promise', async () => {
  const f = fixture();
  f.manager.connect({ onCommand() { throw new Error('closed UI'); }, onData() { throw new Error('closed UI'); }, onExit() { throw new Error('closed UI'); } });
  const result = f.manager.runCommand(spec()); await flush();
  f.children[0].emit('finished'); f.children[0].exit();
  const report = await result;
  assert.equal(report.ok, true); assert.match(report.text, /finished/);
  assert.equal(f.manager.list()[0].exit?.code, 0);
});

test('capacity prunes exited commands, never live commands or manual shells', async () => {
  const f = fixture(); const shell = await f.manager.create({ cwd: '/manual' });
  for (let index = 0; index < 10; index++) {
    const result = f.manager.runCommand(spec()); await flush(); f.children.at(-1)!.exit(); await result;
  }
  assert.equal(f.manager.list().length, 8);
  assert.ok(f.manager.list().some((entry) => entry.id === shell.id));
  assert.equal(f.kills.length, 0);
  f.manager.shutdown();
  const busy = fixture();
  for (let index = 0; index < 8; index++) await busy.manager.create({ cwd: '/manual' });
  const result = await busy.manager.runCommand(spec());
  assert.equal(result.attempted, false); assert.equal(busy.launches.length, 8);
  assert.equal(busy.kills.length, 0); busy.manager.shutdown();
});

test('spawn failure reports no execution and no session', async () => {
  const manager = createTerminalManager({ loadPty: async () => ({ spawn() { throw new Error('no pty'); } }) });
  const result = await manager.runCommand(spec());
  assert.equal(result.attempted, false); assert.match(result.text, /no pty/); assert.equal(manager.list().length, 0);
});

function runtimeFixture() {
  const calls: unknown[][] = []; let enabled = true;
  const entries = () => ['antimatter', 'plugin.example'].map((serverId) => ({ serverId, serverName: serverId,
    tool: { name: 'run_command', description: 'original', inputSchema: { type: 'object' }, enabled } }));
  const runtime: ToolRuntime = {
    enabledTools: entries,
    prepareTool: async function (_server, _tool, args) { assert.equal(this, runtime); return { args, prepared: 'opaque' }; },
    connectionErrors: function () { assert.equal(this, runtime); return []; },
    callTool: async (...args) => { calls.push(args); return { ok: true, text: 'passthrough' }; },
  };
  return { runtime, calls, disable: () => { enabled = false; } };
}

test('terminal wrapper intercepts only bundled command, retains hooks and fixed workspace metadata', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-terminal-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'child'));
  const f = runtimeFixture(); const specs: RunCommandOptions[] = [];
  const wrapped = withTerminal(f.runtime, { workspace: root, threadId: 'thread', runCommand: async (options) => { specs.push(options); return { ok: true, text: 'once' }; } });
  assert.match(wrapped.enabledTools()[0].tool.description, /Never ask for passwords in chat/);
  assert.equal(wrapped.enabledTools()[1].tool.description, 'original');
  assert.deepEqual(await wrapped.prepareTool!('antimatter', 'run_command', { command: 'pwd' }), { args: { command: 'pwd' }, prepared: 'opaque' });
  assert.deepEqual(wrapped.connectionErrors!(), []);
  await wrapped.callTool('plugin.example', 'run_command', { command: 'pwd' });
  await wrapped.callTool('antimatter', 'launch_program', { command: 'server' });
  assert.equal(f.calls.length, 2);
  const activity = { runId: 'run', activityId: 'activity', callId: 'call' } as ToolActivity;
  await wrapped.callTool('antimatter', 'run_command', { command: 'pwd', cwd: 'child', timeout_ms: 600_000 }, { activity, timeoutMs: 100_000 });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].cwd, join(root, 'child')); assert.equal(specs[0].timeoutMs, 100_000);
  assert.equal(specs[0].threadId, 'thread'); assert.equal(specs[0].runId, 'run'); assert.equal(specs[0].activityId, 'activity');
  f.disable();
  assert.equal((await wrapped.callTool('antimatter', 'run_command', { command: 'pwd' })).attempted, false);
  assert.equal(specs.length, 1);
});

test('terminal wrapper rejects cwd escapes including symlinks and malformed commands before dispatch', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-terminal-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let count = 0; const f = runtimeFixture();
  const wrapped = withTerminal(f.runtime, { workspace: root, runCommand: async () => { count++; return { ok: true, text: '' }; } });
  for (const args of [{ command: 'pwd', cwd: '..' }, { command: '' }, { command: {} }, { command: 'pwd', cwd: 42 }]) {
    assert.equal((await wrapped.callTool('antimatter', 'run_command', args)).attempted, false);
  }
  if (process.platform !== 'win32') {
    symlinkSync(tmpdir(), join(root, 'outside'));
    assert.equal((await wrapped.callTool('antimatter', 'run_command', { command: 'pwd', cwd: 'outside' })).attempted, false);
  }
  assert.equal(count, 0);
});

test('post-dispatch failure is uncertain, never described as safe to retry', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-terminal-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const wrapped = withTerminal(runtimeFixture().runtime, { workspace: root, runCommand: async () => { throw new Error('transport lost'); } });
  const result = await wrapped.callTool('antimatter', 'run_command', { command: 'touch file' });
  assert.equal(result.attempted, true); assert.match(result.text, /may have run/); assert.doesNotMatch(result.text, /Nothing ran/);
});
