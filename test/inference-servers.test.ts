import assert from 'node:assert/strict';
import test from 'node:test';
import { assertInferenceServerAction, assertInferenceServerId } from '../src/api/inferenceServers';
import { InferenceServers, type InferenceServerDeps, type RouterSelection } from '../src/main/inferenceServers';
import type { LocalEngineState } from '../src/main/localEngineLifecycle';

const ENGINE: LocalEngineState = {
  sourceId: 'local-qwen3-coder-30b',
  unit: 'llama-coder.service',
  endpoint: 'http://127.0.0.1:8086',
  model: 'qwen3-coder-30b',
  ownership: 'app',
  running: true,
  ready: true,
  startedAt: 1000,
  failures: 0,
  gaveUp: false,
  lastError: null,
  logs: ['starting', 'ready'],
};

const SELECTION: RouterSelection = {
  sourceId: 'workload-deepseek-v4-flash-0731-q2',
  modelId: 'deepseek-v4-flash-0731-q2',
  modelPath: '/cache/deepseek.gguf',
  preset: 'version = 1\n\n[deepseek]\n',
};

interface Harness {
  servers: InferenceServers;
  calls: string[];
  state: {
    beholddRunning: boolean;
    routerRunning: boolean;
    routerSource: string | null;
    busy: Set<string>;
    packaged: boolean;
    selections: Record<string, RouterSelection | undefined>;
    selectionThrows: boolean;
    beholddOwnership: 'app' | 'external' | null;
    engines: LocalEngineState[];
  };
}

function harness(overrides: Partial<Harness['state']> = {}): Harness {
  const calls: string[] = [];
  const state: Harness['state'] = {
    beholddRunning: false,
    routerRunning: true,
    routerSource: 'workload-deepseek-v4-flash-0731-q2',
    busy: new Set<string>(),
    packaged: true,
    selections: { 'workload-deepseek-v4-flash-0731-q2': SELECTION },
    selectionThrows: false,
    beholddOwnership: null,
    engines: [],
    ...overrides,
  };
  const deps: InferenceServerDeps = {
    beholdd: {
      inspectStatus: async () => ({
        running: state.beholddRunning, ready: state.beholddRunning,
        ownership: state.beholddOwnership ?? (state.beholddRunning ? 'app' : null),
        pid: state.beholddRunning ? 4242 : null, startedAt: state.beholddRunning ? 1000 : null,
        host: '127.0.0.1', port: 6768, configPath: '/home/u/.beholdd/config.yaml',
        lastExit: null, logs: ['beholdd log'],
      }),
      start: async () => { calls.push('beholdd.start'); state.beholddRunning = true; },
      stop: async () => { calls.push('beholdd.stop'); state.beholddRunning = false; },
      restart: async () => { calls.push('beholdd.restart'); state.beholddRunning = true; },
    },
    router: {
      status: () => ({
        running: state.routerRunning, ready: state.routerRunning, ownership: state.routerRunning ? 'app' : null,
        pid: state.routerRunning ? 5151 : null, startedAt: state.routerRunning ? 2000 : null,
        host: '127.0.0.1', port: 6769, modelPath: state.routerRunning ? '/cache/deepseek.gguf' : null,
        lastExit: state.routerRunning ? null : { code: null, signal: 'SIGKILL', at: 3000 },
        logs: ['router log'],
      }),
      start: async (selection) => {
        calls.push(`router.start:${selection ? selection.sourceId : 'packaged'}`);
        state.routerRunning = true;
      },
      stop: async () => { calls.push('router.stop'); state.routerRunning = false; },
      managedSourceId: () => state.routerSource,
      compatibilitySourceId: 'bundled-llama-vulkan',
      selectionFor: (sourceId) => {
        if (state.selectionThrows) throw new Error('workload is not set up');
        return state.selections[sourceId];
      },
      hasPackagedModel: () => state.packaged,
    },
    beholddSourceId: 'bundled-beholdd',
    localEngines: {
      states: () => state.engines,
      stopSource: async (sourceId) => { calls.push(`engine.stop:${sourceId}`); state.engines = state.engines.filter((engine) => engine.sourceId !== sourceId); },
    },
    busy: (sourceId) => state.busy.has(sourceId),
    sourceName: (sourceId) => (sourceId === 'bundled-beholdd' ? 'Bundled CPU' : 'DeepSeek V4 Flash 0731'),
  };
  return { servers: new InferenceServers(deps), calls, state };
}

test('ids and force options reject anything the renderer did not come by honestly', () => {
  assert.equal(assertInferenceServerId('bundled-beholdd'), 'bundled-beholdd');
  assert.equal(assertInferenceServerId('bundled-llama-vulkan'), 'bundled-llama-vulkan');
  for (const bad of ['', 'beholdd', 'workload-deepseek', 42, null, undefined, {}, ['bundled-beholdd']]) {
    assert.throws(() => assertInferenceServerId(bad), /inference servers/);
  }
  // Force is never the default, and no other option is accepted.
  assert.deepEqual(assertInferenceServerAction(undefined), { force: false });
  assert.deepEqual(assertInferenceServerAction(null), { force: false });
  assert.deepEqual(assertInferenceServerAction({}), { force: false });
  assert.deepEqual(assertInferenceServerAction({ force: true }), { force: true });
  assert.deepEqual(assertInferenceServerAction({ force: false }), { force: false });
  for (const bad of [{ force: 'yes' }, { force: 1 }, { kill: true }, [], 'force']) {
    assert.throws(() => assertInferenceServerAction(bad));
  }
});

