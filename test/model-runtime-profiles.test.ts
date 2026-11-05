import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ModelRuntimeProfileStore, validateRuntimeProfileSettings } from '../src/main/modelRuntimeProfiles';
import type { LocalRuntimeBinding, LocalRuntimeSettings } from '../src/main/localRuntimeService';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-runtime-profiles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'private', 'profiles.json');
  const binding: LocalRuntimeBinding = { version: 1, sourceId: 'source', model: 'deepseek', endpoint: 'http://127.0.0.1:8080',
    unit: 'llama-deepseek.service', baselineArgv: ['/opt/runtime/llama-server', '-m', '/models/one.gguf', '--ctx-size', '131072', '--parallel', '1', '--n-gpu-layers', '999', '--host', '127.0.0.1', '--port', '8080', '--alias', 'deepseek'],
    executable: { path: '/opt/runtime/llama-server', dev: 1, ino: 2, size: 1000, mtimeMs: 99 }, unitFingerprint: 'a'.repeat(64),
    baseline: { contextTokens: 131072, parallel: 1 }, uid: 1000 };
  let actual = { ...binding.baseline };
  let busy: boolean | string = false;
  let baseUrl = 'http://localhost:8080/v1';
  let found = true;
  let failure: Error | null = null;
  const calls: Array<{ method: string; settings?: LocalRuntimeSettings }> = [];
  const changes: unknown[] = [];
  const service = {
    discover: async () => { calls.push({ method: 'discover' }); return found ? structuredClone(binding) : null; },
    inspect: async () => { calls.push({ method: 'inspect' }); if (failure) throw failure; return { ...actual }; },
    apply: async (_binding: LocalRuntimeBinding, settings: LocalRuntimeSettings) => {
      calls.push({ method: 'apply', settings: { ...settings } }); actual = { ...settings }; return { ...actual };
    },
    restore: async () => { calls.push({ method: 'restore' }); actual = { ...binding.baseline }; return { ...actual }; },
  };
  const dependencies = { service, source: (sourceId: string, modelId: string) => sourceId === 'source' && modelId === 'deepseek' ? { baseUrl, model: 'deepseek' } : null,
    busy: () => busy, onChanged: (event: unknown) => changes.push(event) };
  const store = new ModelRuntimeProfileStore(path, dependencies);
  return { root, path, binding, service, dependencies, store, calls, changes,
    setBusy: (value: boolean | string) => { busy = value; }, setUrl: (value: string) => { baseUrl = value; },
    setFound: (value: boolean) => { found = value; }, setFailure: (value: Error | null) => { failure = value; },
    setActual: (value: LocalRuntimeSettings) => { actual = value; }, actual: () => actual };
}

test('capture saves exact immutable baseline and a separate orchestration copy without engine changes', async (t) => {
  const f = fixture(t);
  assert.equal(f.store.contextLimit('source', 'deepseek'), null);
  const available = await f.store.state('source', 'deepseek');
  assert.equal(available.supported, true); assert.equal(available.captured, false);
  const saved = await f.store.capture('source', 'deepseek');
  assert.equal(saved.profiles.length, 2);
  assert.deepEqual(saved.profiles.map((profile) => [profile.name, profile.contextTokens, profile.parallel, profile.baseline]), [
    ['Straight shot', 131072, 1, true], ['Orchestration', 32768, 2, false],
  ]);
  assert.notEqual(saved.profiles[0].id, saved.profiles[1].id);
  assert.equal(saved.activeProfileId, saved.profiles[0].id);
  assert.ok(f.calls.every((call) => call.method === 'discover'));
  const disk = JSON.parse(readFileSync(f.path, 'utf8'));
  assert.deepEqual(disk.records[0].binding.baselineArgv, f.binding.baselineArgv);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  for (const privateValue of ['baselineArgv', 'unitFingerprint', '/opt/runtime', '/models/one.gguf']) assert.ok(!JSON.stringify(saved).includes(privateValue));
  saved.profiles[0].name = 'tampered';
  assert.equal((await f.store.state('source', 'deepseek')).profiles[0].name, 'Straight shot');
  assert.equal((await f.store.capture('source', 'deepseek')).profiles.length, 2);
});

