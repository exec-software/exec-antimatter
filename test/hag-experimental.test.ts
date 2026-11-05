import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HagExperimental, hagSource, hagConfig, isOwnedHagSource, parseHagSettings, hagDownloadUrl,
  verifyHagModel, HAG_MODEL_BYTES, HAG_MODEL_SHA256, HAG_MODEL_FILE } from '../src/main/hagExperimental';
import { HagProcessCleanupError, hagResourceFailure, hagSystemdArgs, validateHagLimits, type HagLaunchOptions } from '../src/main/hagProcess';
import { HAG_MODEL_ID, HAG_SOURCE_ID, HAG_PREVIEW_MAX_EVALUATED_TOKENS, HAG_PREVIEW_MAX_OUTPUT_TOKENS,
  HAG_PREVIEW_SYSTEM, prepareHagPreview, assertHagPreview, assertHagVisibleHistory, hagPreviewPromptBound } from '../src/api/hag';
import { fitHagPreview } from '../src/main/hagPreviewContext';
import type { ChatRequest, Message } from '../src/api/types';

const descriptor = { schemaVersion: 1, filename: HAG_MODEL_FILE, bytes: HAG_MODEL_BYTES, sha256: HAG_MODEL_SHA256,
  source: { repository: 'unsloth/Qwen3-0.6B-GGUF', revision: '50968a4468ef4233ed78cd7c3de230dd1d61a56b',
    url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/50968a4468ef4233ed78cd7c3de230dd1d61a56b/' + HAG_MODEL_FILE } };

function fixture(t: { after(fn: () => unknown): void }, local = true) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-hag-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'state'); const vendorRoot = join(root, 'vendor'); const home = join(root, 'home');
  mkdirSync(vendorRoot); writeFileSync(join(vendorRoot, 'model.json'), JSON.stringify(descriptor));
  const model = join(home, '.beholdd', 'models', 'qwen3-0.6b-hag', HAG_MODEL_FILE);
  if (local) { mkdirSync(join(home, '.beholdd', 'models', 'qwen3-0.6b-hag'), { recursive: true }); writeFileSync(model, 'test checkpoint'); }
  const calls: string[] = []; let busy = false; let supported = true; let launchOptions: HagLaunchOptions | null = null;
  const options = { directory, vendorRoot, home, busy: () => busy,
    register: () => { calls.push('register'); }, remove: () => { calls.push('remove'); },
    beforeStart: async () => { calls.push('before-start'); }, changed: () => {},
    capability: () => ({ device: supported ? '/dev/dri/renderD128' : null, reason: supported ? null : 'unsupported device' }),
    verifyModel: async (path: string) => { calls.push('verify'); assert.equal(readFileSync(path, 'utf8'), 'test checkpoint'); },
    download: async (_url: string, target: string, progress: (bytes: number) => void) => {
      calls.push('download'); writeFileSync(target, 'test checkpoint'); progress(HAG_MODEL_BYTES);
    },
    launch: async (input: HagLaunchOptions) => { calls.push('launch'); launchOptions = input; return { stop: async () => { calls.push('stop'); } }; },
  };
  return { root, model, calls, options, instance: new HagExperimental(options), setBusy: (value: boolean) => { busy = value; },
    unsupported: () => { supported = false; }, exit: (reason: string, retired = true) => launchOptions!.onExit(reason, retired) };
}

test('first-run state is opt-in and polling performs no download, model verification, or launch', (t) => {
  const f = fixture(t); const state = f.instance.state();
  assert.equal(state.showWelcome, true); assert.equal(state.enabled, false); assert.equal(state.status, 'disabled');
  assert.equal(state.model.maxEvaluatedTokens, 16384); assert.equal(state.modelDownloadBytes, HAG_MODEL_BYTES);
  assert.equal(f.instance.readiness().state, 'unreachable'); assert.deepEqual(f.calls, []);
  assert.equal(existsSync(f.options.directory), false);
});

test('invalid persisted settings fail closed and do not suppress the invitation', () => {
  for (const value of [null, {}, { version: 1, enabled: 'yes', welcomeSeen: true, modelPath: '/' },
    { version: 1, enabled: true, welcomeSeen: true }]) assert.deepEqual(parseHagSettings(value),
      { version: 1, enabled: false, welcomeSeen: false, modelPath: null });
});

test('dismiss persists without enabling, registering, downloading, or launching', (t) => {
  const f = fixture(t); f.instance.dismissWelcome();
  assert.equal(new HagExperimental(f.options).state().showWelcome, false);
  assert.equal(f.instance.state().enabled, false); assert.deepEqual(f.calls, []);
});

