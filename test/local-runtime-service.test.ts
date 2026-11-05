import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { isLocalRuntimeBinding, LocalRuntimeServiceManager, runtimeProfileArgv, runtimeProfileOverride,
  type LocalRuntimeBinding, type LocalRuntimeSettings } from '../src/main/localRuntimeService';

function world(t: { after(fn: () => unknown): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'systemd');
  const unit = 'llama-deepseek.service';
  const file = join(directory, unit);
  const foreign = join(directory, `${unit}.d`, '10-memory.conf');
  const owned = join(directory, `${unit}.d`, 'zz-antimatter-runtime-profile.conf');
  mkdirSync(dirname(foreign), { recursive: true });
  writeFileSync(file, '[Service]\n# Original unit remains unchanged.\n');
  writeFileSync(foreign, '[Service]\nMemoryMax=10G\nRestart=no\n');
  const executable = join(root, 'space in path', 'llama-server');
  mkdirSync(dirname(executable));
  writeFileSync(executable, 'test executable identity');
  const stats = statSync(executable);
  const executableId = { path: realpathSync(executable), dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
  const baselineArgv = [executable, '-m', '/models/DeepSeek.gguf', '--ctx-size', '131072', '--parallel', '1',
    '--host', '127.0.0.1', '--port', '8080', '--alias', 'DeepSeek', '--chat-template', 'literal "quoted" \\ path %n $HOME;$(bad)'];
  const state = { pid: 400, argv: [...baselineArgv], settings: { contextTokens: 131072, parallel: 1 },
    loaded: null as string | null, busy: false, externalBusy: false, slotsAvailable: true, wrongNext: false,
    reloadBusy: false, reloadOccupied: false, portFree: true, failNext: false,
    restartCount: 0, commands: [] as string[][], clock: 0, state: 'active', processUid: process.getuid!() };
  const contents = () => existsSync(owned) ? readFileSync(owned, 'utf8') : null;
  const parseOverride = (text: string): string[] => {
    const line = text.split('\n').find((value) => value.startsWith('ExecStart=:'))!;
    // Decode the quoting vocabulary emitted by the controller. '%' is a systemd specifier,
    // while ':' ensures '$' stays literal rather than becoming environment substitutions.
    return [...line.slice('ExecStart=:'.length).matchAll(/"(?:\\.|[^"\\])*"/g)]
      .map((match) => JSON.parse(match[0]).replace(/%%/g, '%'));
  };
  const properties = () => `Id=${unit}\nLoadState=loaded\nActiveState=${state.state}\nSubState=running\nMainPID=${state.pid}\nFragmentPath=${file}\nDropInPaths=${foreign}${state.loaded === null ? '' : ` ${owned}`}\nNeedDaemonReload=${state.loaded === contents() ? 'no' : 'yes'}\n`;
  const command = async (args: string[]): Promise<string> => {
    state.commands.push([...args]);
    if (args[0] === 'list-units') return `${unit} loaded active running llama server\nother.service loaded active running unrelated\n`;
    if (args[0] === 'show') return properties();
    if (args[0] === 'daemon-reload') {
      state.loaded = contents();
      if (state.reloadBusy) { state.busy = true; state.reloadBusy = false; }
      if (state.reloadOccupied) { state.portFree = false; state.reloadOccupied = false; }
      return '';
    }
    assert.deepEqual(args, ['restart', unit]);
    state.restartCount += 1;
    if (state.failNext) { state.failNext = false; state.pid = 0; state.state = 'failed'; return ''; }
    state.pid = Math.max(state.pid, 400) + 1;
    state.state = 'active';
    state.argv = state.loaded === null ? [...baselineArgv] : parseOverride(state.loaded);
    const total = Number(state.argv[state.argv.indexOf('--ctx-size') + 1]);
    const parallel = Number(state.argv[state.argv.indexOf('--parallel') + 1]);
    state.settings = { contextTokens: total / parallel, parallel };
    if (state.wrongNext) { state.settings = { ...state.settings, contextTokens: 512 }; state.wrongNext = false; }
    return '';
  };
  const manager = new LocalRuntimeServiceManager({ systemdDirectory: directory, busy: () => state.busy,
    command, process: (pid) => {
      assert.equal(pid, state.pid);
      return { uid: state.processUid, argv: [...state.argv], executable: { ...executableId } };
    },
    probe: async (endpoint, path) => {
      assert.equal(endpoint, 'http://127.0.0.1:8080');
      if (path === '/health') return { status: 'ok' };
      if (path === '/props') return { model_alias: 'DeepSeek', total_slots: state.settings.parallel,
        default_generation_settings: { n_ctx: state.settings.contextTokens } };
      if (path === '/v1/models') return { data: [{ id: 'DeepSeek' }] };
      if (!state.slotsAvailable) throw new Error('Slots unavailable');
      return Array.from({ length: state.settings.parallel }, () => ({ is_processing: state.externalBusy }));
    }, portFree: async () => state.portFree,
    startupTimeoutMs: 1000, now: () => state.clock, sleep: async (ms) => { state.clock += ms; },
  });
  return { root, manager, state, file, foreign, owned, executable, baselineArgv,
    discover: () => manager.discover({ sourceId: 'source', baseUrl: 'http://127.0.0.1:8080/v1', model: 'DeepSeek' }) as Promise<LocalRuntimeBinding> };
}

test('discovery captures the live MainPID argv and never mutates the existing service', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  assert.ok(isLocalRuntimeBinding(binding));
  assert.equal(binding.unit, 'llama-deepseek.service');
  assert.deepEqual(binding.baselineArgv, f.baselineArgv);
  assert.deepEqual(binding.baseline, { contextTokens: 131072, parallel: 1 });
  assert.equal(f.state.restartCount, 0);
  assert.equal(existsSync(f.owned), false);
  assert.ok(f.state.commands.every((args) => ['show', 'list-units'].includes(args[0])));
});