test('small baseline contexts are not increased in the automatically prepared orchestration profile', async (t) => {
  const f = fixture(t);
  f.binding.baseline.contextTokens = 8192;
  assert.equal((await f.store.capture('source', 'deepseek')).profiles[1].contextTokens, 8192);
});

test('copy and edit leave the original and active profile untouched and validate engine limits', async (t) => {
  const f = fixture(t);
  const state = await f.store.capture('source', 'deepseek');
  const [baseline, orchestration] = state.profiles;
  await assert.rejects(f.store.update('source', 'deepseek', baseline.id, { name: 'erase original' }), /immutable/);
  const copied = await f.store.copy('source', 'deepseek', baseline.id);
  const copy = copied.profiles.at(-1)!;
  assert.equal(copy.baseline, false); assert.notEqual(copy.id, baseline.id);
  const edited = await f.store.update('source', 'deepseek', copy.id, { name: 'My worker setup', contextTokens: 16384, parallel: 4 });
  assert.equal(edited.profiles[0].contextTokens, 131072);
  assert.deepEqual(edited.profiles.at(-1), { ...copy, name: 'My worker setup', contextTokens: 16384, parallel: 4, updatedAt: edited.profiles.at(-1)!.updatedAt });
  for (const patch of [{ parallel: 0 }, { parallel: 1.5 }, { parallel: 99 }, { contextTokens: 2 }, { contextTokens: 1048576, parallel: 16 }, { name: '\nunsafe' }]) {
    await assert.rejects(f.store.update('source', 'deepseek', orchestration.id, patch));
  }
  assert.throws(() => validateRuntimeProfileSettings({ contextTokens: NaN, parallel: 1 }));
  await f.store.apply('source', 'deepseek', orchestration.id);
  await assert.rejects(f.store.update('source', 'deepseek', orchestration.id, { name: 'edit active' }), /active profile/);
});

test('apply verifies engine before committing, restores exact baseline, and persists safe restart budgets', async (t) => {
  const f = fixture(t);
  const state = await f.store.capture('source', 'deepseek');
  const [baseline, orchestration] = state.profiles;
  const applied = await f.store.apply('source', 'deepseek', orchestration.id);
  assert.equal(applied.activeProfileId, orchestration.id);
  assert.deepEqual(f.actual(), { contextTokens: 32768, parallel: 2 });
  assert.equal(f.store.contextLimit('source', 'deepseek'), 32768);
  f.calls.length = 0;
  const restarted = new ModelRuntimeProfileStore(f.path, f.dependencies);
  assert.equal(restarted.contextLimit('source', 'deepseek'), 32768);
  assert.equal(f.calls.length, 0, 'the startup cap needs no network request');
  const restored = await restarted.apply('source', 'deepseek', baseline.id);
  assert.deepEqual(f.actual(), f.binding.baseline);
  assert.equal(restored.activeProfileId, baseline.id);
  assert.equal(f.calls.at(-1)?.method, 'restore');
  assert.equal(restarted.contextLimit('source', 'deepseek'), 131072);
});

test('busy and concurrent operations refuse before restarting and switching blocks new context budgets', async (t) => {
  const f = fixture(t);
  const state = await f.store.capture('source', 'deepseek');
  const target = state.profiles[1].id;
  f.setBusy('A chat is running.');
  await assert.rejects(f.store.apply('source', 'deepseek', target), /A chat is running/);
  assert.ok(!f.calls.some((call) => call.method === 'apply'));
  f.setBusy(false);
  let finish!: (value: LocalRuntimeSettings) => void;
  f.service.apply = async () => new Promise((resolve) => { finish = resolve; });
  const applying = f.store.apply('source', 'deepseek', target);
  assert.equal(f.store.isApplying('source'), true);
  assert.throws(() => f.store.contextLimit('source', 'deepseek'), /switching/);
  assert.equal((await f.store.state('source', 'deepseek')).applying, true);
  await assert.rejects(f.store.copy('source', 'deepseek', target), /operation/);
  await assert.rejects(f.store.apply('source', 'deepseek', target), /in progress/);
  finish({ contextTokens: 32768, parallel: 2 });
  await applying;
  assert.equal(f.store.isApplying(), false);
});