test('explicit enable reuses a verified checkpoint and registers without starting a process', async (t) => {
  const f = fixture(t); const state = await f.instance.enable();
  assert.deepEqual(f.calls, ['verify', 'register']); assert.equal(state.enabled, true);
  assert.equal(state.showWelcome, false); assert.equal(state.status, 'stopped'); assert.equal(state.modelDownloadBytes, 0);
  assert.equal(f.instance.readiness().state, 'startable');
  const restored = new HagExperimental(f.options); restored.initialize();
  assert.equal(restored.state().enabled, true); assert.equal(f.calls.includes('launch'), false);
});

test('missing checkpoint downloads only after explicit enable and is verified before registration', async (t) => {
  const f = fixture(t, false);
  await f.instance.enable(); assert.deepEqual(f.calls, ['download', 'verify', 'register']);
  assert.equal(f.instance.state().downloadProgress, null);
});

test('unsupported hardware refuses enabling before I/O or source changes', async (t) => {
  const f = fixture(t); f.unsupported();
  await assert.rejects(f.instance.enable(), /unsupported device/);
  assert.deepEqual(f.calls, []); assert.equal(f.instance.state().enabled, false); assert.equal(f.instance.state().showWelcome, true);
});

test('start verifies the checkpoint again, prepares exactly one model, and serializes duplicate starts', async (t) => {
  const f = fixture(t); await f.instance.enable(); await Promise.all([f.instance.start(), f.instance.start()]);
  assert.deepEqual(f.calls, ['verify', 'register', 'verify', 'before-start', 'launch']);
  const config = readFileSync(join(f.options.directory, 'config.yaml'), 'utf8');
  assert.match(config, /execution_backend: hag/); assert.match(config, /context_capacity: 16384/);
  assert.match(config, /4831838208/); assert.equal(f.instance.state().status, 'ready');
});

test('disabling a busy source refuses without stopping, removing, or changing consent', async (t) => {
  const f = fixture(t); await f.instance.enable(); await f.instance.start(); f.calls.length = 0; f.setBusy(true);
  await assert.rejects(f.instance.disable(), /serving a request/);
  assert.deepEqual(f.calls, []); assert.equal(f.instance.state().enabled, true);
});

test('disable retires before removal, retains the checkpoint, and persists the opt-out', async (t) => {
  const f = fixture(t); await f.instance.enable(); await f.instance.start(); f.calls.length = 0;
  await f.instance.disable(); assert.deepEqual(f.calls, ['stop', 'remove']); assert.equal(existsSync(f.model), true);
  assert.equal(new HagExperimental(f.options).state().enabled, false); assert.equal(f.instance.state().showWelcome, false);
});

test('a crash does not silently retry and uncertain cleanup keeps the process available for retirement', async (t) => {
  const f = fixture(t); await f.instance.enable(); await f.instance.start(); f.exit('watchdog failure', false); f.calls.length = 0;
  await assert.rejects(f.instance.start(), /watchdog failure/); assert.deepEqual(f.calls, []);
  await f.instance.disable(); assert.deepEqual(f.calls, ['stop', 'remove']);
});

test('re-enabling an uncertain process retires it before offering fresh first-request startup', async (t) => {
  const f = fixture(t); await f.instance.enable(); await f.instance.start(); f.exit('uncertain exit', false); f.calls.length = 0;
  await f.instance.enable(); assert.equal(f.calls[0], 'stop'); assert.equal(f.instance.state().status, 'stopped');
  assert.equal(f.calls.includes('launch'), false); await f.instance.start(); assert.equal(f.calls.filter((call) => call === 'launch').length, 1);
});

test('cancelling HAG launch waits for its cleanup, preserves enablement, and permits the next prompt', async (t) => {
  const f = fixture(t); await f.instance.enable(); f.calls.length = 0;
  const controller = new AbortController();
  let launched!: () => void; const launchReached = new Promise<void>((resolve) => { launched = resolve; });
  let retire!: () => void; const retirement = new Promise<void>((resolve) => { retire = resolve; });
  const launch = f.options.launch;
  f.options.launch = async (input) => {
    f.calls.push('launch'); launched();
    await new Promise<void>((resolve) => input.signal!.addEventListener('abort', () => resolve(), { once: true }));
    await retirement;
    input.signal!.throwIfAborted();
    throw new Error('unreachable');
  };
  let settled = false;
  const pending = f.instance.start(controller.signal).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await launchReached; controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  f.options.launch = launch;
  const retry = f.instance.start();
  assert.equal(f.calls.filter((call) => call === 'launch').length, 1);
  retire(); await rejected; await retry;
  assert.equal(f.calls.filter((call) => call === 'launch').length, 2);
  assert.equal(f.instance.state().enabled, true); assert.equal(f.instance.state().status, 'ready');
  await f.instance.stop();
});

