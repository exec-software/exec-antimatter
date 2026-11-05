#!/usr/bin/env node
/** Two actual composer submissions through Electron IPC; live transport is explicitly opt-in. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '..');
const reloadBetweenTurns = process.argv.includes('--reload-between-turns');
const restartBetweenTurns = process.argv.includes('--restart-between-turns');
const providerSse = process.argv.includes('--provider-sse');
const remoteTurns = process.argv.includes('--remote-turns');
const liveArgs = process.argv.filter((arg) => arg.startsWith('--live-base-url='));
assert.ok(!process.argv.includes('--live-base-url'), 'live-base-url requires =http://127.0.0.1:PORT/v1');
const liveBaseUrl = liveArgs[0]?.slice('--live-base-url='.length) ?? null;
const prepareLive = process.argv.includes('--prepare-live');
const liveStopReuse = process.argv.includes('--live-stop-reuse');
const liveProfile = liveStopReuse ? 'antimatter-ui-stop-reuse-c2048' : 'antimatter-ui-history-c2048';
assert.ok(!liveStopReuse || liveBaseUrl, 'live-stop-reuse requires live-base-url');
assert.ok(!remoteTurns || (!liveBaseUrl && !providerSse && !restartBetweenTurns && !reloadBetweenTurns), 'remote-turns uses the isolated in-process fixture');
assert.ok(liveArgs.length <= 1, 'choose one live endpoint');
if (liveArgs.length) {
  assert.match(liveBaseUrl, /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/, 'live endpoint must be an explicit 127.0.0.1 HTTP port and /v1 path');
  const endpoint = new URL(liveBaseUrl);
  assert.ok(endpoint.port && Number(endpoint.port) <= 65535, 'live endpoint requires a canonical explicit port');
}
assert.ok(!prepareLive || liveBaseUrl, 'prepare-live requires live-base-url');
const interruptionArgs = process.argv.filter((arg) => arg.startsWith('--interrupt-first='));
const interruptFirst = interruptionArgs[0]?.slice('--interrupt-first='.length) ?? null;
assert.ok(interruptionArgs.length <= 1 && (!interruptionArgs.length || ['cancel', 'error'].includes(interruptFirst)), 'interrupt-first must be cancel or error');
assert.ok(!interruptFirst || providerSse, 'interrupt-first requires provider-sse');
assert.ok(!(reloadBetweenTurns && restartBetweenTurns), 'choose reload or restart, not both');
assert.ok(!liveBaseUrl || (!providerSse && !interruptFirst && !reloadBetweenTurns && !restartBetweenTurns), 'live mode cannot combine with replay, interruption, reload or restart');
const processSeconds = liveBaseUrl ? 355 : 90;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (!process.versions.electron) {
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-hag-conversation-'));
  console.log(`HAG conversation UI smoke output: ${output}`);
  const replyFixture = liveStopReuse ? 'test/fixtures/hag-stop-reuse.json' : 'test/fixtures/hag-generated-history.json';
  const inputs = new Set(['scripts/smoke-hag-conversation.mjs', replyFixture,
    ...(remoteTurns ? ['test/fixtures/remote-turns-ui.mjs'] : []),
    ...(liveBaseUrl ? ['package.json', 'package-lock.json'] : [])]);
  for (const [entry, outfile, platform] of [
    ['src/preload/index.ts', 'preload.cjs', 'node'],
    ['src/main/conversations.ts', 'conversations.cjs', 'node'],
    ['test/fixtures/hag-conversation-renderer.tsx', 'fixture.js', 'browser'],
    ...(providerSse ? [['test/fixtures/hag-conversation-host.ts', 'host.cjs', 'node']] : []),
    ...(liveBaseUrl ? [['test/fixtures/hag-conversation-live-host.ts', 'live-host.cjs', 'node']] : []),
  ]) {
    const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile: path.join(output, outfile),
      bundle: true, platform, format: platform === 'node' ? 'cjs' : 'esm',
      external: platform === 'node' ? ['electron'] : [], metafile: true, logLevel: 'warning' });
    for (const input of Object.keys(result.metafile.inputs)) if (liveBaseUrl || !input.startsWith('node_modules/')) inputs.add(input);
    if (liveBaseUrl) await fs.writeFile(path.join(output, `${outfile}.meta.json`), JSON.stringify(result.metafile, null, 2) + '\n');
  }
  const sources = {};
  for (const input of [...inputs].sort()) sources[input] = createHash('sha256').update(await fs.readFile(path.resolve(root, input))).digest('hex');
  await fs.writeFile(path.join(output, 'source-hashes.json'), JSON.stringify(sources, null, 2) + '\n');
  await fs.copyFile(path.join(root, replyFixture), path.join(output, 'replies.json'));
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
  for (const name of ['config', 'cache', 'state', 'data', 'runtime', 'tmp']) await fs.mkdir(path.join(output, name), { mode: 0o700 });
  const environment = { ELECTRON_RUN_AS_NODE: '',
    XDG_CONFIG_HOME: path.join(output, 'config'), XDG_CACHE_HOME: path.join(output, 'cache'),
    XDG_STATE_HOME: path.join(output, 'state'), XDG_DATA_HOME: path.join(output, 'data'),
    XDG_RUNTIME_DIR: path.join(output, 'runtime'), TMPDIR: path.join(output, 'tmp') };
  const launcher = liveBaseUrl ? path.join(output, 'launcher.mjs') : filename;
  if (liveBaseUrl) {
    await fs.copyFile(filename, launcher);
    const artifacts = {};
    for (const name of (await fs.readdir(output)).sort()) {
      if ((await fs.stat(path.join(output, name))).isFile()) artifacts[name] = sha256(await fs.readFile(path.join(output, name)));
    }
    await fs.writeFile(path.join(output, 'prepared-live.json'), JSON.stringify({
      profile: liveProfile, backendQualified: false, baseUrl: liveBaseUrl,
      processSeconds, requestSeconds: 240, maximumRequests: 2, artifacts,
      command: [electron, '--no-sandbox', '--ozone-platform=headless', launcher, '--fixture', output, `--live-base-url=${liveBaseUrl}`,
        ...(liveStopReuse ? ['--live-stop-reuse'] : [])],
      environment,
    }, null, 2) + '\n');
    if (prepareLive) { console.log('Prepared live client; no endpoint contacted. External containment and admission are required for qualification.'); process.exit(0); }
  }
  // One deadline covers both processes; the second launch cannot reset the budget.
  const endBy = Date.now() + processSeconds * 1000;
  const launch = async (phase) => {
    assert.ok(Date.now() < endBy, `HAG UI smoke exceeded ${processSeconds} seconds`);
    const startedAt = Date.now();
    const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', launcher, '--fixture', output,
      ...(reloadBetweenTurns ? ['--reload-between-turns'] : []),
      ...(providerSse ? ['--provider-sse'] : []),
      ...(remoteTurns ? ['--remote-turns'] : []),
      ...(liveBaseUrl ? [`--live-base-url=${liveBaseUrl}`] : []),
      ...(liveStopReuse ? ['--live-stop-reuse'] : []),
      ...(interruptFirst ? [`--interrupt-first=${interruptFirst}`] : []),
      ...(phase ? ['--restart-between-turns', '--phase', phase] : [])], {
      stdio: 'inherit', env: { ...process.env, ...environment },
    });
    let timedOut = false, killDeadline;
    const deadline = setTimeout(() => {
      timedOut = true; console.error(`HAG UI smoke exceeded ${processSeconds} seconds.`); child.kill();
      killDeadline = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, Math.max(1, endBy - Date.now()));
    try {
      const [code, signal] = await once(child, 'close');
      assert.ok(!timedOut, 'HAG UI smoke timed out');
      assert.equal(signal, null); assert.equal(code, 0, `fixture phase ${phase ?? 'warm/reload'} failed`);
      return { pid: child.pid, startedAt, closedAt: Date.now(), exitCode: code, signal };
    } finally { clearTimeout(deadline); clearTimeout(killDeadline); }
  };
  if (restartBetweenTurns) {
    const firstProcess = await launch('first');
    const first = JSON.parse(await fs.readFile(path.join(output, 'report-first.json'), 'utf8'));
    const disk = await fs.readFile(path.join(output, 'user-data', 'conversations.json'));
    assert.equal(first.passed, true); assert.equal(first.requests.length, 1);
    assert.deepEqual(JSON.parse(disk), first.persisted, 'shutdown must preserve the completed checkpoint');
    const secondProcess = await launch('second');
    const second = JSON.parse(await fs.readFile(path.join(output, 'report-second.json'), 'utf8'));
    assert.equal(second.passed, true); assert.equal(second.requests.length, 1);
    assert.equal(first.process.pid, firstProcess.pid); assert.equal(second.process.pid, secondProcess.pid);
    assert.notEqual(first.process.instanceId, second.process.instanceId);
    assert.notEqual(firstProcess.pid, secondProcess.pid);
    assert.ok(firstProcess.closedAt <= secondProcess.startedAt);
    assert.equal(second.restart.startupFileSha256, sha256(disk), 'second process must start from the untouched disk file');
    const report = { ...second, requests: [...first.requests, ...second.requests],
      providerPipeline: providerSse ? { ...second.providerPipeline,
        turns: [...first.providerPipeline.turns, ...second.providerPipeline.turns] } : null,
      interruption: interruptFirst ? { kind: interruptFirst,
        consoleErrors: [...first.interruption.consoleErrors, ...second.interruption.consoleErrors],
        providerErrors: [...first.interruption.providerErrors, ...second.interruption.providerErrors],
        cancellations: [...first.interruption.cancellations, ...second.interruption.cancellations] } : null,
      checkpointCount: first.checkpointCount + second.checkpointCount,
      hydrationCount: first.hydrationCount + second.hydrationCount,
      channels: [...new Set([...first.channels, ...second.channels])].sort(),
      restart: { ...second.restart, firstProcess, secondProcess, firstInstanceId: first.process.instanceId,
        secondInstanceId: second.process.instanceId, firstClosedBeforeSecondStarted: true,
        completedDiskCheckpointVerified: true, phaseReports: ['report-first.json', 'report-second.json'] } };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('HAG conversation UI smoke passed: full fixture process restart, disk hydration, and second-request identity verified.');
  } else await launch();
} else {
  const { app, BrowserWindow, ipcMain, session } = await import('electron');
  // Also bound a prepared client launched directly by an external stage supervisor.
  setTimeout(() => { console.error('HAG UI process deadline exceeded.'); app.exit(1); }, processSeconds * 1000).unref();
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  const phase = restartBetweenTurns ? process.argv[process.argv.indexOf('--phase') + 1] : null;
  assert.ok(!restartBetweenTurns || ['first', 'second'].includes(phase), 'restart requires a fixture phase');
  const processIdentity = { pid: process.pid, instanceId: randomUUID(), phase };
  const prior = phase === 'second' ? JSON.parse(await fs.readFile(path.join(output, 'report-first.json'), 'utf8')) : null;
  // Read only as evidence. The new store and renderer restore themselves from this file.
  const startupFileSha256 = prior ? sha256(await fs.readFile(path.join(output, 'user-data', 'conversations.json'))) : null;
  app.setPath('userData', path.join(output, 'user-data'));
  app.disableHardwareAcceleration();
  const store = await import(pathToFileURL(path.join(output, 'conversations.cjs')).href);
  store.useStorePath(path.join(output, 'user-data', 'conversations.json'));
  const captured = JSON.parse(await fs.readFile(path.join(output, 'replies.json'), 'utf8'));
  const model = captured.turns[0].request.model;
  const provider = { id: 'hag-ui-fixture', name: 'HAG fixture', kind: 'beholdd', protocol: 'openai-chat',
    baseUrl: liveBaseUrl ?? 'http://hag-ui.invalid/v1', credentialConfigured: false, supportsStreaming: true,
    models: [{ id: model, name: model }] };
  const expectedProviderError = `${provider.name} stream failed: fixture stream failure (fixture_error)`;
  const replyText = (turn) => {
    const raw = liveStopReuse && turn === 0 ? providerHost.records[0]?.contentChunks.join('') ?? ''
      : captured.turns[turn].response.choices[0].message.content;
    return interruptFirst && turn === 0 ? raw.slice(0, -1) : raw;
  };
  const completedText = (turn) => replyText(turn) + (liveStopReuse && turn === 0 ? '\n\n_Stopped._' : interruptFirst && turn === 0
    ? interruptFirst === 'cancel' ? '\n\n_Stopped._' : `\n\nError: ${expectedProviderError}` : '');
  const expectedMessages = (turn) => captured.turns[turn].request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => message.role === 'assistant' && (interruptFirst || liveBaseUrl)
      ? { ...message, content: liveBaseUrl ? providerHost.records[0].result.content : completedText(0) } : message);
  const appearance = { theme: 'dark', promptDock: false };
  const person = { name: 'Fixture', pronouns: '', about: '', updatedAt: 1 };
  const requests = [], pending = [], errors = [], channels = [], checkpoints = [], loads = [], rendererCheckpoints = [];
  const consoleErrors = [], providerErrors = [], cancellations = [];
  const remoteControls = [];
  let hydrationDelay = null;
  const delayHydration = (kind, value) => {
    if (!hydrationDelay) return value;
    hydrationDelay.reads[kind] += 1;
    return kind === 'ownership' ? hydrationDelay.ready.then(() => value) : value;
  };
  const holdHydration = () => {
    let release;
    const ready = new Promise((resolve) => { release = resolve; });
    const reads = { ownership: 0, conversations: 0 };
    hydrationDelay = { ready, reads };
    return { reads, release: () => { hydrationDelay = null; release(); } };
  };
  let reload = null, restart = null, stopReuse = null;
  let window;
  const providerHost = providerSse
    ? (await import(pathToFileURL(path.join(output, 'host.cjs')).href)).createProviderHost(
      path.join(output, 'user-data'), provider, captured, (channel, payload) => window.webContents.send(channel, payload), interruptFirst)
    : liveBaseUrl ? (await import(pathToFileURL(path.join(output, 'live-host.cjs')).href)).createLiveProviderHost(
      path.join(output, 'user-data'), provider, captured, (channel, payload) => window.webContents.send(channel, payload),
      liveStopReuse ? 'stop-reuse' : 'history') : null;
  const authorize = (event) => {
    assert.equal(event.sender, window.webContents);
    assert.equal(event.senderFrame, window.webContents.mainFrame);
  };
  const handle = (channel, answer) => ipcMain.handle(channel, (event, ...args) => {
    authorize(event); channels.push(channel); return answer(...args);
  });
  ipcMain.on('appearance:initial', (event) => { authorize(event); event.returnValue = appearance; });
  const responses = {
    'appearance:get': appearance,
    'detached:list': [],
    'setup:get': { assistant: { name: 'Antimatter', personality: '' }, completedAt: 1, showOnStartup: false },
    'providers:list': [provider], 'providers:readiness': { state: 'ready' },
    'chat:remote-turns-get': { revision: 0, turns: [] },
    'model:get': { providerId: provider.id, modelId: model }, 'user:get': person,
    'mcp:workspaceState': { path: null, confirmed: true }, 'mcp:setWorkspace': null,
    'bot-chat:state': { enabled: false, generation: 0, channels: [], targets: [] },
    'memory:state': { settings: { enabled: false, instructions: false }, person, location: '', workspace: '', current: '',
      project: { root: '', directory: '', notes: [], instructions: [] }, user: { directory: '', notes: [] }, projects: [] },
    'notifications:turnFinished': { sound: null }, 'hub:downloads': [],
    'updates:state': { install: { kind: 'development' } },
    'agents:list': [], 'agents:tasks': [],
    'agents:activity': { active: [], counts: { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 }, busy: false },
    'snitch:config': { root: null }, 'snitch:projects': [], 'snitch:pipeline': [],
  };
  for (const [channel, value] of Object.entries(responses)) handle(channel, () =>
    channel === 'chat:remote-turns-get' ? delayHydration('ownership', structuredClone(value)) : structuredClone(value));
  handle('model:set', (providerId, modelId) => ({ providerId, modelId }));
  handle('chat-coordination:state', (threadId) => ({ threadId, workspace: null, peers: [], messages: [] }));
  handle('conversations:load', () => {
    // Reset at the read boundary: a beforeunload save could repopulate an earlier-cleared cache.
    store.useStorePath(store.location());
    const loaded = store.load(); loads.push(structuredClone(loaded)); return delayHydration('conversations', loaded);
  });
  handle('conversations:save', (next) => {
    // A conflict can preserve the host's good copy even when a renderer sends broken history.
    rendererCheckpoints.push(structuredClone(next));
    const saved = store.save(next); checkpoints.push(structuredClone(saved)); return saved;
  });
  handle('chat:stream', (request) => {
    assert.ok(requests.length < (phase ? 1 : 2), 'unexpected extra fixture request');
    requests.push(structuredClone(request));
    if (providerHost) return providerHost.stream(request, (prior ? 1 : 0) + requests.length - 1)
      .catch((error) => {
        if (providerHost.records.at(-1)?.outcome === 'error' && error.message === expectedProviderError) providerErrors.push(error.message);
        else errors.push(String(error));
        throw error;
      });
    return new Promise((resolve) => pending.push(resolve));
  });
  handle('chat:cancel', (runId) => {
    if (remoteTurns) { remoteControls.push({ kind: 'cancel', runId }); return true; }
    assert.ok(providerHost, 'cancellation requires the provider fixture');
    const accepted = providerHost.cancel(runId); cancellations.push({ runId, accepted }); return accepted;
  });
  if (remoteTurns) handle('chat:steer', (runId, text, now) => {
    remoteControls.push({ kind: 'steer', runId, text, now }); return true;
  });

  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`hag-conversation-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    window = new BrowserWindow({ show: false, width: 1280, height: 900,
      webPreferences: { session: isolated, preload: path.join(output, 'preload.cjs'),
        nodeIntegration: false, contextIsolation: true, sandbox: false, offscreen: true, backgroundThrottling: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('console-message', (event) => {
      if (event.level !== 'error') return;
      if (interruptFirst === 'error' && providerErrors.length === 1
          && event.message.startsWith('Stream failed:') && event.message.endsWith(expectedProviderError)) consoleErrors.push(event.message);
      else errors.push(event.message);
    });
    window.webContents.on('preload-error', (_event, _file, error) => errors.push(String(error)));
    window.webContents.on('render-process-gone', (_event, detail) => errors.push(JSON.stringify(detail)));
    const run = (code) => window.webContents.executeJavaScript(code);
    const waitFor = async (description, predicate, milliseconds = 15_000) => {
      const deadline = Date.now() + milliseconds;
      while (Date.now() < deadline) {
        assert.deepEqual(errors, [], `renderer errors while waiting for ${description}`);
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out: ${description}`);
    };
    const storedMessages = (threadId) => store.load().threads.find((thread) => thread.id === threadId)?.messages ?? [];
    const fillComposer = (text) =>
      run(`(() => { const input = document.querySelector('textarea[aria-label="Message"]');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const submit = async (text) => {
      await fillComposer(text);
      await waitFor('enabled composer send button', () => run('Boolean(document.querySelector(\'[aria-label="Send message"]\') && !document.querySelector(\'[aria-label="Send message"]\').disabled)'));
      await run('document.querySelector(\'[aria-label="Send message"]\').click()');
    };
    const verifyRestoration = async (saved, beforeLoads, beforeCheckpoints, expectedRequests) => {
      await waitFor('fresh disk hydration', () => loads.length > beforeLoads);
      // StrictMode can load twice; require fresh reads without depending on their exact count.
      for (const restored of loads.slice(beforeLoads)) {
        assert.equal(restored.activeThreadId, saved.id);
        assert.deepEqual(restored.threads.find((thread) => thread.id === saved.id).messages, saved.messages);
      }
      await waitFor('restored reply and idle composer', () => run(`(() => {
        const replies = [...document.querySelectorAll('article[aria-label$=" response"]')];
        return replies.length === 1 && replies[0].textContent.includes(${JSON.stringify(interruptFirst ? 'ready' : 'ready.')})
          && Boolean(document.querySelector('[aria-label="Send message"]'));
      })()`));
      assert.equal(requests.length, expectedRequests, 'restoration must not start inference');
      const draft = captured.turns[1].request.messages.at(-1).content;
      await fillComposer(draft);
      // This draft is typed only after restoration. Inspect the incoming renderer payload,
      // not store.save's reply, which could retain good host state after a conflict.
      const restoredCheckpoint = () => rendererCheckpoints.slice(beforeCheckpoints)
        .find((checkpoint) => checkpoint.activeThreadId === saved.id && checkpoint.drafts[saved.id]?.text === draft);
      await waitFor('checkpoint from restored renderer', () => Boolean(restoredCheckpoint()));
      const restored = restoredCheckpoint().threads.find((thread) => thread.id === saved.id);
      const history = (messages) => messages.map(({ id, role, content, meta }) => ({ id, role, content,
        createdAt: meta?.createdAt, finishedAt: meta?.finishedAt, chunks: meta?.chunks, failed: meta?.failed }));
      assert.deepEqual(history(restored.messages), history(saved.messages));
      assert.equal(requests.length, expectedRequests, 'restoration and drafting must not start inference');
      return { beforeLoads, afterLoads: loads.length, activeThreadId: saved.id,
        restoredMessages: restored.messages, draft, incomingCheckpointVerified: true };
    };
    try {
      await window.loadFile(path.join(output, 'index.html'));
      await waitFor('hydrated editor', async () => checkpoints.length > 0 && await run('Boolean(document.querySelector(\'textarea[aria-label="Message"]\'))'));
      if (prior) {
        assert.equal(prior.passed, true); assert.equal(prior.requests.length, 1);
        const saved = prior.persisted.threads.find((thread) => thread.id === prior.requests[0].threadId);
        restart = { startupFileSha256, ...await verifyRestoration(saved, 0, 0, 0) };
      }
      const firstTurn = prior ? 1 : 0, endTurn = phase === 'first' ? 1 : 2;
      for (let turn = firstTurn; turn < endTurn; turn++) {
        const requestIndex = turn - firstTurn;
        const fixture = captured.turns[turn];
        await submit(fixture.request.messages.at(-1).content);
        await waitFor(`turn ${turn + 1} IPC request`, () => requests.length === requestIndex + 1);
        const request = requests[requestIndex];
        assert.equal(request.model, model); assert.equal(request.providerId, provider.id);
        assert.equal(request.responseMessageId, request.requestId);
        assert.equal(request.maxTokens, undefined); assert.equal(request.useTools, true);
        assert.deepEqual(request.messages.map(({ role, content }) => ({ role, content })), expectedMessages(turn));
        assert.ok(request.messages.every((message) => Object.keys(message).sort().join(',') === 'content,id,role'));
        if (turn && !liveStopReuse) {
          const firstRequest = prior ? prior.requests[0] : requests[0];
          assert.equal(request.threadId, firstRequest.threadId);
          assert.notEqual(request.requestId, firstRequest.requestId);
          assert.equal(request.messages[0].id, firstRequest.messages[0].id);
          assert.equal(request.messages[1].id, firstRequest.requestId);
        }
        let raw = replyText(turn);
        const chunks = [raw.slice(0, 3), raw.slice(3, 14), raw.slice(14)];
        if (liveStopReuse && turn === 0) {
          await waitFor('visible live numeric content and Stop button', async () => {
            const record = providerHost.records[0];
            assert.ok(!record?.settled, 'first live request finished before Stop');
            return record?.contentChunks.length > 0 && await run(`(() => {
              const reply = document.querySelector('article[aria-label$=" response"] .font-chat-surface');
              return Boolean(reply && reply.getClientRects().length && /\\d/.test(reply.innerText) && document.querySelector('[aria-label="Stop generating"]'));
            })()`);
          }, 240_000);
          const record = providerHost.records[0];
          assert.equal(record.transportClosed, false);
          assert.equal(record.responseEof, false);
          stopReuse = { firstThreadId: request.threadId, firstRequestId: request.requestId,
            stop: await run(`(() => {
              const reply = document.querySelector('article[aria-label$=" response"] .font-chat-surface');
              const button = document.querySelector('[aria-label="Stop generating"]');
              if (!reply || !reply.getClientRects().length || !/\\d/.test(reply.innerText) || !button) throw new Error('Stop requires visible numeric content');
              const evidence = { clickedAt: Date.now(), visibleTextBeforeStop: reply.innerText };
              button.click(); return evidence;
            })()`) };
          await waitFor('stopped live transport settled', () => record.settled && providerHost.idle());
          assert.equal(record.completed, false); assert.equal(record.outcome, 'cancelled');
          assert.equal(record.cancelRequests, 1); assert.equal(record.abortObserved, true);
          assert.equal(record.transportClosed, true); assert.equal(record.responseEof, false);
          assert.equal(record.result, null); assert.ok(record.checkpointed > 0);
          raw = record.contentChunks.join('');
        } else if (liveBaseUrl) {
          // Actual transport owns all content and completion. In particular JSON fallback
          // can complete before the renderer saves a separate streaming checkpoint.
          await waitFor('live provider settled', () => providerHost.records[turn]?.settled && providerHost.idle(), 245_000);
          const record = providerHost.records[turn];
          assert.equal(record.completed, true); assert.equal(record.outcome, 'finished');
          assert.equal(record.result.content, raw);
          assert.equal(record.contentChunks.join(''), raw);
          assert.ok(record.contentChunks.length > 0);
        } else {
          window.webContents.send('chat:stream-data', { id: 'unrelated-run', content: 'DO NOT INCLUDE' });
          if (providerHost) {
            await waitFor('provider SSE transport', () => providerHost.ready(turn));
            providerHost.emitContent(turn);
          } else {
            window.webContents.send('chat:reasoning', { id: request.requestId, content: 'SEPARATE REASONING MUST NOT BECOME HISTORY' });
            for (const content of chunks) window.webContents.send('chat:stream-data', { id: request.requestId, content });
          }
          await waitFor('streamed reply checkpoint', () => storedMessages(request.threadId).at(-1)?.content === raw);
          await waitFor('visible assistant reply', () => run(`(() => {
            const replies = [...document.querySelectorAll('article[aria-label$=" response"]')];
            return replies.length === ${turn + 1} && replies.at(-1).textContent.includes(${JSON.stringify(interruptFirst && turn === 0 ? 'ready' : 'ready.')});
          })()`));
          assert.deepEqual(storedMessages(request.threadId).map((message) => message.id), [...request.messages.map((message) => message.id), request.requestId]);
          const streaming = storedMessages(request.threadId).at(-1);
          assert.equal(streaming.id, request.requestId); assert.equal(streaming.meta.chunks, chunks.length);
          assert.equal(streaming.meta.finishedAt, undefined);
          assert.equal(await run('Boolean(document.querySelector(\'[aria-label="Stop generating"]\'))'), true);
          // Resolving chat:stream is the preload completion signal. In SSE mode only the
          // production provider/loop can resolve it, after consuming the released terminal frame.
          if (providerHost) {
            assert.equal(providerHost.records.at(-1).completed, false);
            if (interruptFirst && turn === 0) {
              if (interruptFirst === 'cancel') await run('document.querySelector(\'[aria-label="Stop generating"]\').click()');
              else providerHost.fail(turn);
              await waitFor('interrupted provider settled', () => providerHost.records.at(-1).settled && providerHost.idle());
            } else providerHost.complete(turn);
          } else pending[requestIndex]();
        }
        await waitFor('completed reply checkpoint', () => Boolean(storedMessages(request.threadId).at(-1)?.meta.finishedAt));
        await waitFor('released composer', () => run('Boolean(document.querySelector(\'[aria-label="Send message"]\'))'));
        const finished = storedMessages(request.threadId).at(-1);
        assert.equal(finished.content, completedText(turn));
        assert.equal(finished.meta.failed, interruptFirst === 'error' && turn === 0);
        assert.equal(finished.meta.chunks, liveBaseUrl ? providerHost.records[turn].contentChunks.length + (liveStopReuse && turn === 0 ? 1 : 0)
          : chunks.length + (interruptFirst === 'cancel' && turn === 0 ? 1 : 0));
        assert.ok(finished.meta.finishedAt >= finished.meta.createdAt);
        if (liveBaseUrl) {
          assert.deepEqual(storedMessages(request.threadId).map((message) => message.id), [...request.messages.map((message) => message.id), request.requestId]);
          await waitFor('visible live assistant reply', () => run(`(() => {
            const replies = [...document.querySelectorAll('article[aria-label$=" response"]')];
            return replies.length === ${liveStopReuse ? 1 : turn + 1}
              && replies.at(-1).textContent.includes(${JSON.stringify(liveStopReuse && turn === 0 ? 'Stopped.' : 'ready.')});
          })()`));
          const incoming = () => rendererCheckpoints.find((checkpoint) => checkpoint.threads
            .find((thread) => thread.id === request.threadId)?.messages.at(-1)?.id === request.requestId
            && checkpoint.threads.find((thread) => thread.id === request.threadId).messages.at(-1)?.meta.finishedAt);
          await waitFor('completed live renderer checkpoint', () => Boolean(incoming()));
          assert.deepEqual(incoming().threads.find((thread) => thread.id === request.threadId).messages,
            storedMessages(request.threadId));
        }
        if (providerHost) {
          const record = providerHost.records.at(-1);
          assert.equal(record.completed, !((interruptFirst || liveStopReuse) && turn === 0));
          assert.equal(record.outcome, liveStopReuse && turn === 0 ? 'cancelled'
            : interruptFirst && turn === 0 ? interruptFirst === 'cancel' ? 'cancelled' : 'error' : 'finished');
          assert.equal(record.settled, true); assert.equal(record.transportClosed, true);
          if (!liveBaseUrl) assert.equal(record.abortListenerRemoved, true);
          if (interruptFirst && turn === 0) {
            assert.equal(record.completionReleased, false); assert.equal(record.result, null); assert.ok(record.checkpointed > 0);
            assert.equal(record.cancelRequests, interruptFirst === 'cancel' ? 1 : 0);
            assert.equal(record.abortObserved, interruptFirst === 'cancel');
            assert.equal(record.bodyCancelled, interruptFirst === 'error');
            await waitFor('visible interruption notice', () => run(`document.body.textContent.includes(${JSON.stringify(interruptFirst === 'cancel' ? 'Stopped.' : expectedProviderError)})`));
          }
        }
        if (liveStopReuse && turn === 0) {
          await waitFor('visible Stop notice', () => run("document.body.textContent.includes('Stopped.')"));
          stopReuse.stoppedCheckpoint = structuredClone(finished);
          stopReuse.newChatClickedAt = await run(`(() => {
            const buttons = [...document.querySelectorAll('button')].filter((button) => button.textContent.trim() === 'New chat');
            if (buttons.length !== 1) throw new Error('Expected the actual New chat button');
            const clickedAt = Date.now(); buttons[0].click(); return clickedAt;
          })()`);
          await waitFor('fresh empty conversation checkpoint', () => {
            const saved = store.load();
            return saved.activeThreadId !== request.threadId
              && saved.threads.find((thread) => thread.id === saved.activeThreadId)?.messages.length === 0;
          });
          const saved = store.load();
          stopReuse.secondThreadId = saved.activeThreadId;
          stopReuse.freshCheckpoint = structuredClone(saved.threads.find((thread) => thread.id === saved.activeThreadId));
          assert.equal(requests.length, 1, 'New chat must not dispatch inference');
          await waitFor('fresh empty conversation view', () => run(`document.querySelectorAll('article[aria-label$=" response"]').length === 0
            && Boolean(document.querySelector('[aria-label="Send message"]'))`));
        }
        if (reloadBetweenTurns && turn === 0) {
          const disk = JSON.parse(await fs.readFile(store.location(), 'utf8'));
          const saved = disk.threads.find((thread) => thread.id === request.threadId);
          const beforeLoads = loads.length, beforeCheckpoints = rendererCheckpoints.length;
          const documentMarker = await run('globalThis.hagReloadMarker = crypto.randomUUID()');
          const loaded = once(window.webContents, 'did-finish-load');
          window.webContents.reload();
          await loaded;
          assert.equal(await run('globalThis.hagReloadMarker'), undefined, 'the old renderer world must be gone');
          reload = { documentMarker, freshDocument: true, ...await verifyRestoration(saved, beforeLoads, beforeCheckpoints, 1) };
        }
      }
      assert.equal(requests.length, phase ? 1 : 2);
      assert.equal(Boolean(reload), reloadBetweenTurns);
      assert.equal(Boolean(restart), phase === 'second');
      const persisted = JSON.parse(await fs.readFile(store.location(), 'utf8'));
      if (liveStopReuse) {
        assert.equal(requests[1].threadId, stopReuse.secondThreadId);
        assert.notEqual(requests[1].threadId, requests[0].threadId);
        assert.equal(requests[1].messages.length, 1);
        assert.equal(providerHost.records[1].resumed, false);
        assert.deepEqual(persisted.threads.find((thread) => thread.id === requests[0].threadId).messages
          .map(({ role, content }) => ({ role, content })), [
          ...expectedMessages(0), { role: 'assistant', content: completedText(0) },
        ]);
      }
      assert.deepEqual(persisted.threads.find((thread) => thread.id === requests.at(-1).threadId).messages.map(({ role, content }) => ({ role, content })), [
        ...expectedMessages(endTurn - 1),
        { role: 'assistant', content: completedText(endTurn - 1) },
      ]);
      assert.deepEqual(errors, []);
      const interruptedHere = interruptFirst && !prior;
      assert.equal(consoleErrors.length, interruptedHere && interruptFirst === 'error' ? 1 : 0);
      assert.equal(providerErrors.length, consoleErrors.length);
      assert.deepEqual(cancellations, liveStopReuse || interruptedHere && interruptFirst === 'cancel' ? [{ runId: requests[0].requestId, accepted: true }] : []);
      if (providerHost) {
        assert.equal(providerHost.records.length, requests.length);
        assert.ok(providerHost.records.every((record) => record.settled && record.outcome && record.wire
          && record.transportFragments >= (liveBaseUrl ? 1 : 4)));
        assert.equal(providerHost.idle(), true);
      }
      const report = { passed: true, actualApp: true, actualPreload: true, actualConversationStore: true,
        networkBlocked: !liveBaseUrl, rendererNetworkBlocked: true, hardwareAcceleration: false,
        modelExecution: liveBaseUrl ? 'external-endpoint-unverified' : false, versions: process.versions, requests,
        persisted, checkpointCount: checkpoints.length, hydrationCount: loads.length, reload, restart, process: processIdentity,
        providerPipeline: providerHost ? { transport: liveBaseUrl ? 'loopback-http' : 'in-process-sse-fixture', turns: providerHost.records } : null,
        live: liveBaseUrl ? { profile: liveProfile, baseUrl: liveBaseUrl,
          backendQualified: false, processSeconds, requestSeconds: 240, maximumRequests: 2 } : null,
        interruption: liveStopReuse || interruptFirst ? { kind: liveStopReuse ? 'cancel' : interruptFirst, consoleErrors, providerErrors, cancellations } : null,
        stopReuse,
        channels: [...new Set(channels)].sort(),
        captureProvenance: captured.provenance };
      if (remoteTurns) {
        const { exerciseRemoteTurns } = await import('../test/fixtures/remote-turns-ui.mjs');
        report.remoteTurns = await exerciseRemoteTurns({ store, window, run, waitFor, fillComposer,
          threadId: requests.at(-1).threadId, provider, model, remoteControls,
          snapshot: responses['chat:remote-turns-get'], requests, rendererCheckpoints, holdHydration });
      }
      await fs.writeFile(path.join(output, phase ? `report-${phase}.json` : 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(phase ? `HAG conversation UI smoke phase ${phase} passed.`
        : liveStopReuse ? 'HAG live Stop/reuse client passed: actual Stop after visible content, aborted transport, and fresh conversation reuse.'
        : `HAG conversation UI smoke passed: two composer submissions, real preload IPC, chunk routing, completion, durable raw history, and second-request identity${reload ? '; renderer reload and disk hydration verified' : ''}.`);
      if (providerHost) { console.log('Production request preparation, tool loop, provider transport and transcript checks passed.'); providerHost.dispose(); }
      window.destroy(); app.exit(0);
    } catch (error) {
      providerHost?.dispose();
      console.error(error, errors);
      await fs.writeFile(path.join(output, phase ? `failure-${phase}.json` : 'failure.json'), JSON.stringify({ error: String(error), errors, consoleErrors, providerErrors, cancellations, requests, channels, reload, restart, stopReuse, process: processIdentity, loads, rendererCheckpoints, providerPipeline: providerHost?.records,
        text: window.isDestroyed() ? null : await run('document.body.textContent').catch(() => null) }, null, 2));
      window.destroy(); app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