test('wrong verification result and persistence failure roll back without committing the target', async (t) => {
  const f = fixture(t);
  const state = await f.store.capture('source', 'deepseek');
  f.service.apply = async () => { f.setActual({ contextTokens: 9999, parallel: 2 }); return f.actual(); };
  await assert.rejects(f.store.apply('source', 'deepseek', state.profiles[1].id), /did not report/);
  assert.deepEqual(f.actual(), f.binding.baseline);
  assert.equal((await f.store.state('source', 'deepseek')).activeProfileId, state.profiles[0].id);
  const before = readFileSync(f.path, 'utf8');
  const preserved = `${f.path}.preserved`;
  f.service.apply = async (_binding, settings) => {
    f.setActual(settings); renameSync(f.path, preserved); mkdirSync(f.path); return { ...settings };
  };
  await assert.rejects(f.store.apply('source', 'deepseek', state.profiles[1].id));
  assert.deepEqual(f.actual(), f.binding.baseline);
  const preservedRecord = JSON.parse(readFileSync(preserved, 'utf8')).records[0];
  assert.equal(preservedRecord.activeProfileId, JSON.parse(before).records[0].activeProfileId);
  assert.equal(preservedRecord.pendingProfileId, state.profiles[1].id);
  assert.throws(() => f.store.contextLimit('source', 'deepseek'), /could not be confirmed/);
  rmSync(f.path, { recursive: true }); renameSync(preserved, f.path);
  const restarted = new ModelRuntimeProfileStore(f.path, f.dependencies);
  assert.equal(restarted.contextLimit('source', 'deepseek'), 32768);
  await restarted.state('source', 'deepseek');
  assert.equal(restarted.contextLimit('source', 'deepseek'), 131072);
});

test('adapter failure with unconfirmed rollback blocks inference until a successful inspection', async (t) => {
  const f = fixture(t);
  const state = await f.store.capture('source', 'deepseek');
  f.service.apply = async () => { f.setActual({ contextTokens: 16384, parallel: 2 }); throw new Error('restart and rollback failed'); };
  f.setFailure(new Error('server unavailable'));
  await assert.rejects(f.store.apply('source', 'deepseek', state.profiles[1].id), /restart and rollback/);
  assert.throws(() => f.store.contextLimit('source', 'deepseek'), /could not be confirmed/);
  f.setFailure(null);
  const observed = await f.store.state('source', 'deepseek');
  assert.equal(observed.activeProfileId, null);
  assert.match(observed.reason!, /interrupted profile switch/);
  assert.throws(() => f.store.contextLimit('source', 'deepseek'), /could not be verified/);
  await f.store.apply('source', 'deepseek', state.profiles[0].id);
  assert.equal(f.store.contextLimit('source', 'deepseek'), 131072);
});

test('late inspection from before a switch cannot overwrite verified active settings', async (t) => {
  const f = fixture(t);
  const state = await f.store.capture('source', 'deepseek');
  let finish!: (value: LocalRuntimeSettings) => void;
  f.service.inspect = async () => new Promise((resolve) => { finish = resolve; });
  const stale = f.store.state('source', 'deepseek');
  await f.store.apply('source', 'deepseek', state.profiles[1].id);
  finish({ contextTokens: 131072, parallel: 1 });
  const result = await stale;
  assert.deepEqual(result.actual, { contextTokens: 32768, parallel: 2 });
  assert.equal(result.activeProfileId, state.profiles[1].id);
});