test('cancelling HAG verification never retires siblings or launches and remains startable', async (t) => {
  const f = fixture(t); await f.instance.enable(); f.calls.length = 0;
  const controller = new AbortController();
  f.options.verifyModel = async () => { f.calls.push('verify'); controller.abort(); };
  await assert.rejects(f.instance.start(controller.signal), { name: 'AbortError' });
  assert.deepEqual(f.calls, ['verify']);
  assert.equal(f.instance.state().enabled, true); assert.equal(f.instance.state().error, null);
  assert.equal(f.instance.readiness().state, 'startable');
});

test('cancelled HAG launch retains an uncertain owner and requires verified cleanup before retry', async (t) => {
  const f = fixture(t); await f.instance.enable(); f.calls.length = 0;
  const controller = new AbortController();
  f.options.launch = async () => {
    controller.abort();
    throw new HagProcessCleanupError('retirement unconfirmed', { stop: async () => { f.calls.push('cleanup'); } });
  };
  await assert.rejects(f.instance.start(controller.signal), /retirement unconfirmed/);
  assert.equal(f.instance.state().enabled, true); assert.equal(f.instance.state().status, 'error');
  await assert.rejects(f.instance.start(), /retirement unconfirmed/);
  await f.instance.stop();
  assert.ok(f.calls.includes('cleanup'));
});

test('source ownership never covers another model or endpoint; YAML paths cannot add fields', () => {
  const source = hagSource(); assert.equal(isOwnedHagSource(source), true);
  assert.equal(isOwnedHagSource({ ...source, baseUrl: 'http://127.0.0.1:6768/v1' }), false);
  assert.equal(isOwnedHagSource({ ...source, models: [{ id: 'openmythos', name: 'OpenMythos' }] }), false);
  const injected = '/a\n    execution_backend: cpu';
  assert.ok(hagConfig(injected, '/dev/dri/renderD128').includes(JSON.stringify(injected)));
});

test('package model URL requires the exact checkpoint pin and HTTPS', (t) => {
  const f = fixture(t); assert.equal(hagDownloadUrl(f.options.vendorRoot), descriptor.source.url);
  for (const changed of [{ ...descriptor, bytes: 1 }, { ...descriptor, sha256: '0'.repeat(64) },
    { ...descriptor, source: { ...descriptor.source, url: 'http://unsafe.invalid/model' } }]) {
    writeFileSync(join(f.options.vendorRoot, 'model.json'), JSON.stringify(changed));
    assert.throws(() => hagDownloadUrl(f.options.vendorRoot));
  }
});

test('wrong-size checkpoints are rejected without inference', async (t) => {
  const f = fixture(t); await assert.rejects(verifyHagModel(f.model), /pinned Qwen3/);
});

test('systemd launch is finite, isolated, non-restarting, and leaves the CPU backend untouched', () => {
  const args = hagSystemdArgs({ binary: '/vendor/beholdd-hag/bin/beholdd', config: '/private/hag.yaml', port: 6769,
    modelId: HAG_MODEL_ID, onExit: () => {} }, 'owned-hag.service');
  for (const value of ['MemoryMax=6G', 'MemoryHigh=5632M', 'MemorySwapMax=0', 'CPUQuota=25%', 'NoNewPrivileges=yes',
    'Restart=no', 'RuntimeMaxSec=1800', 'KillMode=control-group', 'HAG_TRACE_SUBMISSION=0']) assert.ok(args.includes(value));
  assert.deepEqual(args.slice(-8), ['/vendor/beholdd-hag/bin/beholdd', 'serve', '--config', '/private/hag.yaml', '--host', '127.0.0.1', '--port', '6769']);
  assert.ok(!args.includes('6768'));
  const options = { binary: '/vendor/beholdd-hag/bin/beholdd', config: '/private/hag.yaml', port: 6769,
    modelId: HAG_MODEL_ID, onExit: () => {} };
  for (const runtimeSeconds of [30, 540, 1800]) {
    const leaseArgs = hagSystemdArgs({ ...options, runtimeSeconds }, 'owned-hag.service');
    const propertyIndex = leaseArgs.indexOf(`RuntimeMaxSec=${runtimeSeconds}`);
    assert.ok(propertyIndex > 0);
    assert.equal(leaseArgs[propertyIndex - 1], '-p');
  }
  for (const runtimeSeconds of [0, 29, 1801, 30.5, NaN]) {
    assert.throws(() => hagSystemdArgs({ ...options, runtimeSeconds }, 'owned-hag.service'), /30 through 1800/);
  }
});

