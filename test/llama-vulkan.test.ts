import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MODEL_ENV,
  MODEL_ID,
  BUNDLED_BEHOLDD_SOURCE_ID,
  SOURCE_ID,
  SOURCE_NAME,
  LifecycleQueue,
  ownedConnection,
  connectionFor,
  configuredModelPath,
  isLiveCandidate,
  isExpectedModelList,
  managedSourceConflict,
  ownsProcessGeneration,
  processGroupTarget,
  renderPreset,
  routerArguments,
  sourceConfig,
  terminateProcessGroup,
} from '../src/main/llamaVulkan';

test('requires an absolute, single-line installer model path', () => {
  assert.equal(configuredModelPath({}), null);
  assert.throws(() => configuredModelPath({ [MODEL_ENV]: 'models/qwen.gguf' }), /absolute path/);
  assert.throws(() => configuredModelPath({ [MODEL_ENV]: '/models/qwen.gguf\nother' }), /cannot be written/);
  assert.equal(configuredModelPath({ [MODEL_ENV]: '/models/qwen.gguf' }), '/models/qwen.gguf');
});

test('renders one lazy Vulkan-only router preset', () => {
  const preset = renderPreset('/models/qwen.gguf');
  assert.match(preset, new RegExp(`\\[${MODEL_ID}\\]`));
  assert.match(preset, /model = \/models\/qwen\.gguf/);
  assert.match(preset, /device = Vulkan0/);
  assert.doesNotMatch(preset, /n-gpu-layers/);
  assert.match(preset, /load-on-startup = false/);
  assert.doesNotMatch(preset, /api-key|load-on-startup = true/);
});

test('binds the router to loopback and keeps its random credential out of argv', () => {
  const args = routerArguments('/private/models.ini', '/private/api-key');
  assert.deepEqual(args.slice(args.indexOf('--host'), args.indexOf('--host') + 2), ['--host', '127.0.0.1']);
  assert.deepEqual(args.slice(args.indexOf('--models-max'), args.indexOf('--models-max') + 2), [
    '--models-max',
    '1',
  ]);
  assert.ok(args.includes('--models-autoload'));
  assert.ok(args.includes('--no-webui'));
  assert.deepEqual(args.slice(args.indexOf('--api-key-file'), args.indexOf('--api-key-file') + 2), [
    '--api-key-file',
    '/private/api-key',
  ]);
  assert.equal(args.includes('--api-key'), false);
});

test('publishes the compatibility identity without pretending it is native Beholdd', () => {
  const source = sourceConfig({ [MODEL_ENV]: process.execPath });
  assert.equal(source?.id, SOURCE_ID);
  assert.equal(source?.name, SOURCE_NAME);
  assert.equal(source?.kind, 'llama-cpp');
  assert.equal(source?.apiKey, '');
  assert.equal(source?.baseUrl, 'http://127.0.0.1:6769/v1');
  assert.deepEqual(source?.models.map((model) => model.id), [MODEL_ID]);
  assert.equal(source?.models[0].contextWindow, 8_192);
  assert.equal(sourceConfig({ [MODEL_ENV]: '/definitely/missing/qwen.gguf' }), null);
});

test('readiness cannot outlive or switch away from the child that was spawned', () => {
  const live = { exitCode: null, signalCode: null } as unknown as import('node:child_process').ChildProcess;
  const other = { exitCode: null, signalCode: null } as unknown as import('node:child_process').ChildProcess;
  assert.equal(isLiveCandidate(live, live), true);
  assert.equal(isLiveCandidate(live, other), false);
  (live as { exitCode: number | null }).exitCode = 1;
  assert.equal(isLiveCandidate(live, live), false);
});