test('unsupported and retargeted sources never acquire or apply service bindings', async (t) => {
  const f = fixture(t);
  f.setFound(false);
  assert.equal((await f.store.state('source', 'deepseek')).supported, false);
  await assert.rejects(f.store.capture('source', 'deepseek'), /No supported/);
  f.setFound(true);
  const state = await f.store.capture('source', 'deepseek');
  f.setUrl('http://127.0.0.1:9999/v1');
  assert.equal((await f.store.state('source', 'deepseek')).supported, false);
  assert.throws(() => f.store.contextLimit('source', 'deepseek'), /changed endpoints/);
  await assert.rejects(f.store.apply('source', 'deepseek', state.profiles[1].id), /changed endpoints/);
  assert.ok(!f.calls.some((call) => call.method === 'apply'));
});

test('malformed or symlinked profile stores fail closed and do not overwrite saved evidence', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'private'));
  writeFileSync(f.path, '{broken');
  assert.throws(() => new ModelRuntimeProfileStore(f.path, f.dependencies), /left unchanged/);
  assert.equal(readFileSync(f.path, 'utf8'), '{broken');
  rmSync(f.path);
  const external = join(f.root, 'external.json'); writeFileSync(external, '{"version":1,"records":[]}');
  symlinkSync(external, f.path);
  assert.throws(() => new ModelRuntimeProfileStore(f.path, f.dependencies), /left unchanged/);
});

test('interrupted switches preserve a conservative restart budget and reconcile either verified result', async (t) => {
  const f = fixture(t);
  const state = await f.store.capture('source', 'deepseek');
  const [baseline, target] = state.profiles;
  let finish!: (value: LocalRuntimeSettings) => void;
  f.service.apply = async (_binding, settings) => {
    const saved = JSON.parse(readFileSync(f.path, 'utf8')).records[0];
    assert.equal(saved.activeProfileId, baseline.id);
    assert.equal(saved.pendingProfileId, target.id, 'intent is durable before any engine change');
    f.setActual(settings);
    return new Promise((resolve) => { finish = resolve; });
  };
  const applying = f.store.apply('source', 'deepseek', target.id);
  const crashImage = readFileSync(f.path, 'utf8');
  const afterCrash = new ModelRuntimeProfileStore(f.path, f.dependencies);
  assert.equal(afterCrash.contextLimit('source', 'deepseek'), 32768);
  await assert.rejects(afterCrash.update('source', 'deepseek', target.id, { contextTokens: 65536 }), /interrupted/);
  await assert.rejects(afterCrash.remove('source', 'deepseek', target.id), /interrupted/);
  const recovered = await afterCrash.state('source', 'deepseek');
  assert.equal(recovered.activeProfileId, target.id);
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).records[0].pendingProfileId, undefined);
  finish({ contextTokens: 32768, parallel: 2 }); await applying;

  // A crash before the restart leaves exactly the same marker but the old engine still runs.
  writeFileSync(f.path, crashImage); f.setActual(f.binding.baseline);
  const beforeRestart = new ModelRuntimeProfileStore(f.path, f.dependencies);
  assert.equal(beforeRestart.contextLimit('source', 'deepseek'), 32768);
  assert.equal((await beforeRestart.state('source', 'deepseek')).activeProfileId, baseline.id);
  assert.equal(beforeRestart.contextLimit('source', 'deepseek'), 131072);
});

test('inactive copies can be removed while original, active, and pending profiles remain protected', async (t) => {
  const f = fixture(t);
  const state = await f.store.capture('source', 'deepseek');
  const [baseline, target] = state.profiles;
  await assert.rejects(f.store.remove('source', 'deepseek', baseline.id), /cannot be removed/);
  await f.store.apply('source', 'deepseek', target.id);
  await assert.rejects(f.store.remove('source', 'deepseek', target.id), /active profile/);
  const copied = await f.store.copy('source', 'deepseek', target.id);
  const copy = copied.profiles.at(-1)!;
  const removed = await f.store.remove('source', 'deepseek', copy.id);
  assert.equal(removed.profiles.length, 2);
  assert.equal(removed.activeProfileId, target.id);
  assert.equal((await new ModelRuntimeProfileStore(f.path, f.dependencies).state('source', 'deepseek')).profiles.length, 2);
  await assert.rejects(f.store.remove('source', 'deepseek', copy.id), /no longer exists/);
});