test('both servers report their state, endpoint, and the source each is serving', async () => {
  const { servers } = harness({ beholddRunning: true });
  const list = await servers.list();
  assert.deepEqual(list.map((server) => server.id), ['bundled-beholdd', 'bundled-llama-vulkan']);

  const [cpu, router] = list;
  assert.equal(cpu.endpoint, 'http://127.0.0.1:6768');
  assert.equal(cpu.detail, '/home/u/.beholdd/config.yaml');
  assert.equal(cpu.sourceName, 'Bundled CPU');
  assert.equal(cpu.ready, true);

  assert.equal(router.endpoint, 'http://127.0.0.1:6769');
  assert.equal(router.detail, '/cache/deepseek.gguf');
  // The router names the workload it is bound to, which is the whole point of the panel.
  assert.equal(router.sourceId, 'workload-deepseek-v4-flash-0731-q2');
  assert.equal(router.sourceName, 'DeepSeek V4 Flash 0731');
  assert.equal(router.busy, false);
});

test('a crashed router restarts bound to the same workload, not the packaged checkpoint', async () => {
  const { servers, calls, state } = harness();
  await servers.restart('bundled-llama-vulkan');
  assert.deepEqual(calls, ['router.stop', 'router.start:workload-deepseek-v4-flash-0731-q2']);
  assert.equal(state.routerRunning, true);
});

test('the compatibility source restarts on the packaged checkpoint', async () => {
  const { servers, calls } = harness({ routerSource: 'bundled-llama-vulkan' });
  await servers.restart('bundled-llama-vulkan');
  assert.deepEqual(calls, ['router.stop', 'router.start:packaged']);
});

test('a workload that is no longer set up is named rather than silently downgraded', async () => {
  const { servers, calls } = harness({ selections: {} });
  await assert.rejects(() => servers.restart('bundled-llama-vulkan'), /no longer set up/);
  // Nothing was stopped, so a recoverable router is not taken down by a failed restart.
  assert.deepEqual(calls, []);

  const thrown = harness({ selectionThrows: true });
  await assert.rejects(() => thrown.servers.restart('bundled-llama-vulkan'), /no longer set up/);
  assert.deepEqual(thrown.calls, []);
  // A throwing resolver must still let the list render.
  const list = await thrown.servers.list();
  assert.equal(list[1].startable, true, 'the packaged checkpoint remains a valid start');
});

test('an in-flight turn blocks stop and restart until the person forces it', async () => {
  const { servers, calls } = harness({ busy: new Set(['workload-deepseek-v4-flash-0731-q2']) });
  const list = await servers.list();
  assert.equal(list[1].busy, true);

  await assert.rejects(() => servers.stop('bundled-llama-vulkan'), /serving a request/);
  await assert.rejects(() => servers.restart('bundled-llama-vulkan'), /serving a request/);
  assert.deepEqual(calls, [], 'a refused action touches no process');

  // The explicit override is the only way through, and it says what it costs.
  await servers.stop('bundled-llama-vulkan', true);
  assert.deepEqual(calls, ['router.stop']);
});

test('a server managed outside Antimatter is never stopped from here', async () => {
  const { servers, calls } = harness({ beholddRunning: true, beholddOwnership: 'external' });
  await assert.rejects(() => servers.stop('bundled-beholdd'), /managed outside Antimatter/);
  await assert.rejects(() => servers.restart('bundled-beholdd'), /managed outside Antimatter/);
  // Not even force may terminate a listener this app did not spawn.
  await assert.rejects(() => servers.stop('bundled-beholdd', true), /managed outside Antimatter/);
  assert.deepEqual(calls, []);
});

test('a stopped router with nothing to load does not offer a start it cannot honour', async () => {
  const stuck = harness({ routerRunning: false, routerSource: null, packaged: false });
  const list = await stuck.servers.list();
  assert.equal(list[1].running, false);
  assert.equal(list[1].startable, false);
  assert.deepEqual(list[1].lastExit, { code: null, signal: 'SIGKILL', at: 3000 });

  // With a configured workload it is startable again even though nothing is packaged.
  const ready = harness({ routerRunning: false, packaged: false });
  assert.equal((await ready.servers.list())[1].startable, true);
});

test('the native engine keeps its own lifecycle and reports the result', async () => {
  const { servers, calls, state } = harness();
  const started = await servers.start('bundled-beholdd');
  assert.deepEqual(calls, ['beholdd.start']);
  assert.equal(started[0].running, true);

  await servers.restart('bundled-beholdd');
  assert.deepEqual(calls, ['beholdd.start', 'beholdd.restart']);

  const stopped = await servers.stop('bundled-beholdd');
  assert.equal(stopped[0].running, false);
  assert.equal(state.beholddRunning, false);
  // Stopping one server never touches the other.
  assert.equal(stopped[1].running, true);
});

