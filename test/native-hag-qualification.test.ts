import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nativeHagPlan, nativeHagSettingsSha256, nativeHagIdentity } from '../src/main/nativeHagQualification';
import { hagSystemdArgs, hagResourceFailure, validateHagCatalog, validateHagLimits, type HagContainment } from '../src/main/hagProcess';

// Fixture values exercise policy propagation; they are not a product qualification.
const GiB = 1024 ** 3;
const containment: HagContainment = {
  memoryMaxBytes: 20 * GiB, memoryHighBytes: 19 * GiB, tasksMax: 64, cpuQuotaPercent: 150,
  runtimeSeconds: 3600, startAvailableBytes: 18 * GiB, activeAvailableBytes: 8 * GiB,
  startTemperatureC: 60, activeTemperatureC: 85, startGpuTemperatureC: 55, activeGpuTemperatureC: 85,
};
const model = {
  id: 'openmythos-27b-hag', path: '/models/mythos.gguf', execution_backend: 'hag',
  memory_budget_bytes: 20 * GiB, runtime_headroom_bytes: GiB,
  hag: { device: '/dev/dri/renderD128', context_capacity: 2048, memory_budget_bytes: GiB },
  hag_qwen35: { tile_rows: 4096, encoded_read_bytes: 67108864, decoded_read_bytes: 67108864, cleanup_timeout_ms: 60000 },
};
const binaryText = 'test native executable';
const manifest = {
  artifacts: [{ path: 'bin/beholdd', bytes: Buffer.byteLength(binaryText), sha256: createHash('sha256').update(binaryText).digest('hex') }],
  nativeHagQualification: { schemaVersion: 1, receiptSha256: 'a'.repeat(64), hagSettingsSha256: nativeHagSettingsSha256([model]), forecastBytes: 18 * GiB, sourceFileBytes: 16_547_399_872, deviceChargeBytes: 640 * 1024 ** 2, containment },
};
const plan = (models: unknown[], packageManifest: unknown = manifest) => nativeHagPlan(JSON.stringify({ models }), packageManifest);

test('CPU-only configs keep the existing launch and need no HAG artifacts', () => {
  assert.equal(plan([{ id: 'cpu', path: '/models/cpu.gguf' }], null), null);
});

test('only the exact explicitly budgeted OpenMythos HAG settings are admitted', () => {
  assert.equal(plan([model])!.expectedModels[0].maxEvaluatedTokens, 2048);
  for (const changed of [{ ...model, id: 'other' }, { ...model, hag_qwen35: undefined },
    { ...model, memory_budget_bytes: undefined }, { ...model, runtime_headroom_bytes: undefined },
    { ...model, hag: { ...model.hag, context_capacity: 4096 } },
    { ...model, hag_qwen35: { ...model.hag_qwen35, tile_rows: 64 } }]) assert.throws(() => plan([changed]));
  assert.throws(() => plan([model, model]));
  assert.throws(() => plan([model], null), /qualification/);
});

test('ordinary CPU Hub additions, root CPU budgets and host paths do not change HAG qualification', () => {
  const local = { ...model, path: '/different/checkpoint.gguf', hag: { ...model.hag, device: '/dev/dri/renderD129' } };
  assert.equal(nativeHagSettingsSha256([local]), nativeHagSettingsSha256([model]));
  const cpu = { id: 'download', path: '/models/new.gguf', execution_backend: 'cpu' };
  const result = nativeHagPlan(JSON.stringify({ memory_budget_bytes: 123, models: [cpu, local] }), manifest)!;
  assert.deepEqual(result.expectedModels, [{ id: 'download' }, { id: model.id, maxEvaluatedTokens: 2048 }]);
  assert.throws(() => plan([model, { ...cpu, id: model.id }]), /duplicate/);
});

test('native qualification cannot omit the packaged executable identity or GPU safeguards', () => {
  assert.throws(() => plan([model], { ...manifest, artifacts: [] }), /binary/);
  assert.throws(() => plan([model], { ...manifest, nativeHagQualification: { ...manifest.nativeHagQualification,
    containment: { ...containment, startGpuTemperatureC: undefined, activeGpuTemperatureC: undefined } } }), /CPU\/GPU temperature/);
  assert.throws(() => plan([model], { ...manifest, nativeHagQualification: { ...manifest.nativeHagQualification,
    containment: { ...containment, memoryHighBytes: 18 * GiB } } }), /forecast/);
});