test('source aliases share verified, pending, and uncertain engine limits without affecting other endpoints', async (t) => {
  const f = fixture(t);
  const originalSource = f.dependencies.source;
  f.dependencies.source = (sourceId, modelId) => {
    if (sourceId === 'alias' && modelId === 'deepseek') return { baseUrl: 'http://localhost:8080/v1/', model: modelId };
    if (sourceId === 'other' && modelId === 'deepseek') return { baseUrl: 'http://127.0.0.1:8081/v1', model: modelId };
    return originalSource(sourceId, modelId);
  };
  const state = await f.store.capture('source', 'deepseek');
  const alias = await f.store.state('alias', 'deepseek');
  assert.equal(alias.supported, false);
  assert.match(alias.reason!, /already registered/);
  await assert.rejects(f.store.capture('alias', 'deepseek'), /already registered/);
  await f.store.apply('source', 'deepseek', state.profiles[1].id);
  assert.equal(f.store.contextLimit('alias', 'deepseek'), 32768);
  assert.equal(f.store.contextLimit('other', 'deepseek'), null);
  await f.store.apply('source', 'deepseek', state.profiles[0].id);
  const disk = JSON.parse(readFileSync(f.path, 'utf8'));
  disk.records[0].pendingProfileId = state.profiles[1].id;
  writeFileSync(f.path, JSON.stringify(disk));
  const restarted = new ModelRuntimeProfileStore(f.path, f.dependencies);
  assert.equal(restarted.contextLimit('alias', 'deepseek'), 32768, 'crash-window cap applies through an alias before inspection');
  await restarted.state('source', 'deepseek');
  assert.equal(restarted.contextLimit('alias', 'deepseek'), 131072);
  f.service.apply = async () => { throw new Error('restart and rollback failed'); };
  f.setFailure(new Error('unconfirmed engine'));
  await assert.rejects(restarted.apply('source', 'deepseek', state.profiles[1].id), /rollback failed/);
  assert.throws(() => restarted.contextLimit('alias', 'deepseek'), /could not be confirmed/);
  assert.equal(restarted.contextLimit('other', 'deepseek'), null);
});

test('a captured unavailable engine offers only explicit baseline recovery and preserves its journal until verified', async (t) => {
  const f = fixture(t);
  const initial = await f.store.capture('source', 'deepseek');
  const disk = JSON.parse(readFileSync(f.path, 'utf8'));
  disk.records[0].pendingProfileId = initial.profiles[1].id;
  writeFileSync(f.path, JSON.stringify(disk));
  const restarted = new ModelRuntimeProfileStore(f.path, f.dependencies);
  f.setFailure(new Error('The registered model service is not running.'));
  const recovery = await restarted.state('source', 'deepseek');
  assert.equal(recovery.supported, true);
  assert.equal(recovery.recoveryOnly, true);
  assert.equal(recovery.activeProfileId, null);
  assert.equal(recovery.actual, null);
  assert.equal(recovery.profiles.length, 2);
  await assert.rejects(restarted.apply('source', 'deepseek', initial.profiles[1].id), /Restore Straight shot/);
  await assert.rejects(restarted.copy('source', 'deepseek', initial.profiles[0].id), /Restore or refresh/);
  f.service.restore = async () => {
    assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).records[0].pendingProfileId, initial.profiles[1].id);
    f.setFailure(null); f.setActual(f.binding.baseline); return { ...f.binding.baseline };
  };
  const restored = await restarted.apply('source', 'deepseek', initial.profiles[0].id);
  assert.equal(restored.activeProfileId, initial.profiles[0].id);
  assert.equal(restored.recoveryOnly, undefined);
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).records[0].pendingProfileId, undefined);
  assert.equal(restarted.contextLimit('source', 'deepseek'), 131072);
});