test('one unreadable engine never hides the other engine\u2019s controls', async () => {
  const calls: string[] = [];
  const servers = new InferenceServers({
    beholdd: {
      inspectStatus: async () => { throw new Error('beholdd socket refused the probe'); },
      start: async () => { calls.push('beholdd.start'); },
      stop: async () => { calls.push('beholdd.stop'); },
      restart: async () => { calls.push('beholdd.restart'); },
    },
    router: {
      status: () => ({
        running: true, ready: true, ownership: 'app', pid: 5151, startedAt: 2000,
        host: '127.0.0.1', port: 6769, modelPath: '/cache/deepseek.gguf', lastExit: null, logs: [],
      }),
      start: async () => { calls.push('router.start'); },
      stop: async () => { calls.push('router.stop'); },
      managedSourceId: () => 'bundled-llama-vulkan',
      compatibilitySourceId: 'bundled-llama-vulkan',
      selectionFor: () => undefined,
      hasPackagedModel: () => true,
    },
    beholddSourceId: 'bundled-beholdd',
    localEngines: { states: () => [], stopSource: async () => {} },
    busy: () => false,
    sourceName: () => 'Compatibility',
  });

  const [cpu, router] = await servers.list();
  // The broken engine is reported as unknown, never as a confident "stopped".
  assert.equal(cpu.statusError, 'beholdd socket refused the probe');
  assert.equal(cpu.running, false);
  assert.equal(cpu.startable, false);
  // The router is unaffected and still actionable, which is the point.
  assert.equal(router.statusError, null);
  assert.equal(router.ready, true);
  await servers.restart('bundled-llama-vulkan');
  assert.deepEqual(calls, ['router.stop', 'router.start']);

  // An engine whose state is unknown is not acted on, not even with force.
  await assert.rejects(() => servers.stop('bundled-beholdd'), /status could not be read/);
  await assert.rejects(() => servers.stop('bundled-beholdd', true), /status could not be read/);
  assert.deepEqual(calls, ['router.stop', 'router.start']);
});

test('a unit-backed engine is a row of its own, stopped but never started from here', async () => {
  const { servers, calls, state } = harness({ engines: [{ ...ENGINE }] });
  const listed = await servers.list();
  assert.equal(listed.length, 3, 'the two bundled servers plus the engine');
  const engine = listed[2];
  assert.equal(engine.id, 'engine:local-qwen3-coder-30b');
  assert.equal(engine.ownership, 'app');
  assert.equal(engine.ready, true);
  assert.equal(engine.endpoint, 'http://127.0.0.1:8086');
  assert.equal(engine.detail, 'llama-coder.service');
  // Starting belongs to the request that needs the model, so the panel does not offer it.
  assert.equal(engine.startable, false);
  await assert.rejects(servers.start('engine:local-qwen3-coder-30b'), /starts itself on the next request/);
  assert.deepEqual(calls, []);

  await servers.stop('engine:local-qwen3-coder-30b');
  assert.deepEqual(calls, ['engine.stop:local-qwen3-coder-30b']);
  assert.equal((await servers.list()).length, 2);
  assert.equal(state.engines.length, 0);
});

test('an engine serving a turn is not stopped without an explicit override', async () => {
  const { servers, calls } = harness({ engines: [{ ...ENGINE }], busy: new Set(['local-qwen3-coder-30b']) });
  await assert.rejects(servers.stop('engine:local-qwen3-coder-30b'), /serving a request right now/);
  assert.deepEqual(calls, []);
  await servers.stop('engine:local-qwen3-coder-30b', true);
  assert.deepEqual(calls, ['engine.stop:local-qwen3-coder-30b']);
});

test('an engine Antimatter did not start cannot be stopped from the panel', async () => {
  const { servers, calls } = harness({ engines: [{ ...ENGINE, ownership: 'external' }] });
  await assert.rejects(servers.stop('engine:local-qwen3-coder-30b'), /managed outside Antimatter/);
  assert.deepEqual(calls, []);
});

test('an engine that spent its restart budget keeps its row and carries the reason', async () => {
  const { servers } = harness({ engines: [{ ...ENGINE, running: false, ready: false, gaveUp: true,
    failures: 4, lastError: 'llama-coder.service stopped 4 times and was not restarted again.' }] });
  const engine = (await servers.list())[2];
  assert.equal(engine.running, false);
  assert.equal(engine.ready, false);
  assert.match(engine.detail ?? '', /stopped 4 times and was not restarted again/);
});

test('an engine id the renderer invented resolves to nothing', async () => {
  const { servers, calls } = harness({ engines: [{ ...ENGINE }] });
  await assert.rejects(servers.stop('engine:not-a-source'), /not available/);
  // Shape-valid but unregistered, so it never reaches a stop.
  assert.deepEqual(calls, []);
});
