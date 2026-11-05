import assert from 'node:assert/strict';
import test from 'node:test';
import { hagSystemdArgs, parseHagAttestation, prepareHagRequest, requireRetiredHagUnit,
  validateHagPrivateAccounting, type HagContainment } from '../src/main/hagProcess';
import { PRIVATE_HAG_LAUNCH } from '../src/main/hagPrivateLaunch';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const unit = 'antimatter-hag-123-abc.service';
const group = '/user.slice/user-1000.slice/user@1000.service/app.slice/' + unit;
const policy: HagContainment = {
  memoryMaxBytes: 20 * GiB, memoryHighBytes: 19 * GiB, tasksMax: 64, cpuQuotaPercent: 150,
  runtimeSeconds: 3600, startAvailableBytes: 18 * GiB, activeAvailableBytes: 8 * GiB,
  startTemperatureC: 60, activeTemperatureC: 85, startGpuTemperatureC: 55, activeGpuTemperatureC: 85,
};

test('native shell receives literal paths through argv and systemd cannot expand its PID or variables', () => {
  const binary = '/private path/$(do-not-run)/beholdd'; const config = '/private path/$config.yaml';
  const args = hagSystemdArgs({ binary, config, port: 6768, modelId: 'openmythos-27b-hag', containment: policy,
    onExit: () => {} }, unit);
  assert.ok(args.includes('--expand-environment=no'));
  assert.equal(args[args.indexOf('/bin/sh') + 2], PRIVATE_HAG_LAUNCH);
  assert.ok(PRIVATE_HAG_LAUNCH.includes('group=${membership#0::}'));
  assert.ok(!PRIVATE_HAG_LAUNCH.includes(binary)); assert.ok(!PRIVATE_HAG_LAUNCH.includes(config));
  assert.deepEqual(args.slice(-8), [unit, binary, config, '6768', String(20 * GiB), String(19 * GiB), '64', '150']);
});

test('attestation is bound to the expected leaf and records a bounded pre-exec baseline', () => {
  const line = `ANTIMATTER_HAG_ATTESTATION_V1 ${unit} 321 ${MiB} ${group}`;
  assert.deepEqual(parseHagAttestation(line, unit), { pid: 321, baselineBytes: MiB, cgroup: group });
  for (const changed of [line.replace('321', '0'), line.replace(String(MiB), String(65 * MiB)),
    line.replace('/app.slice/', '/app.slice/../'), line + ' extra', line.replace(unit, 'other.service')]) {
    assert.equal(parseHagAttestation(changed, unit), null);
  }
});

const plan = { forecastBytes: 18 * GiB, sourceFileBytes: 16 * GiB, deviceChargeBytes: 640 * MiB, baselineBytes: MiB };
const stat = (file: number, shmem = 0, dirty = 0, writeback = 0, unevictable = 0) =>
  `anon 1\nfile ${file}\nshmem ${shmem}\nfile_dirty ${dirty}\nfile_writeback ${writeback}\nunevictable ${unevictable}\n`;
const check = (current: number, stats: string, afterCurrent = current, afterStats = stats) =>
  validateHagPrivateAccounting(String(current), stats, String(afterCurrent), afterStats, plan);

test('private nonfile accounting credits only observed clean source cache and reserves full native UMA', () => {
  assert.doesNotThrow(() => check(17 * GiB, stat(16 * GiB)));
  assert.throws(() => check(18 * GiB, stat(16 * GiB)), /nonfile/);
  assert.throws(() => check(17 * GiB, stat(16 * GiB), 18 * GiB), /nonfile/);
  assert.throws(() => check(17 * GiB, stat(16 * GiB), 17 * GiB, stat(15 * GiB)), /nonfile/);
  for (const stats of [stat(16 * GiB, GiB), stat(16 * GiB, 0, GiB), stat(16 * GiB, 0, 0, GiB), stat(16 * GiB, 0, 0, 0, GiB)]) {
    assert.throws(() => check(17 * GiB, stats), /nonfile/);
  }
  assert.throws(() => check(19 * GiB, stat(20 * GiB)), /nonfile/); // Credit cannot exceed the pinned source size.
  assert.throws(() => check(17 * GiB, 'file 1\n'), /malformed/);
  assert.throws(() => check(17 * GiB, stat(16 * GiB) + 'file 1\n'), /repeat/);
});

test('retirement cannot accept absent facts, an intermediate state, or a remaining control process', () => {
  for (const ActiveState of ['inactive', 'failed']) assert.doesNotThrow(() => requireRetiredHagUnit({ ActiveState, MainPID: '0', ControlPID: '0' }));
  for (const facts of [{}, { ActiveState: 'inactive', MainPID: '0' },
    { ActiveState: 'deactivating', MainPID: '0', ControlPID: '0' },
    { ActiveState: 'inactive', MainPID: '0', ControlPID: '1' }]) assert.throws(() => requireRetiredHagUnit(facts));
});

const modelId = 'openmythos-27b-hag';
const expected = [{ id: modelId, maxEvaluatedTokens: 2048 }, { id: 'cpu-catalog-entry' }];
function requestFixture(loaded: unknown) {
  const calls: string[] = [];
  const guards = {
    verify: async () => { calls.push('verify'); },
    catalog: async () => { calls.push('catalog'); return { data: [
      { id: modelId, loaded, execution_limits: { max_evaluated_tokens: 2048 } },
      { id: 'cpu-catalog-entry', loaded: false },
    ] }; },
    quiet: async () => { calls.push('quiet'); }, active: () => { calls.push('active'); },
  };
  return { calls, guards };
}

test('every cold first request or reload repeats the quiet startup gate; warm requests retain active guard', async () => {
  for (const loaded of [false, true, false]) {
    const f = requestFixture(loaded);
    await prepareHagRequest(modelId, modelId, expected, f.guards);
    assert.deepEqual(f.calls, ['verify', 'catalog', loaded ? 'active' : 'quiet', 'verify']);
  }
  const unknown = requestFixture(undefined);
  await assert.rejects(prepareHagRequest(modelId, modelId, expected, unknown.guards), /whether the model is cold/);
  assert.deepEqual(unknown.calls, ['verify', 'catalog']);
});

test('unqualified CPU requests and cancellation are refused without model or metadata I/O', async () => {
  const f = requestFixture(false);
  await assert.rejects(prepareHagRequest('cpu-catalog-entry', modelId, expected, f.guards), /qualified only for OpenMythos/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareHagRequest(modelId, modelId, expected, f.guards, controller.signal), { name: 'AbortError' });
  assert.deepEqual(f.calls, []);
  f.guards.quiet = async () => { f.calls.push('quiet'); throw new Error('too hot'); };
  await assert.rejects(prepareHagRequest(modelId, modelId, expected, f.guards), /too hot/);
  assert.deepEqual(f.calls, ['verify', 'catalog', 'quiet']);
});