test('only direct loopback endpoints and the exact configured served model can bind', async (t) => {
  const f = world(t);
  for (const baseUrl of ['https://example.com/v1', 'http://127.0.0.1:8080/private', 'http://user:secret@127.0.0.1:8080/v1']) {
    await assert.rejects(f.manager.discover({ sourceId: 's', baseUrl, model: 'DeepSeek' }), /loopback/);
  }
  await assert.rejects(f.manager.discover({ sourceId: 's', baseUrl: 'http://127.0.0.1:8080', model: 'Wrong model' }), /registered model/);
  assert.equal(await f.manager.discover({ sourceId: 's', baseUrl: 'http://127.0.0.1:8081', model: 'DeepSeek' }), null);
  f.state.processUid += 1;
  assert.equal(await f.discover(), null);
});

test('apply changes total context and slots while round-tripping all other arguments, then restore removes only its drop-in', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  const unit = readFileSync(f.file, 'utf8');
  const foreign = readFileSync(f.foreign, 'utf8');
  const applying = f.manager.apply(binding, { contextTokens: 32768, parallel: 2 });
  assert.equal(f.manager.isApplying, true);
  assert.deepEqual(await applying, { contextTokens: 32768, parallel: 2 });
  assert.equal(f.manager.isApplying, false);
  assert.deepEqual(f.state.argv, runtimeProfileArgv(binding.baselineArgv, { contextTokens: 32768, parallel: 2 }));
  assert.equal(f.state.argv.at(-1), f.baselineArgv.at(-1));
  assert.match(readFileSync(f.owned, 'utf8'), /ExecStart=:/);
  assert.match(readFileSync(f.owned, 'utf8'), /%%n \$HOME/);
  assert.equal(statSync(f.owned).mode & 0o777, 0o600);
  assert.deepEqual(await f.manager.inspect(binding), { contextTokens: 32768, parallel: 2 });
  assert.deepEqual(await f.manager.restore(binding), binding.baseline);
  assert.deepEqual(f.state.argv, f.baselineArgv);
  assert.equal(existsSync(f.owned), false);
  assert.equal(readFileSync(f.file, 'utf8'), unit);
  assert.equal(readFileSync(f.foreign, 'utf8'), foreign);
});

test('short and equals flags preserve their original spellings and context is total across slots', () => {
  const argv = ['/bin/llama-server', '-c=8192', '-np', '1', '--other', 'literal'];
  assert.deepEqual(runtimeProfileArgv(argv, { contextTokens: 16384, parallel: 3 }),
    ['/bin/llama-server', '-c=49152', '-np', '3', '--other', 'literal']);
  assert.deepEqual(argv, ['/bin/llama-server', '-c=8192', '-np', '1', '--other', 'literal']);
});

