import assert from 'node:assert/strict';
import test from 'node:test';
import { engineEndpoint, execStartArgv, isAddressableUnit, LocalEngineLifecycle, parseUnitFacts, portInArgv } from '../src/main/localEngineLifecycle';
import { readSourceWithStartup } from '../src/main/sourceReadiness';
import { sourceReadinessBlock } from '../renderer/src/lib/sourceReadiness';
import { ProviderManager } from '../src/api/providers';

const EXEC_START = (binary: string, port: number, extra = ''): string =>
  `{ path=${binary} ; argv[]=${binary} -m /models/M.gguf --ctx-size 32768 --parallel 1${extra} --host 127.0.0.1 --port ${port} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;

const BINARY = '/vendor/llama-vulkan/runtime/llama-server';

/**
 * A fake `systemctl --user` over a small set of units, plus a fake loopback server whose health
 * follows the unit it belongs to. Nothing here shells out or touches a real socket.
 */
function world(options: { units?: Array<{ unit: string; port: number; state?: string; binary?: string }>; model?: string | null; conflicts?: Record<string, string[]> } = {}) {
  const units = (options.units ?? [{ unit: 'llama-coder.service', port: 8086 }]).map((entry) => ({
    unit: entry.unit, port: entry.port, state: entry.state ?? 'inactive', binary: entry.binary ?? BINARY,
  }));
  const state = {
    units, clock: 0, commands: [] as string[][], portFree: true,
    model: options.model === undefined ? 'qwen3-coder-30b' : options.model,
    busy: false, applying: false, servedModels: ['qwen3-coder-30b'],
    unhealthy: false, failOnStart: false, keepRunningOnStop: false,
    onSleep: null as null | ((ms: number) => Promise<void>),
    onCommand: null as null | ((args: string[]) => Promise<void>),
    onPortFree: null as null | (() => Promise<boolean>),
    busySources: new Set<string>(),
    missingFiles: new Set<string>(),
    conflicts: options.conflicts ?? {} as Record<string, string[]>,
  };
  const find = (unit: string) => state.units.find((entry) => entry.unit === unit);
  const command = async (args: string[]): Promise<string> => {
    state.commands.push([...args]);
    await state.onCommand?.(args);
    if (args[0] === 'list-unit-files') return state.units.map((entry) => `${entry.unit} disabled enabled`).join('\n') + '\n';
    if (args[0] === 'show') {
      const property = args.find((arg) => arg.startsWith('--property='))?.slice('--property='.length);
      const names = args.slice(1).filter((arg) => !arg.startsWith('--'));
      if (property === 'Conflicts') {
        return names.map((name) => `Conflicts=${(state.conflicts[name] ?? []).join(' ')}`).join('\n') + '\n';
      }
      return names.map((name) => {
        const entry = find(name);
        if (!entry) return '';
        return `Id=${entry.unit}\nLoadState=loaded\nActiveState=${entry.state}\nMainPID=${entry.state === 'active' ? 400 : 0}\nExecStart=${EXEC_START(entry.binary, entry.port)}\n`;
      }).filter(Boolean).join('\n');
    }
    if (args[0] === 'reset-failed') { const entry = find(args[1]); if (entry) entry.state = 'inactive'; return ''; }
    if (args[0] === 'start') {
      const entry = find(args[1]);
      if (entry) entry.state = state.failOnStart ? 'failed' : 'active';
      return '';
    }
    if (args[0] === 'stop') { const entry = find(args[1]); if (entry && !state.keepRunningOnStop) entry.state = 'inactive'; return ''; }
    throw new Error(`unexpected systemctl call: ${args.join(' ')}`);
  };
  const lifecycle = new LocalEngineLifecycle({
    busy: (id) => state.busy || state.busySources.has(id),
    applying: () => state.applying,
    command,
    probe: async (endpoint, path) => {
      const port = Number(new URL(endpoint).port);
      const entry = state.units.find((candidate) => candidate.port === port);
      if (!entry || entry.state !== 'active' || state.unhealthy) throw new Error('connection refused');
      if (path === '/health') return { status: 'ok' };
      return { data: state.servedModels.map((id) => ({ id })) };
    },
    portFree: async () => state.onPortFree ? state.onPortFree() : state.portFree,
    fileAvailable: (path) => !state.missingFiles.has(path),
    now: () => state.clock,
    sleep: async (ms) => { state.clock += ms; await state.onSleep?.(ms); },
    startupTimeoutMs: 10_000,
    log: () => {},
  });
  const source = { sourceId: 'local-qwen3-coder-30b', baseUrl: 'http://127.0.0.1:8086/v1', model: state.model };
  return { state, lifecycle, find, source, ensure: () => lifecycle.ensureRunning(source) };
}

const verbs = (commands: string[][]): string[] => commands.map((args) => args[0]);

test('engineEndpoint accepts loopback llama-server roots and rejects everything else', () => {
  assert.equal(engineEndpoint('http://127.0.0.1:8086/v1'), 'http://127.0.0.1:8086');
  assert.equal(engineEndpoint('http://localhost:8086/v1/'), 'http://127.0.0.1:8086');
  assert.equal(engineEndpoint('http://127.0.0.1:8086/'), 'http://127.0.0.1:8086');
  // A remote provider must never be handed to the unit lifecycle.
  assert.equal(engineEndpoint('https://api.anthropic.com/v1'), null);
  assert.equal(engineEndpoint('http://192.0.2.5:8086/v1'), null);
  assert.equal(engineEndpoint('http://127.0.0.1:8086/v1/chat/completions'), null);
  assert.equal(engineEndpoint('http://user:pass@127.0.0.1:8086/v1'), null);
  assert.equal(engineEndpoint('not a url'), null);
});

test('ExecStart is parsed for its port whether the flag is split or joined', () => {
  assert.equal(portInArgv(execStartArgv(EXEC_START(BINARY, 8086))), '8086');
  assert.equal(portInArgv([BINARY, '--port=8081']), '8081');
  assert.equal(portInArgv([BINARY, '--host', '127.0.0.1']), null);
  // A flag-shaped value in argv[0] position is not a port declaration.
  assert.equal(portInArgv(['--port', '9999'].slice(0, 1)), null);
  const facts = parseUnitFacts(`Id=llama-coder.service\nLoadState=loaded\nActiveState=inactive\nMainPID=0\nExecStart=${EXEC_START(BINARY, 8086)}\n`);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].id, 'llama-coder.service');
  assert.equal(portInArgv(facts[0].argv), '8086');
  // An unloaded unit is not a candidate for anything.
  assert.equal(parseUnitFacts('Id=x.service\nLoadState=not-found\nActiveState=inactive\n').length, 0);
});

test('template units are never handed to systemd', () => {
  // `systemctl show` fails outright on a template name, which would take the whole batched call
  // down with it. A real user session has several of these.
  assert.equal(isAddressableUnit('llama-coder.service'), true);
  assert.equal(isAddressableUnit('llama-coder@1.service'), true);
  assert.equal(isAddressableUnit('gnome-session-manager@.service'), false);
  assert.equal(isAddressableUnit('systemd-ask-password@.service'), false);
  assert.equal(isAddressableUnit('wireplumber@.service'), false);
  assert.equal(isAddressableUnit('not-a-unit'), false);
  assert.equal(isAddressableUnit(''), false);
});

test('a session full of unrelated services still resolves the right unit', async () => {
  // The enumeration is over every user service, templates included; only the llama-server units
  // on the requested port may survive it.
  const { state, lifecycle, find } = world({ units: [
    { unit: 'gnome-session-manager@.service', port: 0, binary: '/usr/libexec/gnome-session' },
    { unit: 'pipewire.service', port: 0, binary: '/usr/bin/pipewire' },
    { unit: 'llama-omni.service', port: 8081 },
    { unit: 'llama-coder.service', port: 8086 },
  ] });
  await lifecycle.ensureRunning({ sourceId: 's', baseUrl: 'http://127.0.0.1:8086/v1', model: 'qwen3-coder-30b' });
  assert.equal(find('llama-coder.service')!.state, 'active');
  assert.equal(find('llama-omni.service')!.state, 'inactive', 'only the requested port is started');
  const shown = state.commands.filter((args) => args[0] === 'show').flat();
  assert.ok(!shown.includes('gnome-session-manager@.service'), 'a template name must never be queried');
});

test('nothing is started until a request needs it, and then exactly once', async () => {
  const { state, lifecycle, find, ensure } = world();
  assert.deepEqual(state.commands, [], 'constructing the lifecycle must not touch systemd');
  await ensure();
  assert.equal(find('llama-coder.service')!.state, 'active');
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'start'), ['start']);
  // A second request against a healthy engine is a no-op, not another start.
  state.commands.length = 0;
  await ensure();
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'start'), []);
  assert.equal(lifecycle.owns('local-qwen3-coder-30b'), true);
});

test('readiness permits an idle managed engine without starting it; the first provider request starts exactly once', async (t) => {
  const f = world();
  const source = { id: f.source.sourceId, name: 'Configured local engine', baseUrl: f.source.baseUrl,
    apiKey: '', kind: 'llama-cpp' as const, supportsStreaming: true,
    models: [{ id: f.source.model!, name: 'Configured model' }] };
  for (let i = 0; i < 3; i++) {
    const readiness = await readSourceWithStartup(source, () => f.lifecycle.startability(f.source), async () => ({ state: 'unreachable' }));
    assert.equal(readiness.state, 'startable'); assert.equal(sourceReadinessBlock(readiness), undefined);
  }
  assert.ok(f.state.commands.every((args) => ['show', 'list-unit-files'].includes(args[0])));
  assert.deepEqual(f.lifecycle.states(), []);
  const manager = ProviderManager.fromConfigs([source]);
  manager.usePrepareProvider(() => f.lifecycle.ensureRunning(f.source));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requests = 0;
  globalThis.fetch = async () => {
    assert.equal(f.find('llama-coder.service')!.state, 'active', 'preflight must finish before message transmission');
    requests += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Started successfully.' } }] }), { status: 200 });
  };
  const request = { providerId: source.id, model: f.source.model!, messages: [{ id: 'first', role: 'user' as const, content: 'Hello.' }] };
  assert.equal(await manager.getProvider(source.id)!.chat(request), 'Started successfully.');
  assert.equal(requests, 1);
  assert.equal(f.state.commands.filter((args) => args[0] === 'start').length, 1);
  await f.lifecycle.stopOnQuit();
});

test('verified failed engines allow explicit retry but real startup errors reach the caller before inference', async (t) => {
  const f = world({ units: [{ unit: 'llama-coder.service', port: 8086, state: 'failed' }] });
  assert.equal((await f.lifecycle.startability(f.source)).state, 'startable');
  f.state.failOnStart = true;
  const manager = ProviderManager.fromConfigs([{ id: f.source.sourceId, name: 'Local', baseUrl: f.source.baseUrl,
    apiKey: '', supportsStreaming: true, models: [{ id: f.source.model!, name: 'Local model' }] }]);
  manager.usePrepareProvider(() => f.lifecycle.ensureRunning(f.source));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error('must not send inference after failed startup'); };
  await assert.rejects(manager.getProvider(f.source.sourceId)!.chat({ providerId: f.source.sourceId, model: f.source.model!, messages: [] }), /failed to start/);
  const retry = await f.lifecycle.startability(f.source);
  assert.equal(retry.state, 'startable'); assert.match(retry.detail!, /failed to start.*retry/s);
});

test('readiness rejects missing/ambiguous services, missing files and occupied ports but forgets a departed external owner', async () => {
  for (const units of [[], [{ unit: 'other.service', port: 8086, binary: '/bin/python' }],
    [{ unit: 'one.service', port: 8086 }, { unit: 'two.service', port: 8086 }]]) {
    const f = world({ units });
    assert.equal((await f.lifecycle.startability(f.source)).state, 'unreachable');
    assert.ok(f.state.commands.every((args) => ['show', 'list-unit-files'].includes(args[0])));
  }
  for (const missing of [BINARY, '/models/M.gguf']) {
    const f = world(); f.state.missingFiles.add(missing);
    assert.equal((await f.lifecycle.startability(f.source)).state, 'unreachable');
  }
  const occupied = world(); occupied.state.portFree = false;
  assert.match((await occupied.lifecycle.startability(occupied.source)).detail!, /Something else/);
  const external = world({ units: [{ unit: 'llama-coder.service', port: 8086, state: 'active' }] });
  await external.ensure(); external.find('llama-coder.service')!.state = 'inactive';
  assert.equal((await external.lifecycle.startability(external.source)).state, 'startable');
  assert.deepEqual(external.lifecycle.states(), [], 'a verified stopped external service no longer blocks later startup');
  assert.ok(external.state.commands.every((args) => ['show', 'list-unit-files'].includes(args[0])));
  assert.equal((await world().lifecycle.startability({ sourceId: 'remote', baseUrl: 'https://remote.example/v1' })).state, 'unreachable');
});

test('reopening after idle release permits another first request, without adopting changed source configuration', async () => {
  const f = world(); await f.ensure();
  assert.equal((await f.lifecycle.startability({ ...f.source, baseUrl: 'http://127.0.0.1:9090/v1' })).state, 'unreachable');
  await f.lifecycle.background(); f.lifecycle.foreground();
  const before = f.state.commands.filter((args) => args[0] === 'start').length;
  assert.equal((await f.lifecycle.startability(f.source)).state, 'startable');
  assert.equal(f.state.commands.filter((args) => args[0] === 'start').length, before);
  await f.ensure();
  assert.equal(f.state.commands.filter((args) => args[0] === 'start').length, before + 1);
  await f.lifecycle.stopOnQuit();
});

test('a failed unit is reset before being started again', async () => {
  const { state, find, ensure } = world({ units: [{ unit: 'llama-coder.service', port: 8086, state: 'failed' }] });
  await ensure();
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'reset-failed' || verb === 'start'),
    ['reset-failed', 'start']);
  assert.equal(find('llama-coder.service')!.state, 'active');
});

test('a server somebody else started is used but never owned', async () => {
  const { state, lifecycle, ensure } = world({ units: [{ unit: 'llama-coder.service', port: 8086, state: 'active' }] });
  await ensure();
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'start' || verb === 'stop'), []);
  const [engine] = lifecycle.states();
  assert.equal(engine.ownership, 'external');
  assert.equal(lifecycle.owns('local-qwen3-coder-30b'), false);
  // Neither backgrounding nor quitting may take away a server we did not start.
  await lifecycle.background();
  await lifecycle.stopOnQuit();
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'stop'), []);
  await assert.rejects(lifecycle.stopSource('local-qwen3-coder-30b'), /managed outside Antimatter/);
});

test('a foreign listener on the port stops the start rather than being adopted', async () => {
  const { state, ensure } = world();
  state.portFree = false;
  await assert.rejects(ensure(), /already listening on http:\/\/127\.0\.0\.1:8086/);
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'start'), []);
});

test('a source with no matching unit says so instead of starting something else', async () => {
  const { lifecycle } = world({ units: [{ unit: 'llama-omni.service', port: 8081 }] });
  await assert.rejects(
    lifecycle.ensureRunning({ sourceId: 's', baseUrl: 'http://127.0.0.1:8086/v1', model: 'm' }),
    /No llama-server user service is configured to listen on http:\/\/127\.0\.0\.1:8086/
  );
});

test('two units on one port are refused rather than guessed between', async () => {
  const { lifecycle } = world({ units: [
    { unit: 'llama-coder.service', port: 8086 },
    { unit: 'llama-coder-alt.service', port: 8086 },
  ] });
  await assert.rejects(lifecycle.ensureRunning({ sourceId: 's', baseUrl: 'http://127.0.0.1:8086/v1', model: null }),
    /More than one user service is configured/);
});

test('a unit that runs something other than llama-server is not a candidate', async () => {
  const { lifecycle } = world({ units: [{ unit: 'llama-coder.service', port: 8086, binary: '/usr/bin/python3' }] });
  await assert.rejects(lifecycle.ensureRunning({ sourceId: 's', baseUrl: 'http://127.0.0.1:8086/v1', model: null }),
    /No llama-server user service is configured/);
});

test('the wrong checkpoint on the right port is not ready', async () => {
  const { state, ensure } = world();
  state.servedModels = ['some-other-model'];
  await assert.rejects(ensure(), /did not become ready/);
});

test('a multi-model source only requires the server to be serving something', async () => {
  const { state, lifecycle } = world({ model: null });
  state.servedModels = ['anything-at-all'];
  await lifecycle.ensureRunning({ sourceId: 's', baseUrl: 'http://127.0.0.1:8086/v1', model: null });
  assert.equal(lifecycle.states()[0].ownership, 'app');
});

test('a unit that fails to start reports the journal rather than hanging', async () => {
  const { state, ensure } = world();
  state.failOnStart = true;
  await assert.rejects(ensure(), /failed to start\. Check `journalctl --user -u llama-coder\.service`/);
});

test('closing the window releases an idle engine', async () => {
  const { state, lifecycle, find, ensure } = world();
  await ensure();
  state.commands.length = 0;
  await lifecycle.background();
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'stop'), ['stop']);
  assert.equal(find('llama-coder.service')!.state, 'inactive');
  assert.deepEqual(lifecycle.states(), []);
});

test('closing the window waits for a turn in flight, then releases', async () => {
  const { state, lifecycle, find, ensure } = world();
  await ensure();
  state.busy = true;
  state.commands.length = 0;
  await lifecycle.background();
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'stop'), [], 'a running turn must not be killed');
  assert.equal(find('llama-coder.service')!.state, 'active');
  state.busy = false;
  await lifecycle.tick();
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'stop'), ['stop']);
});

test('reopening the window cancels a pending release', async () => {
  const { state, lifecycle, find, ensure } = world();
  await ensure();
  state.busy = true;
  await lifecycle.background();
  lifecycle.foreground();
  state.busy = false;
  state.commands.length = 0;
  await lifecycle.tick();
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'stop'), []);
  assert.equal(find('llama-coder.service')!.state, 'active');
});

test('quitting takes down every engine Antimatter started', async () => {
  const { state, lifecycle, find, ensure } = world();
  await ensure();
  state.busy = true;
  state.commands.length = 0;
  await lifecycle.stopOnQuit();
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'stop'), ['stop'], 'a quit is a hard boundary');
  assert.equal(find('llama-coder.service')!.state, 'inactive');
});

test('a crash is retried three times with widening gaps, then left alone', async () => {
  const { state, lifecycle, find, ensure } = world();
  await ensure();

  const die = async () => {
    find('llama-coder.service')!.state = 'failed';
    state.failOnStart = true;
    state.commands.length = 0;
    await lifecycle.tick();
  };

  const elapsed: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = state.clock;
    await die();
    elapsed.push(state.clock - before);
    assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'start'), ['start'], `attempt ${attempt + 1} should restart`);
  }
  // The gaps widen; each includes its restart delay plus the bounded readiness wait after it.
  assert.ok(elapsed[0] >= 2_000 && elapsed[1] >= 8_000 && elapsed[2] >= 30_000, `gaps did not widen: ${elapsed.join(', ')}`);

  // Budget spent: the fourth death is recorded and not retried, so an OOM-killing model cannot
  // thrash the desktop for the rest of the session.
  await die();
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'start'), []);
  const [engine] = lifecycle.states();
  assert.equal(engine.gaveUp, true);
  assert.equal(engine.failures, 4);
  assert.match(engine.lastError ?? '', /stopped 4 times/);

  // Further ticks stay quiet rather than retrying.
  state.commands.length = 0;
  await lifecycle.tick();
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'start'), []);

  // An explicit request clears the verdict and tries again.
  state.failOnStart = false;
  await ensure();
  assert.equal(lifecycle.states()[0].gaveUp, false);
});

test('a sustained healthy period clears the failure count', async () => {
  const { state, lifecycle, find, ensure } = world();
  await ensure();
  find('llama-coder.service')!.state = 'failed';
  await lifecycle.tick();
  assert.equal(lifecycle.states()[0].failures, 1);
  assert.equal(find('llama-coder.service')!.state, 'active', 'the first failure is retried');
  state.clock += 6 * 60_000;
  await lifecycle.tick();
  assert.equal(lifecycle.states()[0].failures, 0);
});

test('supervision stands down while an engine profile switch is restarting a unit', async () => {
  const { state, lifecycle, find, ensure } = world();
  await ensure();
  state.applying = true;
  find('llama-coder.service')!.state = 'inactive';
  state.commands.length = 0;
  await lifecycle.tick();
  assert.deepEqual(state.commands, [], 'a deliberate restart must not be raced');
  assert.equal(lifecycle.states()[0].failures, 0);
});

test('a crash is not restarted while the window is closed', async () => {
  const { state, lifecycle, find, ensure } = world();
  await ensure();
  await lifecycle.background();
  find('llama-coder.service')!.state = 'failed';
  state.commands.length = 0;
  await lifecycle.tick();
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'start'), []);
});

test('a remote source is not given a lifecycle at all', async () => {
  const { state, lifecycle } = world();
  await lifecycle.ensureRunning({ sourceId: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude' });
  assert.deepEqual(state.commands, []);
  assert.deepEqual(lifecycle.states(), []);
});

test('starting an engine is refused while a conflicting sibling is serving a turn', async () => {
  // The 80B and the 30B are siblings: `llama-coder-next.service` declares
  // `Conflicts=llama-coder.service`, so starting the 30B stops the 80B. That is fine when the
  // 80B is idle and fatal when it is mid-answer, so the preflight refuses instead.
  const { state, lifecycle, find } = world({ units: [
    { unit: 'llama-coder-next.service', port: 8087 },
    { unit: 'llama-coder.service', port: 8086 },
  ], conflicts: { 'llama-coder-next.service': ['llama-coder.service'] } });
  await lifecycle.ensureRunning({ sourceId: 'next', baseUrl: 'http://127.0.0.1:8087/v1', model: null });
  assert.equal(find('llama-coder-next.service')!.state, 'active');
  state.busy = true;
  state.commands.length = 0;

  await assert.rejects(
    lifecycle.ensureRunning({ sourceId: 'coder', baseUrl: 'http://127.0.0.1:8086/v1', model: null }),
    /llama-coder-next\.service is serving a request/
  );
  assert.equal(find('llama-coder.service')!.state, 'inactive', 'the conflicting unit was not started');
  assert.equal(find('llama-coder-next.service')!.state, 'active', 'the busy server was left serving');
  assert.deepEqual(verbs(state.commands).filter((verb) => verb === 'start'), []);
});

test('a sibling that declares the conflict on its own side is also seen', async () => {
  const { state, lifecycle, find } = world({ units: [
    { unit: 'llama-coder.service', port: 8086 },
    { unit: 'llama-coder-next.service', port: 8087 },
  ], conflicts: { 'llama-coder.service': ['llama-coder-next.service'] } });
  await lifecycle.ensureRunning({ sourceId: 'coder', baseUrl: 'http://127.0.0.1:8086/v1', model: null });
  state.busy = true;
  await assert.rejects(
    lifecycle.ensureRunning({ sourceId: 'next', baseUrl: 'http://127.0.0.1:8087/v1', model: null }),
    /llama-coder\.service is serving a request/
  );
  assert.equal(find('llama-coder-next.service')!.state, 'inactive');
});

test('an engine that conflicts with nothing may start beside a busy sibling', async () => {
  // Omni shares the box with the coder but not the carveout; starting it displaces nothing, so a
  // busy coder must not block a perception model from loading.
  const { state, lifecycle, find } = world({ units: [
    { unit: 'llama-coder-next.service', port: 8087 },
    { unit: 'llama-omni.service', port: 8081 },
  ], conflicts: { 'llama-coder-next.service': ['llama-coder.service'] } });
  await lifecycle.ensureRunning({ sourceId: 'next', baseUrl: 'http://127.0.0.1:8087/v1', model: null });
  state.busy = true;
  await lifecycle.ensureRunning({ sourceId: 'omni', baseUrl: 'http://127.0.0.1:8081/v1', model: null });
  assert.equal(find('llama-omni.service')!.state, 'active');
  assert.equal(find('llama-coder-next.service')!.state, 'active');
});


test('a delayed supervisor never resurrects a record after an intentional backend switch', async (t) => {
  const f = world(); t.after(() => f.lifecycle.stopOnQuit());
  await f.ensure(); f.find('llama-coder.service')!.state = 'failed';
  let reached!: () => void; const delayed = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
  f.state.onSleep = async () => { reached(); await barrier; };
  const tick = f.lifecycle.tick(); await delayed;
  await f.lifecycle.stopSource(f.source.sourceId);
  f.state.commands.length = 0; release(); await tick;
  assert.equal(f.lifecycle.states().length, 0);
  assert.equal(f.state.commands.some((args) => args[0] === 'start'), false);
});

test('systemctl success without actual retirement keeps ownership and refuses the switch', async (t) => {
  const f = world(); t.after(async () => { f.state.keepRunningOnStop = false; await f.lifecycle.stopOnQuit(); });
  await f.ensure(); f.state.keepRunningOnStop = true;
  await assert.rejects(f.lifecycle.stopSource(f.source.sourceId), /retirement could not be confirmed/);
  assert.equal(f.lifecycle.owns(f.source.sourceId), true);
  f.state.keepRunningOnStop = false; await f.lifecycle.stopSource(f.source.sourceId);
  assert.equal(f.lifecycle.owns(f.source.sourceId), false);
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('canceling cold preparation retains the provider lease until owned unit retirement is verified', async (t) => {
  const f = world({ units: [{ unit: 'llama-coder.service', port: 8086 }, { unit: 'llama-next.service', port: 8087 }] });
  t.after(() => f.lifecycle.stopOnQuit());
  const waiting = deferred(); const sleeping = deferred(); const stopping = deferred(); const retired = deferred();
  f.state.unhealthy = true;
  f.state.onSleep = async () => { waiting.resolve(); await sleeping.promise; };
  f.state.onCommand = async (args) => { if (args[0] === 'stop') { stopping.resolve(); await retired.promise; } };
  const manager = ProviderManager.fromConfigs([{ id: f.source.sourceId, name: 'Local', baseUrl: f.source.baseUrl,
    apiKey: '', supportsStreaming: true, models: [{ id: f.source.model!, name: 'Local model' }] }]);
  manager.usePrepareProvider((_id, _model, signal) => f.lifecycle.ensureRunning(f.source, signal));
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('inference must not start after cancellation'); };
  const controller = new AbortController();
  const response = manager.getProvider(f.source.sourceId)!.chat({ providerId: f.source.sourceId, model: f.source.model!, messages: [] }, controller.signal);
  let rejected = false; const rejection = assert.rejects(response, /stop cold load/).then(() => { rejected = true; });
  await waiting.promise; controller.abort(new Error('stop cold load')); await stopping.promise;
  assert.equal(manager.busy(f.source.sourceId), true); assert.equal(rejected, false);
  const next = f.lifecycle.ensureRunning({ sourceId: 'next', baseUrl: 'http://127.0.0.1:8087/v1', model: null });
  await turn();
  assert.equal(f.state.commands.some((args) => args[0] === 'start' && args[1] === 'llama-next.service'), false);
  f.state.unhealthy = false; f.state.onSleep = null; retired.resolve(); sleeping.resolve();
  await Promise.all([rejection, next]);
  assert.equal(manager.busy(f.source.sourceId), false); assert.equal(requests, 0);
  assert.equal(f.find('llama-coder.service')!.state, 'inactive');
  assert.equal(f.find('llama-next.service')!.state, 'active');
  assert.deepEqual(f.state.commands.filter((args) => ['start', 'stop'].includes(args[0])).map((args) => args.slice(0, 2)),
    [['start', 'llama-coder.service'], ['stop', 'llama-coder.service'], ['start', 'llama-next.service']]);
});

test('failed cancellation cleanup retains ownership instead of pretending the engine retired', async (t) => {
  const f = world(); t.after(async () => { f.state.keepRunningOnStop = false; await f.lifecycle.stopOnQuit(); });
  const waiting = deferred(); const sleeping = deferred();
  f.state.unhealthy = true; f.state.keepRunningOnStop = true;
  f.state.onSleep = async () => { waiting.resolve(); await sleeping.promise; };
  const controller = new AbortController();
  const response = f.lifecycle.ensureRunning(f.source, controller.signal);
  const rejection = assert.rejects(response, /retirement could not be confirmed/);
  await waiting.promise; controller.abort(new Error('stop')); await rejection; sleeping.resolve();
  assert.equal(f.lifecycle.owns(f.source.sourceId), true);
  assert.equal(f.find('llama-coder.service')!.state, 'active');
});

test('canceling an already-loading external unit never stops or adopts it', async () => {
  const f = world({ units: [{ unit: 'llama-coder.service', port: 8086, state: 'activating' }] });
  const waiting = deferred(); const sleeping = deferred();
  f.state.onSleep = async () => { waiting.resolve(); await sleeping.promise; };
  const controller = new AbortController();
  const response = f.lifecycle.ensureRunning(f.source, controller.signal);
  const rejection = assert.rejects(response, /stop external wait/);
  await waiting.promise; controller.abort(new Error('stop external wait')); await rejection; sleeping.resolve();
  assert.equal(f.lifecycle.states()[0].ownership, 'external');
  assert.deepEqual(verbs(f.state.commands).filter((verb) => ['start', 'stop'].includes(verb)), []);
});

test('inspection forgets departed external services but retains unknown occupied listeners', async () => {
  const f = world({ units: [{ unit: 'llama-coder.service', port: 8086, state: 'active' }] });
  await f.ensure(); f.find('llama-coder.service')!.state = 'inactive';
  f.state.portFree = false;
  assert.equal((await f.lifecycle.inspectStates())[0].ownership, 'external');
  await assert.rejects(f.lifecycle.ensureRunning(f.source), /did not start/);
  f.state.portFree = true;
  assert.deepEqual(await f.lifecycle.inspectStates(), []);
  assert.equal((await f.lifecycle.startability(f.source)).state, 'startable');
  assert.deepEqual(verbs(f.state.commands).filter((verb) => ['start', 'stop'].includes(verb)), []);
});

test('source aliases share an owned endpoint, protect each other while busy and retire together', async (t) => {
  const f = world(); t.after(() => f.lifecycle.stopOnQuit());
  await f.ensure();
  const alias = { ...f.source, sourceId: 'other-card', baseUrl: 'http://localhost:8086/v1/' };
  await f.lifecycle.ensureRunning(alias);
  assert.deepEqual(verbs(f.state.commands).filter((verb) => verb === 'start'), ['start']);
  assert.equal(f.lifecycle.owns(alias.sourceId), true);
  f.state.busySources.add(alias.sourceId); await f.lifecycle.background();
  assert.deepEqual(verbs(f.state.commands).filter((verb) => verb === 'stop'), []);
  f.state.busySources.clear(); await f.lifecycle.tick();
  assert.deepEqual(verbs(f.state.commands).filter((verb) => verb === 'stop'), ['stop']);
  assert.deepEqual(f.lifecycle.states(), []);
});

test('an alias asking for another checkpoint cannot pass readiness using the original model identity', async (t) => {
  const f = world(); t.after(() => f.lifecycle.stopOnQuit()); await f.ensure();
  await assert.rejects(f.lifecycle.ensureRunning({ ...f.source, sourceId: 'wrong-model-alias', model: 'different-checkpoint' }),
    /different-checkpoint did not become ready/);
  assert.deepEqual(verbs(f.state.commands).filter((verb) => verb === 'start'), ['start']);
});

test('a canceled stale-owner inspection cannot forget a record reused by a newer healthy request', async () => {
  const f = world({ units: [{ unit: 'llama-coder.service', port: 8086, state: 'active' }] });
  await f.ensure(); f.find('llama-coder.service')!.state = 'inactive';
  const readingPort = deferred(); const portAnswer = deferred();
  f.state.onPortFree = async () => { readingPort.resolve(); await portAnswer.promise; return true; };
  const controller = new AbortController();
  const request = f.lifecycle.ensureRunning(f.source, controller.signal);
  const rejection = assert.rejects(request, /cancel inspection/);
  await readingPort.promise; controller.abort(new Error('cancel inspection')); await rejection;
  f.find('llama-coder.service')!.state = 'active'; f.state.onPortFree = null;
  await f.ensure(); portAnswer.resolve(); await turn();
  assert.equal(f.lifecycle.states().length, 1);
  assert.equal(f.lifecycle.states()[0].ownership, 'external');
  assert.equal(f.lifecycle.states()[0].ready, true);
});