test('accepts readiness only from a model list containing the configured router entry', () => {
  assert.equal(
    isExpectedModelList(200, JSON.stringify({ object: 'list', data: [{ id: MODEL_ID, object: 'model' }] })),
    true
  );
  assert.equal(isExpectedModelList(200, JSON.stringify({ object: 'list', data: [] })), false);
  assert.equal(isExpectedModelList(200, JSON.stringify({ object: 'list', data: [{ id: 'other' }] })), false);
  assert.equal(isExpectedModelList(401, JSON.stringify({ object: 'list', data: [{ id: MODEL_ID }] })), false);
  assert.equal(isExpectedModelList(200, '<html>occupied</html>'), false);
  assert.equal(isExpectedModelList(200, JSON.stringify({ object: 'list', data: [{ id: 'mimo-v26-flash-mxfp4' }] }), 'mimo-v26-flash-mxfp4'), true);
  assert.equal(isExpectedModelList(200, JSON.stringify({ object: 'list', data: [{ id: MODEL_ID }] }), 'mimo-v26-flash-mxfp4'), false);
});

test('managed lifecycle transitions serialize and a failed transition does not poison the next', async () => {
  const queue = new LifecycleQueue();
  const events: string[] = [];
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const first = queue.run(async () => { events.push('first-start'); await gate; events.push('first-end'); });
  const second = queue.run(async () => { events.push('second-start'); throw new Error('unavailable model'); });
  const rejection = assert.rejects(second, /unavailable model/);
  const third = queue.run(async () => { events.push('third-start'); return 'ready'; });
  await Promise.resolve();
  assert.deepEqual(events, ['first-start']);
  finish();
  await first;
  await rejection;
  assert.equal(await third, 'ready');
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'third-start']);
});

test('addresses and terminates the whole detached Unix process group', async () => {
  assert.equal(processGroupTarget(1234, 'linux'), -1234);
  assert.equal(processGroupTarget(1234, 'win32'), 1234);

  let alive = true;
  const signals: Array<NodeJS.Signals | 0> = [];
  const signal = (pid: number, value: NodeJS.Signals | 0) => {
    assert.equal(pid, -1234);
    signals.push(value);
    if (value === 'SIGKILL') alive = false;
    if (value === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  };

  assert.equal(await terminateProcessGroup(1234, 1, 10, signal), true);
  assert.equal(signals[0], 'SIGTERM');
  assert.ok(signals.includes('SIGKILL'));
});

test('a retired process generation cannot clear a replacement credential even if its pid is reused', () => {
  assert.equal(ownsProcessGeneration(4, 1234, 4, 1234), true);
  assert.equal(ownsProcessGeneration(4, 1234, 5, 1234), false);
  assert.equal(ownsProcessGeneration(4, 1234, 4, 5678), false);
});

test('managed source switches refuse to kill a provider with a request in flight', () => {
  assert.match(
    managedSourceConflict(SOURCE_ID, (id) => id === BUNDLED_BEHOLDD_SOURCE_ID) ?? '',
    /native.*serving a request/
  );
  assert.match(
    managedSourceConflict('remote-source', (id) => id === SOURCE_ID) ?? '',
    /Vulkan.*serving a request/
  );
  assert.equal(managedSourceConflict(SOURCE_ID, () => false), null);
  assert.equal(managedSourceConflict(BUNDLED_BEHOLDD_SOURCE_ID, () => false), null);
});

test('inspection exposes only the ready, owned, matching router connection', () => {
  const state = {
    model: { sourceId: 'workload-mimo', modelId: 'mimo', modelPath: '/models/mimo.gguf', preset: '[mimo]' },
    ready: true, child: { pid: 1234, exitCode: null, signalCode: null }, groupPid: 1234, groupAlive: true, apiKey: 'ephemeral-key',
  };
  assert.deepEqual(ownedConnection('workload-mimo', state), { baseUrl: 'http://127.0.0.1:6769/v1', apiKey: 'ephemeral-key', modelId: 'mimo' });
  assert.equal(ownedConnection('workload-other', state), null);
  for (const patch of [
    { ready: false }, { apiKey: null }, { child: null }, { groupPid: null }, { groupPid: 9999 },
    { groupAlive: false }, { child: { pid: 1234, exitCode: 1, signalCode: null } },
    { child: { pid: 1234, exitCode: null, signalCode: 'SIGTERM' as const } },
  ]) assert.equal(ownedConnection('workload-mimo', { ...state, ...patch }), null);
  assert.equal(connectionFor(SOURCE_ID), null, 'an unstarted router is never adopted by an inspection');
});