test('native policy controls the same verified service owner, without changing the preview default', () => {
  const options = { binary: '/vendor/beholdd', config: '/private/config', port: 6768, modelId: model.id, containment, onExit: () => {} };
  const args = hagSystemdArgs(options, 'antimatter-hag-1-abc.service');
  for (const property of ['MemoryMax=20G', 'MemoryHigh=19G', 'CPUQuota=150%', 'RuntimeMaxSec=3600',
    'TimeoutStopSec=65', 'MemorySwapMax=0', 'KillMode=control-group', 'HAG_TRACE_SUBMISSION=0', 'Restart=no']) assert.ok(args.includes(property));
  assert.throws(() => hagSystemdArgs({ ...options, runtimeSeconds: 3601 }, 'antimatter-hag-1-abc.service'), /30 through 3600/);
  const values = { 'memory.max': String(20 * GiB), 'memory.high': String(19 * GiB), 'memory.swap.max': '0', 'pids.max': '64', 'cpu.max': '150000 100000' };
  assert.doesNotThrow(() => validateHagLimits(values, 'Cpus_allowed_list:\t0-1\nNoNewPrivs:\t1\n', containment));
  assert.throws(() => validateHagLimits({ ...values, 'memory.max': String(32 * GiB) }, 'Cpus_allowed_list:\t0-1\nNoNewPrivs:\t1\n', containment));
});

test('native admission checks both temperatures, independent host reserve and malformed readings', () => {
  const cool = { available: 20 * GiB, temperature: 55, gpuTemperature: 50 };
  assert.equal(hagResourceFailure(cool, true, containment), null);
  assert.match(hagResourceFailure({ ...cool, gpuTemperature: undefined }, true, containment)!, /telemetry/);
  assert.match(hagResourceFailure({ ...cool, gpuTemperature: 56 }, true, containment)!, /GPU temperature/);
  assert.match(hagResourceFailure({ ...cool, available: 7 * GiB }, false, containment)!, /8 GiB/);
  assert.match(hagResourceFailure({ ...cool, temperature: 85 }, false, containment)!, /temperature/);
});

test('cold handshake preserves all CPU ids and validates only the explicit HAG capacity', () => {
  const expected = plan([{ id: 'cpu', path: '/models/cpu.gguf' }, model])!.expectedModels;
  const rows = [{ id: 'cpu', loaded: false }, { id: model.id, loaded: false, execution_limits: { max_evaluated_tokens: 2048 } }];
  assert.doesNotThrow(() => validateHagCatalog({ data: rows }, expected, true));
  for (const changed of [[rows[0]], [rows[0], rows[0]], [rows[0], { ...rows[1], loaded: true }],
    [rows[0], { ...rows[1], execution_limits: { max_evaluated_tokens: 16384 } }]]) {
    assert.throws(() => validateHagCatalog({ data: changed }, expected, true));
  }
});

test('binary and startup config identity are checked without opening any checkpoint', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-native-hag-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const binary = join(root, 'beholdd'); const config = join(root, 'config.yaml');
  const text = JSON.stringify({ models: [model] }); writeFileSync(binary, binaryText); writeFileSync(config, text);
  const identity = await nativeHagIdentity(binary, config, text, plan([model])!);
  await identity.verifyIdentity(); identity.identityUnchanged();
  // A later Hub edit takes effect only on restart; it does not invalidate this immutable running catalog.
  writeFileSync(config, JSON.stringify({ models: [{ id: 'cpu' }, model] }));
  identity.identityUnchanged();
  await assert.rejects(identity.verifyIdentity(), /configuration changed/);
  writeFileSync(binary, binaryText + 'changed'); assert.throws(() => identity.identityUnchanged(), /executable changed/);
  await assert.rejects(nativeHagIdentity(binary, config, text, plan([model])!), /size changed/);
});


test('qualification includes the conservative device charge and rejects missing or excessive charge', () => {
  assert.equal(plan([model])!.privateMemory.deviceChargeBytes, 640 * 1024 ** 2);
  for (const deviceChargeBytes of [undefined, 0, -1, GiB + 1, NaN]) {
    assert.throws(() => plan([model], { ...manifest, nativeHagQualification: {
      ...manifest.nativeHagQualification, deviceChargeBytes,
    } }), /forecast/);
  }
});
