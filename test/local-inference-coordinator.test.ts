import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalInferenceCoordinator, type LocalInferenceCoordinatorDeps } from '../src/main/localInferenceCoordinator';

function harness() {
  const calls: string[] = [];
  const state = { native: { running: false, ownership: null as 'app' | 'external' | null },
    router: { running: false, ownership: null as 'app' | 'external' | null }, routerId: 'router',
    direct: [] as Array<{ running: boolean; ownership: 'app' | 'external'; sourceId: string; endpoint?: string }>,
    busy: new Set<string>(), preview: false };
  const deps: LocalInferenceCoordinatorDeps = {
    nativeSourceId: 'native', previewSourceId: 'preview', busy: (id) => state.busy.has(id),
    native: { inspect: async () => ({ ...state.native }), stop: async () => {
      calls.push('native-stop'); state.native.running = false; return { ...state.native }; } },
    router: { status: () => ({ ...state.router }), sourceId: () => state.routerId,
      stop: async () => { calls.push('router-stop'); state.router.running = false; return { ...state.router }; } },
    direct: { states: () => [...state.direct], stop: async (id) => { calls.push(`direct-stop:${id}`);
      state.direct = state.direct.filter((entry) => entry.sourceId !== id); } },
    preview: { enabled: () => state.preview, stop: async () => { calls.push('preview-stop'); } },
  };
  return { state, deps, calls, coordinator: new LocalInferenceCoordinator(deps) };
}

test('constructing and inspecting state never starts or stops anything', () => {
  const f = harness(); assert.deepEqual(f.calls, []);
  f.deps.direct.states(); f.deps.router.status(); assert.deepEqual(f.calls, []);
});