test('busy application work, external processing slots and unverifiable slots prevent every mutation', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  f.state.busy = true;
  await assert.rejects(f.manager.apply(binding, { contextTokens: 32768, parallel: 2 }), /active model work/);
  f.state.busy = false; f.state.externalBusy = true;
  await assert.rejects(f.manager.apply(binding, { contextTokens: 32768, parallel: 2 }), /active work/);
  f.state.externalBusy = false; f.state.slotsAvailable = false;
  await assert.rejects(f.manager.apply(binding, { contextTokens: 32768, parallel: 2 }), /Slots unavailable/);
  assert.equal(existsSync(f.owned), false);
  assert.equal(f.state.restartCount, 0);
});

test('foreign unit edits or unexpected owned overrides cannot be overwritten', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  writeFileSync(f.foreign, '[Service]\nMemoryMax=20G\n');
  await assert.rejects(f.manager.apply(binding, { contextTokens: 32768, parallel: 2 }), /changed outside/);
  assert.equal(existsSync(f.owned), false);
  const g = world(t);
  const original = await g.discover();
  writeFileSync(g.owned, '# Added by someone else\n');
  g.state.loaded = readFileSync(g.owned, 'utf8');
  await assert.rejects(g.manager.apply(original, { contextTokens: 32768, parallel: 2 }), /changed outside/);
  assert.equal(readFileSync(g.owned, 'utf8'), '# Added by someone else\n');
  assert.equal(g.state.restartCount, 0);
});

test('incorrect ready-server context triggers a verified rollback to the prior profile', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  await f.manager.apply(binding, { contextTokens: 32768, parallel: 2 });
  const previous = readFileSync(f.owned, 'utf8');
  f.state.wrongNext = true;
  await assert.rejects(f.manager.apply(binding, { contextTokens: 8192, parallel: 4 }), /previous engine settings were restored/);
  assert.equal(readFileSync(f.owned, 'utf8'), previous);
  assert.deepEqual(f.state.settings, { contextTokens: 32768, parallel: 2 });
  assert.equal(f.state.restartCount, 3);
});

test('work beginning after daemon-reload restores pending configuration without restarting that work', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  f.state.reloadBusy = true;
  await assert.rejects(f.manager.apply(binding, { contextTokens: 32768, parallel: 2 }), /previous engine settings were restored/);
  assert.equal(existsSync(f.owned), false);
  assert.deepEqual(f.state.argv, f.baselineArgv);
  assert.equal(f.state.restartCount, 0);
});

test('queued switches serialize and a failed switch does not poison later restores', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  const jobs = [f.manager.apply(binding, { contextTokens: 32768, parallel: 2 }),
    f.manager.apply(binding, { contextTokens: 8192, parallel: 4 }), f.manager.restore(binding)];
  assert.equal(f.manager.isApplying, true);
  assert.deepEqual(await Promise.all(jobs), [{ contextTokens: 32768, parallel: 2 }, { contextTokens: 8192, parallel: 4 }, binding.baseline]);
  assert.equal(f.manager.isApplying, false);
  assert.deepEqual(f.state.argv, f.baselineArgv);
  assert.equal(f.state.restartCount, 3);
});

test('invalid service identity and oversized engine settings fail before invoking systemctl', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  const count = f.state.commands.length;
  await assert.rejects(f.manager.restore({ ...binding, unit: '../wrong.service' }), /invalid/);
  assert.throws(() => f.manager.apply(binding, { contextTokens: 1048576, parallel: 16 }), /Engine settings/);
  assert.equal(f.state.commands.length, count);
  assert.equal(isLocalRuntimeBinding({ ...binding, baselineArgv: ['/bin/bash', '-c', 'rm -rf /'] }), true,
    'Shape validation alone confers no execution authority; runtime inspect compares the exact live process.');
  await assert.rejects(f.manager.apply({ ...binding, baselineArgv: ['/bin/bash', '-c', 'bad'] }, { contextTokens: 32768, parallel: 2 }), /running command/);
  assert.equal(f.state.restartCount, 0);
});

test('explicit Straight shot recovery starts a failed profile from the exact saved baseline', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  const foreign = readFileSync(f.foreign, 'utf8');
  await f.manager.apply(binding, { contextTokens: 32768, parallel: 2 });
  assert.match(readFileSync(f.owned, 'utf8'), /# Settings: \{"contextTokens":32768,"parallel":2\}/);
  f.state.state = 'failed'; f.state.pid = 0;
  await assert.rejects(f.manager.inspect(binding), /not running/);
  assert.equal(f.state.restartCount, 1, 'state inspection must not start the failed engine');
  await assert.rejects(f.manager.apply(binding, { contextTokens: 8192, parallel: 4 }), /not running/);
  assert.deepEqual(await f.manager.restore(binding), binding.baseline);
  assert.equal(f.state.restartCount, 2);
  assert.equal(existsSync(f.owned), false);
  assert.deepEqual(f.state.argv, binding.baselineArgv);
  assert.equal(readFileSync(f.foreign, 'utf8'), foreign);
});

