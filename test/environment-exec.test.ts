import assert from 'node:assert/strict';
import test from 'node:test';
import { connect, current, shutdown, start, stop, suggestCommand, type RunSpec } from '../src/main/environment/exec';

const spec: RunSpec = { command: 'nyinterpreter', args: ['fresh.nil'], cwd: '/workspace', label: 'Ny' };
type PtyModule = typeof import('node-pty');
function fakeModule() {
  let launches = 0; let kills = 0;
  const child = { pid: 42, onData() {}, onExit() {}, kill() { kills++; } };
  const module = { spawn() { launches++; return child; } } as unknown as PtyModule;
  return { module, get launches() { return launches; }, get kills() { return kills; } };
}

test('Stop and workspace shutdown cancel a pending native-module launch before any process starts', async () => {
  for (const cancel of [stop, shutdown]) {
    const fake = fakeModule(); let loaded!: (module: PtyModule) => void;
    const launched = start(spec, () => new Promise((resolve) => { loaded = resolve; }));
    cancel(); loaded(fake.module);
    await assert.rejects(launched, /cancelled before/);
    assert.equal(fake.launches, 0);
  }
  shutdown();
});

test('a newer run supersedes a pending launch, then normal Stop still kills its process', async () => {
  const fake = fakeModule(); let loaded!: (module: PtyModule) => void;
  try {
    const stale = start(spec, () => new Promise((resolve) => { loaded = resolve; }));
    const fresh = await start({ ...spec, args: ['new.nil'] }, async () => fake.module);
    loaded(fake.module); await assert.rejects(stale, /cancelled before/);
    assert.equal(fake.launches, 1); assert.equal(current()?.id, fresh.id);
    assert.deepEqual(current()?.spec.args, ['new.nil']);
    stop(); assert.equal(fake.kills, 1);
  } finally { shutdown(); }
});

test('late output and exit from a retired process cannot finish or pollute a newer run', async () => {
  const children: { data(data: string): void; exit(exit: { exitCode: number }): void }[] = [];
  const received: string[] = [];
  const module = { spawn() {
    const callbacks = { data(_data: string) {}, exit(_exit: { exitCode: number }) {} };
    children.push(callbacks);
    return { pid: children.length, kill() {}, onData(fn: typeof callbacks.data) { callbacks.data = fn; }, onExit(fn: typeof callbacks.exit) { callbacks.exit = fn; } };
  } } as unknown as PtyModule;
  connect({ onData: (_id, data) => received.push(data), onExit: (_id, exit) => received.push(`exit ${exit.code}`) });
  try {
    await start(spec, async () => module);
    const fresh = await start(spec, async () => module);
    children[0].data('retired'); children[0].exit({ exitCode: 1 });
    assert.equal(current()?.id, fresh.id);
    assert.equal(current()?.exit, null);
    children[1].data('fresh'); children[1].exit({ exitCode: 0 });
    assert.deepEqual(received, ['fresh', 'exit 0']);
    assert.equal(current()?.exit?.code, 0);
  } finally { shutdown(); connect({ onData() {}, onExit() {} }); }
});

test('Ny, both Matrix extensions and NIL artifacts use the managed runner with literal paths', () => {
  for (const path of ['src/main.ny', 'src/a space.matrix', 'src/UPPER.MAT', 'build/main.nil']) {
    assert.equal(suggestCommand(path, '/workspace'), `ny run ${JSON.stringify(path)}`);
  }
});
