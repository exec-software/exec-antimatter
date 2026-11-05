/**
 * Explicit live GPU release smoke. Bundle with esbuild for Node before running on the approved host:
 *   esbuild scripts/smoke-hag-release.ts --bundle --platform=node --format=cjs --outfile=/fresh/smoke.cjs
 *   node /fresh/smoke.cjs --output /fresh/evidence --vendor /absolute/vendor/beholdd-hag \
 *     --model /absolute/Qwen3-0.6B-Q8_0.gguf --expected-binary-sha256 HEX
 * Requires the same cool/quiet host window as live HAG qualification. Root owns execution.
 * Task-owned state only; no Electron profile, source store, selection, or external service is changed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ProviderManager } from '../src/api/providers';
import { HAG_MODEL_ID, HAG_SOURCE_ID, prepareHagPreview } from '../src/api/hag';
import type { ChatRequest, Message } from '../src/api/types';
import { HagExperimental, HAG_BASE_URL, HAG_MODEL_BYTES, HAG_MODEL_SHA256, verifyHagModel } from '../src/main/hagExperimental';
import { HagProcessCleanupError, launchHag, validateHagLimits } from '../src/main/hagProcess';
import { selectModel } from '../src/main/modelSelection';
import type { ModelChoice } from '../src/main/modelChoice';
import { parseNativeBeholddInfo } from '../src/main/beholddProtocol';

const exec = promisify(execFile);
const arguments_ = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i], value = process.argv[i + 1];
  assert.ok(['--output', '--vendor', '--model', '--expected-binary-sha256'].includes(name) && value && !arguments_.has(name), 'Pass each documented named argument exactly once.');
  arguments_.set(name, value);
}
assert.equal(arguments_.size, 4);
for (const key of ['--output', '--vendor', '--model']) assert.ok(isAbsolute(arguments_.get(key)!), `${key} must be absolute.`);
const output = resolve(arguments_.get('--output')!);
const vendor = resolve(arguments_.get('--vendor')!);
const modelPath = resolve(arguments_.get('--model')!);
const binary = join(vendor, 'bin', 'beholdd');
const expectedBinary = arguments_.get('--expected-binary-sha256')!;
assert.match(expectedBinary, /^[a-f0-9]{64}$/);
assert.equal(existsSync(output), false, 'Evidence directory must be fresh.');
mkdirSync(output, { recursive: false, mode: 0o700 });
const stateDirectory = join(output, 'state');
mkdirSync(stateDirectory, { mode: 0o700 });
const taskHome = join(output, 'home');
mkdirSync(taskHome, { mode: 0o700 });
writeFileSync(join(stateDirectory, 'settings.json'), JSON.stringify({ version: 1, enabled: false, welcomeSeen: false, modelPath }) + '\n', { mode: 0o600, flag: 'wx' });
const started = Date.now();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error('The live HAG smoke reached its 540-second work deadline.')), 540_000);
const interrupted = () => controller.abort(new Error('The live HAG smoke was interrupted; retiring its owned service.'));
process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
const evidence: Record<string, unknown> = {
  schemaVersion: 1, kind: 'antimatter-experimental-hag-live-release-smoke', qualified: false,
  startedAt: new Date(started).toISOString(), bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  host: readFileSync('/proc/sys/kernel/hostname', 'utf8').trim(), pid: process.pid,
  model: { path: modelPath, bytes: HAG_MODEL_BYTES, sha256: HAG_MODEL_SHA256 },
  binary: { path: binary, expectedSha256: expectedBinary }, serviceLeaseSeconds: 540, outerRequiredDeadlineSeconds: 600,
};
const states: unknown[] = [];
const operations: unknown[] = [];
const requests: unknown[] = [];
const modelChecks: unknown[] = [];
const resourceSamples: unknown[] = [];
const manager = new ProviderManager();
let prepareCount = 0, launchCount = 0, postCount = 0;
let selected: ModelChoice | null = null;
let unit: string | null = null, cgroup: string | null = null, mainPid: number | null = null;
let processStartTicks: string | null = null;
let firstPromptStarted = false;
const realFetch = globalThis.fetch;

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path, { highWaterMark: 1024 * 1024, signal: controller.signal })) hash.update(data);
  return hash.digest('hex');
}

async function command(args: string[]): Promise<string> {
  return (await exec('/usr/bin/systemctl', ['--user', ...args], { timeout: 10_000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout;
}
async function ownedUnits(): Promise<string[]> {
  const text = await command(['list-units', '--all', '--type=service', '--no-legend', '--no-pager', '--plain', `antimatter-hag-${process.pid}-*.service`]);
  return text.trim().split('\n').filter(Boolean).map((line) => line.trim().split(/\s+/)[0]);
}
async function json(path: string): Promise<any> {
  const response = await fetch(`${HAG_BASE_URL}${path}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]), redirect: 'error' });
  assert.equal(response.status, 200);
  return response.json();
}
async function modelState(label: string): Promise<any> {
  const listed = await json('/models');
  assert.equal(listed.data?.length, 1); assert.equal(listed.data[0].id, HAG_MODEL_ID);
  assert.equal(listed.data[0].execution_limits?.max_evaluated_tokens, 16_384);
  modelChecks.push({ label, elapsedMs: Date.now() - started, body: listed });
  return listed.data[0];
}
function captureResources(label: string): void {
  assert.ok(cgroup && mainPid, 'Resource samples require the verified owned service.');
  const files = Object.fromEntries(['memory.current', 'memory.swap.current', 'memory.events', 'pids.current', 'pids.events'].map((name) =>
    [name, readFileSync('/sys/fs/cgroup' + cgroup + '/' + name, 'utf8').trim()]));
  resourceSamples.push({ label, atMs: Date.now() - started, files });
  assert.equal(files['memory.swap.current'], '0');
  for (const name of ['memory.events', 'pids.events']) {
    assert.ok(files[name].split('\n').every((line) => Number(line.split(/\s+/)[1]) === 0), 'No memory or task-limit events are allowed.');
  }
}
async function captureContainment(): Promise<void> {
  const units = await ownedUnits(); assert.equal(units.length, 1, 'Only one task-owned HAG service may exist.'); unit = units[0];
  const facts = Object.fromEntries((await command(['show', unit, '--property=ActiveState,MainPID,ControlGroup,RuntimeMaxUSec,Restart'])).trim().split('\n').map((line) => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  assert.equal(facts.ActiveState, 'active'); assert.equal(facts.Restart, 'no');
  assert.equal(facts.RuntimeMaxUSec, '9min', 'The service must have the shorter smoke lease.');
  mainPid = Number(facts.MainPID); assert.ok(mainPid > 0); cgroup = facts.ControlGroup;
  assert.ok(cgroup.startsWith('/') && !cgroup.split('/').includes('..') && cgroup.endsWith(unit));
  const files = Object.fromEntries(['memory.max', 'memory.high', 'memory.swap.max', 'pids.max', 'cpu.max'].map((name) => [name, readFileSync('/sys/fs/cgroup' + cgroup + '/' + name, 'utf8').trim()]));
  const status = readFileSync(`/proc/${mainPid}/status`, 'utf8'); validateHagLimits(files, status);
  processStartTicks = readFileSync(`/proc/${mainPid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  evidence.containment = { unit, mainPid, cgroup, processStartTicks, systemd: facts, files,
    cpuAffinity: /^Cpus_allowed_list:\s+(.+)$/m.exec(status)?.[1], noNewPrivileges: /^NoNewPrivs:\s+(.+)$/m.exec(status)?.[1] };
  evidence.runtimeConfig = readFileSync(join(stateDirectory, 'config.yaml'), 'utf8');
  captureResources('listener-before-first-prompt');
}

// Observe actual adapter wire requests without replacing the adapter or serving a synthetic peer.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  assert.ok(url.startsWith(HAG_BASE_URL + '/'), 'This smoke may contact only its task-owned loopback HAG endpoint; downloads are not authorized.');
  let observed: Record<string, unknown> | null = null;
  if (init?.method === 'POST') {
    assert.equal(url, HAG_BASE_URL + '/chat/completions');
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, HAG_MODEL_ID); assert.equal(body.stream, true); assert.equal(body.max_tokens, 64);
    assert.equal(body.tools, undefined); assert.equal(body.temperature, 0);
    postCount += 1; assert.ok(postCount <= 2, 'Only two generation requests are permitted.');
    observed = { elapsedMs: Date.now() - started, url, body, sha256: createHash('sha256').update(String(init.body)).digest('hex') };
    requests.push(observed);
  }
  const response = await realFetch(input, init);
  if (observed) {
    observed.response = { status: response.status, contentType: response.headers.get('content-type'), atMs: Date.now() - started };
    try {
      assert.equal(response.status, 200, 'Both generation requests must succeed.');
      assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream(?:;|$)/i, 'The native response must actually stream SSE.');
    } catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
  }
  return response;
}) as typeof fetch;

const hag = new HagExperimental({
  directory: stateDirectory, vendorRoot: vendor, home: taskHome,
  busy: () => manager.busy(HAG_SOURCE_ID),
  register: (source) => { assert.equal(source.id, HAG_SOURCE_ID); manager.addConfig(source); operations.push({ action: 'register', atMs: Date.now() - started }); },
  remove: () => { manager.removeProvider(HAG_SOURCE_ID); operations.push({ action: 'remove', atMs: Date.now() - started }); },
  beforeStart: async () => { assert.equal(firstPromptStarted, true, 'Runtime launch must belong to the first actual prompt.'); },
  changed: (state) => states.push({ atMs: Date.now() - started, state }),
  verifyModel: async (path) => {
    assert.equal(resolve(path), modelPath, 'Only the explicitly supplied pinned checkpoint may be read.');
    const start = Date.now(); await verifyHagModel(path); operations.push({ action: 'verify-model', durationMs: Date.now() - start });
  },
  download: async () => { throw new Error('The supplied checkpoint did not verify; this smoke never downloads a replacement.'); },
  launch: async (options) => {
    launchCount += 1; assert.equal(launchCount, 1);
    const handle = await launchHag({ ...options, runtimeSeconds: 540,
      signal: AbortSignal.any([...(options.signal ? [options.signal] : []), controller.signal]) });
    try {
      await captureContainment();
      const info = parseNativeBeholddInfo(await json('/beholdd/info'));
      assert.ok(info?.execution_backends.includes('hag')); assert.equal(info.operations.unload, true);
      evidence.nativeInfo = info;
      assert.equal((await modelState('listener-before-first-prompt')).loaded, false);
      assert.equal(postCount, 0, 'Discovery must precede the first model-loading request.');
      return handle;
    } catch (error) {
      try { await handle.stop(); }
      catch (cleanup) { throw new HagProcessCleanupError(`${String(error)}; smoke cleanup failed: ${String(cleanup)}`, handle); }
      throw error;
    }
  },
});
manager.usePrepareProvider(async (id) => {
  assert.equal(id, HAG_SOURCE_ID); assert.equal(firstPromptStarted, true); prepareCount += 1;
  await hag.start();
});

async function stream(request: ChatRequest): Promise<string> {
  const provider = manager.getProvider(HAG_SOURCE_ID); assert.ok(provider);
  const began = Date.now(); let text = ''; let chunks = 0;
  const result = await provider.stream(request, (chunk) => { text += chunk.content; if (chunk.content) chunks += 1; }, undefined,
    AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]));
  assert.equal(result.toolCalls.length, 0); assert.ok(text.trim().length > 0, 'Native generation must deliver nonempty text.');
  assert.equal(result.content, text); assert.equal(result.servedModel, HAG_MODEL_ID);
  operations.push({ action: 'stream', durationMs: Date.now() - began, chunks, text, result });
  return text;
}

async function verify(): Promise<void> {
  evidence.binary = { path: binary, expectedSha256: expectedBinary, actualSha256: await sha256(binary) };
  assert.equal((evidence.binary as { actualSha256: string }).actualSha256, expectedBinary);
  assert.deepEqual(await ownedUnits(), []);
  hag.initialize(); assert.equal(hag.state().enabled, false); assert.equal(launchCount, 0);
  await hag.enable(); assert.equal(hag.state().status, 'stopped'); assert.equal(hag.state().showWelcome, false);
  for (let i = 0; i < 3; i++) { assert.equal(hag.readiness().state, 'startable'); assert.equal(hag.state().status, 'stopped'); }
  selected = selectModel(HAG_SOURCE_ID, HAG_MODEL_ID, undefined, {
    source: (id) => manager.getConfig(id), hasWorkload: () => false, save: (choice) => choice, selected: () => {},
  });
  assert.equal(selected.providerId, HAG_SOURCE_ID);
  assert.deepEqual(manager.getProvider(HAG_SOURCE_ID)?.getModels().map((model) => model.id), [HAG_MODEL_ID]);
  assert.equal(prepareCount, 0); assert.equal(launchCount, 0); assert.equal(postCount, 0);
  assert.deepEqual(await ownedUnits(), []);
  evidence.noLoadBeforeFirstPrompt = { initialize: true, enable: true, polling: true, selection: true, ownedUnits: [] };

  const firstUser: Message = { id: 'first-user', role: 'user', content: 'Say hello briefly.' };
  const first = prepareHagPreview({ providerId: HAG_SOURCE_ID, model: HAG_MODEL_ID, messages: [firstUser] }, [firstUser]);
  firstPromptStarted = true;
  const answer = await stream(first);
  assert.equal((await modelState('after-first-prompt')).loaded, true);
  captureResources('after-first-prompt');
  const secondUser: Message = { id: 'second-user', role: 'user', content: 'What is 1 plus 1? Answer briefly.' };
  const history: Message[] = [firstUser, { id: 'first-answer', role: 'assistant', content: answer }, secondUser];
  const second = prepareHagPreview({ providerId: HAG_SOURCE_ID, model: HAG_MODEL_ID, messages: history }, history);
  await stream(second);
  assert.equal((await modelState('after-second-prompt')).loaded, true);
  captureResources('after-second-prompt');
  assert.equal(prepareCount, 2); assert.equal(launchCount, 1); assert.equal(postCount, 2);

  // Exercise the adapter's final admission, not just the caller-side preview helper.
  await assert.rejects(manager.getProvider(HAG_SOURCE_ID)!.stream({ ...first,
    messages: [...first.messages, { id: 'overflow', role: 'user', content: 'x'.repeat(2048) }] }, () => {}, undefined, controller.signal), /No history was dropped/);
  assert.equal(prepareCount, 2); assert.equal(postCount, 2);
  evidence.overBudgetRefusedBeforePreparationAndTransport = true;
  await hag.disable();
  assert.equal(manager.getConfig(HAG_SOURCE_ID), undefined); assert.equal(hag.state().enabled, false);
  assert.equal(hag.state().status, 'disabled'); assert.equal(existsSync(modelPath), true);
  evidence.sourceRemovedAndCheckpointRetained = true;
}

let failure: unknown = null;
async function run(): Promise<void> {
  try { await verify(); }
  catch (error) { failure = error; evidence.error = error instanceof Error ? error.stack ?? error.message : String(error); }
  finally {
    controller.abort(); clearTimeout(timer);
    try {
      await hag.stop(true);
      let remaining = await ownedUnits();
      const retirementDeadline = Date.now() + 5000;
      while (remaining.length && Date.now() < retirementDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 200)); remaining = await ownedUnits();
      }
      assert.deepEqual(remaining, [], 'Task-owned HAG units must retire.');
      if (cgroup && existsSync('/sys/fs/cgroup' + cgroup)) assert.match(readFileSync('/sys/fs/cgroup' + cgroup + '/cgroup.events', 'utf8'), /^populated 0$/m);
      if (mainPid && existsSync(`/proc/${mainPid}/stat`)) {
        assert.notEqual(readFileSync(`/proc/${mainPid}/stat`, 'utf8').split(') ')[1].split(' ')[19], processStartTicks, 'The owned native process is still alive.');
      }
      evidence.retirement = { qualified: true, remainingUnits: remaining, unit, mainPid, cgroup };
    } catch (cleanup) {
      evidence.retirement = { qualified: false, error: String(cleanup), unit, mainPid, cgroup };
      failure ??= cleanup;
    }
    globalThis.fetch = realFetch;
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
    evidence.qualified = failure === null;
    evidence.finishedAt = new Date().toISOString(); evidence.elapsedMs = Date.now() - started;
    evidence.states = states; evidence.operations = operations; evidence.requests = requests; evidence.modelChecks = modelChecks;
    evidence.resourceSamples = resourceSamples;
    writeFileSync(join(output, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify({ qualified: evidence.qualified, result: join(output, 'result.json'), elapsedMs: evidence.elapsedMs }));
  if (failure !== null) process.exitCode = 1;
}
void run().catch((error) => { console.error(error); process.exitCode = 1; });