test('an explicitly restored stopped baseline starts without inventing an override', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  f.state.state = 'inactive'; f.state.pid = 0;
  assert.deepEqual(await f.manager.restore(binding), binding.baseline);
  assert.equal(existsSync(f.owned), false);
  assert.equal(f.state.restartCount, 1);
});

test('failed-engine recovery refuses edited override commands, changed binaries and foreign unit files', async (t) => {
  for (const tamper of ['override', 'binary', 'foreign'] as const) {
    const f = world(t);
    const binding = await f.discover();
    await f.manager.apply(binding, { contextTokens: 32768, parallel: 2 });
    f.state.state = 'failed'; f.state.pid = 0;
    if (tamper === 'override') {
      writeFileSync(f.owned, readFileSync(f.owned, 'utf8').replace('--port', '--foreign-port'));
      f.state.loaded = readFileSync(f.owned, 'utf8');
    } else if (tamper === 'binary') writeFileSync(f.executable, 'replaced binary');
    else writeFileSync(f.foreign, '[Service]\nExecStart=/bin/other\n');
    const previous = readFileSync(f.owned, 'utf8');
    await assert.rejects(f.manager.restore(binding), /changed|left untouched/);
    assert.equal(readFileSync(f.owned, 'utf8'), previous);
    assert.equal(f.state.restartCount, 1);
  }
});

test('failed-engine recovery refuses an occupied port or active application work', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  await f.manager.apply(binding, { contextTokens: 32768, parallel: 2 });
  f.state.state = 'failed'; f.state.pid = 0;
  const previous = readFileSync(f.owned, 'utf8');
  f.state.portFree = false;
  await assert.rejects(f.manager.restore(binding), /Another process is listening/);
  f.state.portFree = true; f.state.busy = true;
  await assert.rejects(f.manager.restore(binding), /active model work/);
  assert.equal(readFileSync(f.owned, 'utf8'), previous);
  assert.equal(f.state.restartCount, 1);
});

test('a listener appearing during failed-engine recovery leaves the prior configuration untouched', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  await f.manager.apply(binding, { contextTokens: 32768, parallel: 2 });
  f.state.state = 'failed'; f.state.pid = 0;
  const previous = readFileSync(f.owned, 'utf8');
  f.state.reloadOccupied = true;
  await assert.rejects(f.manager.restore(binding), /started using the engine port/);
  assert.equal(readFileSync(f.owned, 'utf8'), previous);
  assert.equal(f.state.restartCount, 1);
});

test('failed baseline startup retains the restored original configuration and permits an explicit retry', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  await f.manager.apply(binding, { contextTokens: 32768, parallel: 2 });
  f.state.state = 'failed'; f.state.pid = 0; f.state.failNext = true;
  await assert.rejects(f.manager.restore(binding), /original service settings were restored/);
  assert.equal(existsSync(f.owned), false);
  assert.equal(f.state.restartCount, 2);
  assert.deepEqual(await f.manager.restore(binding), binding.baseline);
  assert.equal(f.state.restartCount, 3);
});

// Quantization switching. `modelPath` is the second axis a profile can move: same model entry,
// different weights file. These fix the compatibility guarantee that made it safe to add -- the
// rendered override for a profile WITHOUT a model path has to stay byte-identical, because
// verifyOwnedOverride compares the whole file and every saved profile predates this field.

test('a profile without a model path leaves the unit’s own -m untouched', (t) => {
  const argv = ['/bin/llama-server', '-m', '/models/DeepSeek.gguf', '--ctx-size', '131072', '--parallel', '1'];
  const got = runtimeProfileArgv(argv, { contextTokens: 16384, parallel: 2 });
  assert.equal(got[got.indexOf('-m') + 1], '/models/DeepSeek.gguf');
  assert.equal(got.filter((value) => value === '-m' || value === '--model').length, 1);
});

test('a profile naming a model path rewrites -m in place', (t) => {
  const argv = ['/bin/llama-server', '-m', '/models/Q6_K/m.gguf', '--ctx-size', '131072', '--parallel', '1'];
  const got = runtimeProfileArgv(argv, { contextTokens: 131072, parallel: 1, modelPath: '/models/Q4_K/m.gguf' });
  assert.equal(got[got.indexOf('-m') + 1], '/models/Q4_K/m.gguf');
  assert.equal(got.filter((value) => value === '-m' || value === '--model').length, 1);
  assert.equal(got.length, argv.length);
});