test('native first request waits for every idle direct engine and router retirement', async () => {
  const f = harness(); f.state.router = { running: true, ownership: 'app' };
  f.state.direct = [{ sourceId: 'mythos', running: true, ownership: 'app' }, { sourceId: 'omni', running: true, ownership: 'app' }];
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  const stop = f.deps.direct.stop;
  f.deps.direct.stop = async (id) => { await blocked; await stop(id); };
  const run = f.coordinator.run(async () => { await f.coordinator.retireFor({ kind: 'native' }); f.calls.push('native-start'); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, ['router-stop']);
  release(); await run;
  assert.deepEqual(f.calls, ['router-stop', 'direct-stop:mythos', 'direct-stop:omni', 'native-start']);
});

test('direct first request retires the native owner before starting llama', async () => {
  const f = harness(); f.state.native = { running: true, ownership: 'app' };
  await f.coordinator.run(async () => { await f.coordinator.retireFor({ kind: 'direct', sourceId: 'mythos' }); f.calls.push('direct-start'); });
  assert.deepEqual(f.calls, ['native-stop', 'direct-start']);
});

for (const blocker of ['busy-native', 'external-native', 'busy-direct', 'external-direct', 'busy-router', 'external-router', 'busy-preview']) {
  test(`${blocker} refuses before any sibling is stopped`, async () => {
    const f = harness(); f.state.preview = true;
    f.state.native = { running: true, ownership: blocker === 'external-native' ? 'external' : 'app' };
    f.state.router = { running: true, ownership: blocker === 'external-router' ? 'external' : 'app' };
    f.state.direct = [{ sourceId: 'other', running: true, ownership: blocker === 'external-direct' ? 'external' : 'app' }];
    if (blocker === 'busy-native') f.state.busy.add('native');
    if (blocker === 'busy-direct') f.state.busy.add('other');
    if (blocker === 'busy-router') f.state.busy.add('router');
    if (blocker === 'busy-preview') f.state.busy.add('preview');
    await assert.rejects(f.coordinator.run(() => f.coordinator.retireFor({ kind: 'direct', sourceId: 'mythos' })), /serving a request|managed outside/);
    assert.deepEqual(f.calls, []);
  });
}

test('uncertain native retirement blocks the next start and a later explicit retry still works', async () => {
  const f = harness(); f.state.native = { running: true, ownership: 'app' };
  const stop = f.deps.native.stop; f.deps.native.stop = async () => ({ ...f.state.native });
  const run = () => f.coordinator.run(async () => { await f.coordinator.retireFor({ kind: 'direct', sourceId: 'mythos' }); f.calls.push('direct-start'); });
  await assert.rejects(run(), /has not retired/); assert.deepEqual(f.calls, []);
  f.deps.native.stop = stop; await run(); assert.deepEqual(f.calls, ['native-stop', 'direct-start']);
});

test('manual transitions and request preparation share the same completion queue', async () => {
  const f = harness(); let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const manual = f.coordinator.run(async () => { f.calls.push('manual-begin'); await barrier; f.calls.push('manual-end'); });
  const prompt = f.coordinator.run(async () => { f.calls.push('prompt'); });
  await new Promise<void>((resolve) => setImmediate(resolve)); assert.deepEqual(f.calls, ['manual-begin']);
  release(); await Promise.all([manual, prompt]); assert.deepEqual(f.calls, ['manual-begin', 'manual-end', 'prompt']);
});

test('same direct engine and same router are not retired by their own request reservation', async () => {
  const f = harness(); f.state.direct = [{ sourceId: 'mythos', running: true, ownership: 'app' }]; f.state.busy.add('mythos');
  await f.coordinator.run(() => f.coordinator.retireFor({ kind: 'direct', sourceId: 'mythos' }));
  f.state.direct = []; f.state.router = { running: true, ownership: 'app' }; f.state.busy.add('router');
  await f.coordinator.run(() => f.coordinator.retireFor({ kind: 'router', sourceId: 'router' }));
  assert.deepEqual(f.calls, []);
});

test('fresh inspection retires a stale external record without blocking the next engine', async () => {
  const f = harness(); f.state.direct = [{ sourceId: 'external', running: true, ownership: 'external' }];
  let inspections = 0;
  f.deps.direct.inspect = async () => { inspections++; f.state.direct = []; return []; };
  await f.coordinator.run(async () => { await f.coordinator.retireFor({ kind: 'native' }); f.calls.push('native-start'); });
  assert.equal(inspections, 1); assert.deepEqual(f.calls, ['native-start']);
});

test('same-endpoint aliases reuse one service while a busy alias protects it from a different backend', async () => {
  const f = harness(); const endpoint = 'http://127.0.0.1:8086';
  f.state.direct = [
    { sourceId: 'original', running: true, ownership: 'app', endpoint },
    { sourceId: 'alias', running: true, ownership: 'app', endpoint },
  ];
  f.state.busy.add('alias');
  await f.coordinator.run(() => f.coordinator.retireFor({ kind: 'direct', sourceId: 'third-alias', endpoint }));
  assert.deepEqual(f.calls, [], 'same endpoint must not be unloaded to prepare its alias');
  await assert.rejects(f.coordinator.run(() => f.coordinator.retireFor({ kind: 'native' })), /serving a request/);
  assert.deepEqual(f.calls, [], 'all aliases are checked before any stop is issued');
});

test('cancellation during retirement waits for the stop then prevents a replacement start', async () => {
  const f = harness(); f.state.native = { running: true, ownership: 'app' };
  let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
  const stop = f.deps.native.stop; f.deps.native.stop = async () => { f.calls.push('retiring'); await barrier; return stop(); };
  const controller = new AbortController();
  const run = f.coordinator.run(async () => {
    await f.coordinator.retireFor({ kind: 'direct', sourceId: 'next' }, controller.signal); f.calls.push('replacement-start');
  }, controller.signal);
  let settled = false;
  const rejected = assert.rejects(run, /cancel switch/).then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve)); controller.abort(new Error('cancel switch'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false); assert.deepEqual(f.calls, ['retiring']);
  release(); await rejected; assert.deepEqual(f.calls, ['retiring', 'native-stop']);
});