test('resource admission protects host reserve and temperature while rejecting unavailable samples', () => {
  assert.equal(hagResourceFailure({ available: 16 * 1024 ** 3, temperature: 55 }, true), null);
  assert.match(hagResourceFailure({ available: 3 * 1024 ** 3, temperature: 55 })!, /4 GiB/);
  assert.match(hagResourceFailure({ available: 8 * 1024 ** 3, temperature: 90 })!, /temperature/);
  assert.match(hagResourceFailure({ available: NaN, temperature: 55 })!, /invalid/);
});

test('actual cgroup settings and process controls must match the requested containment', () => {
  const values = { 'memory.max': '6442450944', 'memory.high': '5905580032', 'memory.swap.max': '0',
    'pids.max': '64', 'cpu.max': '25000 100000' };
  const status = 'Name:\tbeholdd\nCpus_allowed_list:\t0-1\nNoNewPrivs:\t1\n';
  assert.doesNotThrow(() => validateHagLimits(values, status));
  for (const key of Object.keys(values)) assert.throws(() => validateHagLimits({ ...values, [key]: 'max' }, status));
  assert.throws(() => validateHagLimits(values, status.replace('0-1', '0-31')), /affinity/);
  assert.throws(() => validateHagLimits(values, status.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0')), /privileges/);
});

const user: Message = { id: 'u', role: 'user', content: 'Say hello.' };
const request: ChatRequest = { providerId: HAG_SOURCE_ID, model: HAG_MODEL_ID, messages: [user], useTools: true };

test('text preview has a fixed minimal prompt, no tools, and preserves complete text history', () => {
  const history: Message[] = [{ id: 'old-system', role: 'system', content: 'large project context' }, user,
    { id: 'a', role: 'assistant', content: 'Hello.' }, { id: 'u2', role: 'user', content: 'What is 1+1?' }];
  const prepared = prepareHagPreview(request, history);
  assert.equal(prepared.messages[0].content, HAG_PREVIEW_SYSTEM);
  assert.deepEqual(prepared.messages.slice(1), history.slice(1)); assert.equal(prepared.useTools, false);
  assert.equal(prepared.tools, undefined); assert.equal(prepared.maxTokens, HAG_PREVIEW_MAX_OUTPUT_TOKENS);
  assert.ok(hagPreviewPromptBound(prepared.messages) + prepared.maxTokens! - 1 <= HAG_PREVIEW_MAX_EVALUATED_TOKENS);
});

test('preview refuses oversized or tool histories instead of compacting them', () => {
  assert.throws(() => prepareHagPreview(request, [{ ...user, content: '界'.repeat(1000) }]), /No history was dropped/);
  assert.throws(() => prepareHagPreview(request, [user, { id: 't', role: 'tool', content: 'secret', toolCallId: 'call' }]), /text-only/);
  assert.throws(() => prepareHagPreview({ ...request, model: 'openmythos' }, [user]), /only Qwen3/);
  assert.throws(() => prepareHagPreview({ ...request, messages: [{ id: 'custom', role: 'system', content: 'Do something else.' }, user] }, [user]), /custom system/);
  assert.throws(() => prepareHagPreview(request, [{ ...user, attachments: [{ path: '/private/file' }] } as Message]), /text-only/);
});

test('provider admission refuses broad agent requests and changed preview output limits', () => {
  assert.throws(() => assertHagPreview(request), /text-only/);
  const preview = prepareHagPreview(request, [user]);
  assert.throws(() => assertHagPreview({ ...preview, maxTokens: 4096 }), /text-only/);
  assert.throws(() => assertHagPreview({ ...preview, tools: [{ type: 'function', function: { name: 'exec', description: '', parameters: {} } }] }), /text-only/);
});

test('persisted attachments and tool histories are refused before wire normalization can erase their metadata', () => {
  assert.doesNotThrow(() => assertHagVisibleHistory([{ ...user, meta: { createdAt: 1 } }]));
  assert.throws(() => assertHagVisibleHistory([{ ...user, attachments: [{ name: 'private.txt', content: 'contents' }] }]), /files/);
  assert.throws(() => assertHagVisibleHistory([{ id: 'a', role: 'assistant', content: 'done', meta: { tools: [{ toolName: 'exec' }] } }]), /tool history/);
});

test('every preview fitting boundary preserves all messages or rejects additional live guidance', () => {
  const preview = prepareHagPreview(request, [user]);
  const fit = fitHagPreview(preview, preview.messages);
  assert.equal(fit.messages, preview.messages); assert.equal(fit.compacted, 0); assert.deepEqual(fit.dropped, []);
  assert.throws(() => fitHagPreview(preview, [...preview.messages, { ...user, id: 'guidance', content: 'x'.repeat(2000) }]), /No history was dropped/);
});