test('the --model=value form and a unit with no -m at all are both handled', (t) => {
  const joined = runtimeProfileArgv(
    ['/bin/llama-server', '--model=/models/old.gguf', '--ctx-size', '4096', '--parallel', '1'],
    { contextTokens: 4096, parallel: 1, modelPath: '/models/new.gguf' });
  assert.ok(joined.includes('--model=/models/new.gguf'));
  const absent = runtimeProfileArgv(
    ['/bin/llama-server', '--ctx-size', '4096', '--parallel', '1'],
    { contextTokens: 4096, parallel: 1, modelPath: '/models/new.gguf' });
  assert.equal(absent[absent.indexOf('--model') + 1], '/models/new.gguf');
});

test('a model path must be absolute, a .gguf, and free of control characters', (t) => {
  const base = { contextTokens: 4096, parallel: 1 };
  for (const modelPath of ['models/rel.gguf', '/models/weights.safetensors', '/models/dir',
                           '/models/a\nb.gguf', '', '/models/' + 'x'.repeat(5000) + '.gguf']) {
    assert.throws(() => runtimeProfileArgv(['/bin/llama-server', '--ctx-size', '4096', '--parallel', '1'],
      { ...base, modelPath }), /model path/, `accepted ${JSON.stringify(modelPath.slice(0, 40))}`);
  }
});

test('a pre-quant override renders byte-identically, so saved profiles stay verifiable', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  const settings: LocalRuntimeSettings = { contextTokens: 32768, parallel: 2 };
  const rendered = runtimeProfileOverride(binding, runtimeProfileArgv(binding.baselineArgv, settings), settings);
  // The recorded metadata must carry exactly the two historical keys, in order, and nothing else.
  assert.match(rendered, /^# Settings: \{"contextTokens":32768,"parallel":2\}$/m);
  assert.doesNotMatch(rendered, /modelPath/);
});

test('an override that switches quantization records the path it switched to', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  const settings: LocalRuntimeSettings = { contextTokens: 32768, parallel: 2, modelPath: '/models/Q4_K/m.gguf' };
  const rendered = runtimeProfileOverride(binding, runtimeProfileArgv(binding.baselineArgv, settings), settings);
  // modelPath is serialized LAST, which is what keeps the two-key form above unchanged.
  assert.match(rendered, /^# Settings: \{"contextTokens":32768,"parallel":2,"modelPath":"\/models\/Q4_K\/m\.gguf"\}$/m);
});

test('an override may not misreport the command it is writing', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  const argv = runtimeProfileArgv(binding.baselineArgv, { contextTokens: 32768, parallel: 2 });
  // Claiming a model path the argv does not contain must be refused rather than recorded.
  assert.throws(() => runtimeProfileOverride(binding, argv,
    { contextTokens: 32768, parallel: 2, modelPath: '/models/Q4_K/m.gguf' }), /model path/);
  // Claiming an allocation the argv does not carry is refused the same way.
  assert.throws(() => runtimeProfileOverride(binding, argv,
    { contextTokens: 8192, parallel: 2 }), /engine allocation/);
});

test('applying a quantization switch restarts onto the new weights and reads back', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  const settings: LocalRuntimeSettings = { contextTokens: 32768, parallel: 2, modelPath: '/models/Q4_K/m.gguf' };
  const applied = await f.manager.apply(binding, settings);
  assert.deepEqual(applied, settings);
  // The live command is now pointed at the new file.
  assert.equal(f.state.argv[f.state.argv.indexOf('-m') + 1], '/models/Q4_K/m.gguf');
  assert.deepEqual(f.state.argv, runtimeProfileArgv(binding.baselineArgv, settings));
  // And inspection recovers it from the override, which is the only place it is recorded:
  // /props reports context and slots but never which file they were loaded from.
  assert.deepEqual(await f.manager.inspect(binding), settings);
});

test('restoring the baseline puts the original weights back', async (t) => {
  const f = world(t);
  const binding = await f.discover();
  await f.manager.apply(binding, { contextTokens: 32768, parallel: 2, modelPath: '/models/Q4_K/m.gguf' });
  const restored = await f.manager.restore(binding);
  assert.equal(restored.modelPath, undefined);
  assert.deepEqual(f.state.argv, binding.baselineArgv);
  assert.equal(f.state.argv[f.state.argv.indexOf('-m') + 1], '/models/DeepSeek.gguf');
});
