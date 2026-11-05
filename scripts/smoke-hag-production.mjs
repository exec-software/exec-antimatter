#!/usr/bin/env node
/** Real production main/preload/App IPC, with isolated state and a bounded synthetic HTTP peer.
 * Add --full-catalog for 45-tool composer admission/refusal; neither mode runs inference or tools.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { tmpdir } from 'node:os';

const filename = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(filename), '..');
const outputIndex = process.argv.indexOf('--output');
assert.ok(outputIndex >= 0 && process.argv[outputIndex + 1], 'Pass --output /absolute/fresh/directory');
const output = process.argv[outputIndex + 1];
assert.ok(path.isAbsolute(output), 'Output must be absolute');
const fullCatalogMode = process.argv.includes('--full-catalog');
const fullCatalogChats = [
  { id: 'hag-catalog-accepted', title: 'HAG full catalog accepted' },
  { id: 'hag-catalog-refused', title: 'HAG full catalog refused' },
];
const fullCatalogPrompt = 'Reply exactly ready.';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
const processSeconds = 90;

if (!process.versions.electron) {
  await fs.mkdir(output, { mode: 0o700 }); // exclusive: prior evidence is never overwritten
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  const fixtures = path.join(repository, 'test/fixtures');
  const shim = name => path.join(fixtures, `hag-production-${name}.ts`);
  const boundaries = {
    [path.join(repository, 'src/main/beholdd.ts')]: shim('beholdd'),
    [path.join(repository, 'src/main/updates/service.ts')]: shim('updates'),
  };
  const plugin = { name: 'hag-production-runtime-boundaries', setup(builder) {
    if (fullCatalogMode) builder.onResolve({ filter: /^@modelcontextprotocol\/sdk\/client\/stdio\.js$/ }, args =>
      args.importer === shim('mcp-transport') ? undefined : { path: shim('mcp-transport') });
    builder.onResolve({ filter: /^(node:)?(os|child_process)$|^node-pty$|^electron$|^\./ }, args => {
      if (args.path === 'electron') return args.importer === shim('electron') ? { path: 'electron', external: true } : { path: shim('electron') };
      if (args.path === 'os' || args.path === 'node:os') return args.importer === shim('os') ? undefined : { path: shim('os') };
      if (args.path === 'child_process' || args.path === 'node:child_process') return args.importer === shim('child-process') ? undefined : { path: shim('child-process') };
      if (args.path === 'node-pty') return { path: shim('pty') };
      const target = path.resolve(args.resolveDir, args.path) + '.ts';
      const replacement = boundaries[target];
      return replacement && args.importer !== replacement ? { path: replacement } : undefined;
    });
  } };
  const sources = new Set(['scripts/smoke-hag-production.mjs', 'package.json', 'package-lock.json']);
  if (fullCatalogMode) sources.add('mcp/server.ts'); // provenance for the catalog-only peer's definition projection
  for (const [entry, destination, platform] of [
    ['test/fixtures/hag-production-main.ts', 'main/index.cjs', 'node'],
    ['src/preload/index.ts', 'preload/index.js', 'node'],
    ['renderer/src/main.tsx', 'renderer/app.js', 'browser'],
  ]) {
    const result = await build({ absWorkingDir: repository, entryPoints: [entry], outfile: path.join(output, destination),
      bundle: true, platform, format: platform === 'node' ? 'cjs' : 'esm', metafile: true,
      external: platform === 'node' ? [...(destination.startsWith('main/') ? [] : ['electron']), 'bufferutil', 'utf-8-validate'] : [],
      plugins: destination.startsWith('main/') ? [plugin] : [], logLevel: 'warning',
      loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
      define: { 'process.env.NODE_ENV': '"production"' } });
    for (const input of Object.keys(result.metafile.inputs)) sources.add(input);
    await writeJson(destination.replaceAll('/', '-') + '.meta.json', result.metafile);
  }
  const { default: postcss } = await import('postcss');
  const { default: tailwindcss } = await import('tailwindcss');
  const { default: autoprefixer } = await import('autoprefixer');
  const cssPath = path.join(output, 'renderer/app.css');
  const styled = await postcss([tailwindcss({ config: path.join(repository, 'tailwind.config.js') }), autoprefixer()])
    .process(await fs.readFile(cssPath, 'utf8'), { from: cssPath, to: cssPath });
  await fs.writeFile(cssPath, styled.css);
  sources.add('tailwind.config.js');
  for (const item of await fs.readdir(path.join(repository, 'renderer/src'), { recursive: true, withFileTypes: true })) {
    if (item.isFile() && /\.(js|ts|jsx|tsx)$/.test(item.name)) sources.add(path.relative(repository, path.join(item.parentPath ?? item.path, item.name)));
  }
  await writeJson('source-hashes.json', Object.fromEntries(await Promise.all([...sources].sort().map(async input =>
    [input, sha256(await fs.readFile(path.resolve(repository, input)))]))));
  await fs.writeFile(path.join(output, 'renderer/index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\'; img-src data:; connect-src \'none\'"><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>');
  for (const name of ['home', 'user-data', 'config', 'cache', 'state', 'data', 'runtime', 'workspace']) await fs.mkdir(path.join(output, name), { mode: 0o700 });
  await fs.writeFile(path.join(output, 'package.json'), '{"name":"antimatter-hag-production-smoke","version":"11.0.0"}\n');
  await writeJson('user-data/setup.json', { version: 1, assistant: { name: 'Antimatter', personality: '' }, completedAt: 1 });
  // Exercise the composer with the v12 offer already dismissed, without opting into HAG.
  // Programmatic clicks must not bypass an unrelated modal covering the real panel.
  await fs.mkdir(path.join(output, 'user-data/hag'), { mode: 0o700 });
  await writeJson('user-data/hag/settings.json', { version: 1, enabled: false, welcomeSeen: true, modelPath: null });
  await writeJson('user-data/mcp-servers.json', { version: 1, adoptedBuiltin: true, enabledMedia: true, confirmedWorkspace: null,
    servers: [{ id: 'antimatter', name: 'Antimatter tools', command: 'disabled', args: [], enabled: fullCatalogMode, builtin: true, createdAt: 1,
      env: { ANTIMATTER_WORKSPACE: path.join(output, 'workspace'), CODING_WORKSPACE_PATH: path.join(output, 'workspace') } }] });
  if (fullCatalogMode) {
    // The real renderer restores two empty drafts with explicit isolated workspaces. That
    // makes connected-chat schemas available through the normal active-thread checks.
    // Unlike the source/model settings, production conversations use homedir/.antimatter.
    // Keep that normal path contract inside the fixture's private homedir.
    await fs.mkdir(path.join(output, 'home/.antimatter'), { mode: 0o700 });
    await writeJson('home/.antimatter/conversations.json', { version: 1,
      threads: fullCatalogChats.map(chat => ({ ...chat, projectId: 'inbox', createdAt: 1, messages: [],
        directory: path.join(output, 'workspace'), accessMode: 'ask',
        providerId: 'hag-production-source', modelId: 'hag-production-qwen3' })),
      activeThreadId: fullCatalogChats[0].id, pinned: [],
      drafts: Object.fromEntries(fullCatalogChats.map(chat => [chat.id, { text: fullCatalogPrompt, attachments: [] }])) });
  }
  await fs.copyFile(filename, path.join(output, 'launcher.mjs'));
  // Chromium places its single-instance Unix socket beneath TMPDIR. Deep evidence paths
  // exceed the kernel's socket-path limit, so only ephemeral files use this short owned path.
  const temporaryDirectory = await fs.mkdtemp(path.join(tmpdir(), 'am-hag-'));
  await writeJson('temporary-directory.json', { path: temporaryDirectory });
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '', ANTIMATTER_HAG_SMOKE_HOME: path.join(output, 'home'),
    ANTIMATTER_WORKFLOW_PATH: path.join(output, 'workspace/missing-WORKFLOW.md'), ANTIMATTER_LLAMA_VULKAN_MODEL: '',
    BEHOLDD_HOME: path.join(output, 'home/.beholdd'), HF_HOME: path.join(output, 'home/huggingface'),
    HF_HUB_CACHE: path.join(output, 'home/huggingface/hub'), HUGGINGFACE_HUB_CACHE: path.join(output, 'home/huggingface/hub'),
    HF_TOKEN_PATH: path.join(output, 'home/huggingface/missing-token'), XDG_CONFIG_HOME: path.join(output, 'config'), XDG_CACHE_HOME: path.join(output, 'cache'),
    XDG_STATE_HOME: path.join(output, 'state'), XDG_DATA_HOME: path.join(output, 'data'), XDG_RUNTIME_DIR: path.join(output, 'runtime'), TMPDIR: temporaryDirectory };
  delete env.VITE_DEV_SERVER_URL; delete env.ANTIMATTER_DEV_PARENT_PID; delete env.NODE_OPTIONS;
  delete env.HF_TOKEN; delete env.HUGGING_FACE_HUB_TOKEN; delete env.APPIMAGE; delete env.APPDIR;
  const startedAt = Date.now();
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', path.join(output, 'launcher.mjs'), '--output', output,
    ...(fullCatalogMode ? ['--full-catalog'] : [])],
    { stdio: 'inherit', cwd: path.join(output, 'workspace'), env });
  let timedOut = false, force;
  const timer = setTimeout(() => { timedOut = true; child.kill(); force = setTimeout(() => child.kill('SIGKILL'), 2_000); }, processSeconds * 1000);
  try {
    const [code, signal] = await once(child, 'close');
    await writeJson('process.json', { pid: child.pid, startedAt, endedAt: Date.now(), code, signal, timedOut, deadlineSeconds: processSeconds });
    assert.equal(timedOut, false); assert.equal(signal, null); assert.equal(code, 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')).passed, true);
    console.log(`Production HAG discovery/admission smoke passed: ${output}`);
  } finally {
    clearTimeout(timer); clearTimeout(force);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    const absent = await fs.stat(temporaryDirectory).then(() => false, error => {
      if (error.code === 'ENOENT') return true;
      throw error;
    });
    assert.equal(absent, true);
    await writeJson('temporary-cleanup.json', { path: temporaryDirectory, absent });
  }
} else {
  const { app, BrowserWindow, session } = await import('electron');
  app.setPath('userData', path.join(output, 'user-data'));
  app.setPath('home', path.join(output, 'home'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  const state = globalThis.__hagProductionSmoke = { phase: 'startup', providerBodies: [], output, fullCatalogMode, mcpTransports: [],
    boundaries: { deniedChildren: [], deniedNetwork: [], bundledStartupSuppressed: 0, updaterStartupSuppressed: 0, trayStartupSuppressed: 0, menuConstructionSuppressed: 0, offscreenWindows: 0 },
    requests: [], console: [], errors: [], cases: [], startedAt: Date.now() };
  const model = 'hag-production-qwen3';
  const sourceId = 'hag-production-source';
  let cap = 2048, server, window;
  const peers = new Set();
  const serverFailures = [];
  const send = (response, status, body, type = 'application/json') => {
    assert.ok(Buffer.byteLength(body) < 32_768, 'bounded synthetic response');
    response.writeHead(status, { 'content-type': type, 'connection': 'close' }); response.end(body);
  };
  server = http.createServer(async (request, response) => {
    try {
      assert.ok(state.requests.length < 100, 'synthetic HTTP request ceiling');
      const record = { phase: state.phase, method: request.method, url: request.url, at: Date.now() };
      state.requests.push(record);
      let bytes = 0; const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 262_144, 'synthetic request size ceiling'); chunks.push(chunk); }
      if (request.method === 'GET' && request.url === '/smoke/v1/models') return send(response, 200, JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', context_length: 131072, execution_limits: { max_evaluated_tokens: cap } }] }));
      if (request.method === 'GET' && request.url === '/smoke/health') return send(response, 200, '{"status":"ok"}');
      if (request.method === 'POST' && request.url === '/smoke/v1/chat/completions') {
        const raw = Buffer.concat(chunks);
        record.body = JSON.parse(raw.toString('utf8'));
        assert.equal(record.body.model, model); assert.equal(record.body.stream, true);
        if (fullCatalogMode) {
          assert.equal(state.phase, 'cap16384-full-catalog');
          assert.equal(record.body.tools?.length, 45, 'complete interactive catalog must reach HTTP');
          assert.equal(record.body.max_tokens, 4096);
          const file = path.join(output, `request-${state.phase}.wire.json`);
          await fs.writeFile(file, raw, { flag: 'wx' });
          record.rawBody = { path: file, sha256: sha256(raw), bytes: raw.length,
            phase: state.phase, toolCount: record.body.tools.length };
        } else assert.ok(!record.body.tools?.length, 'default smoke only permits no-tools completion');
        assert.ok(state.requests.filter(entry => entry.method === 'POST').length <= (fullCatalogMode ? 1 : 4), 'synthetic completion ceiling');
        const chunk = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'synthetic-hag', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
        return send(response, 200, chunk({ role: 'assistant', content: 'ready.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n', 'text/event-stream');
      }
      throw new Error(`Unexpected synthetic route: ${request.method} ${request.url}`);
    } catch (error) { serverFailures.push(String(error)); if (!response.headersSent) send(response, 500, '{"error":{"message":"synthetic fixture rejected request"}}'); else response.destroy(); }
  });
  server.requestTimeout = 5_000; server.headersTimeout = 5_000; server.timeout = 5_000;
  server.on('connection', socket => { peers.add(socket); socket.once('close', () => peers.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const baseUrl = origin + '/smoke/v1';
  // Node transports (http/https/ws and Undici included) share the socket boundary. Chromium
  // uses its own process/session and is denied separately below. No other listener is allowed.
  const socketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = first && typeof first === 'object' ? first : { port: first, host: args[1] };
    if (options.path || Number(options.port) !== server.address()?.port || options.host !== '127.0.0.1') {
      state.boundaries.deniedNetwork.push({ transport: 'net.Socket.connect', host: options.host, port: options.port, path: options.path });
      throw new Error('HAG smoke forbids network outside its synthetic peer');
    }
    return socketConnect.apply(this, args);
  };
  tls.connect = (..._args) => { state.boundaries.deniedNetwork.push({ transport: 'tls.connect' }); throw new Error('HAG smoke forbids TLS'); };
  net.Server.prototype.listen = function (..._args) { state.boundaries.deniedNetwork.push({ transport: 'net.Server.listen' }); throw new Error('HAG smoke forbids additional listeners'); };
  const actualFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== origin) { state.boundaries.deniedNetwork.push(url.origin + url.pathname); throw new Error('HAG smoke forbids external network'); }
    return actualFetch(input, { ...init, redirect: 'error' });
  };
  app.on('browser-window-created', (_event, created) => {
    window ??= created;
    created.webContents.on('console-message', event => state.console.push({ level: event.level, message: event.message }));
    created.webContents.on('preload-error', (_event, _file, error) => state.errors.push(String(error)));
    created.webContents.on('render-process-gone', (_event, detail) => state.errors.push(JSON.stringify(detail)));
  });
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
  });
  const require = createRequire(import.meta.url);
  require(path.join(output, 'main/index.cjs'));
  const run = code => window.webContents.executeJavaScript(code);
  const waitFor = async (description, predicate, seconds = 15) => {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error('Timed out: ' + description);
  };
  const invoke = expression => run(`(async () => ${expression})()`);
  const posts = () => state.requests.filter(request => request.method === 'POST').length;
  const source = () => invoke(`(await electronAPI.providers.list()).find(source => source.id === ${JSON.stringify(sourceId)})`);
  const refresh = async value => { cap = value; const result = await invoke(`electronAPI.providers.refresh(${JSON.stringify(sourceId)})`); assert.equal(result.ok, true); return source(); };
  const turn = async (phase, content) => {
    state.phase = phase;
    const request = { providerId: sourceId, model, requestId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content }], useTools: false, accessMode: 'read' };
    const before = posts();
    const outcome = await invoke(`electronAPI.chat.startStream(${JSON.stringify(request)}).then(() => ({ ok: true }), error => ({ ok: false, error: String(error.message) }))`);
    const contexts = await run(`window.__hagContexts.filter(item => item.runId === ${JSON.stringify(request.requestId)})`);
    assert.ok(contexts.length > 0, 'real chat:context event is required');
    const records = state.providerBodies.filter(record => record.phase === phase);
    assert.equal(records.length, 1, 'one real production provider body observation per turn');
    const result = { phase, outcome, contexts, postDelta: posts() - before, requestId: request.requestId };
    state.cases.push(result); return result;
  };
  const fullCatalog = async saved => {
    const selected = await invoke(`electronAPI.model.set(${JSON.stringify(sourceId)}, ${JSON.stringify(model)})`);
    assert.equal(selected.providerId, sourceId);
    assert.equal(selected.modelId, model);
    state.conversationStore = await invoke('electronAPI.conversations.info()');
    assert.equal(state.conversationStore.path, path.join(output, 'home/.antimatter/conversations.json'),
      'seed and production persistence paths must agree');
    const initial = await invoke('electronAPI.conversations.load()');
    for (const chat of fullCatalogChats) {
      const thread = initial.threads.find(item => item.id === chat.id);
      assert.ok(thread, 'production conversation store must restore each isolated draft');
      assert.equal(thread.directory, path.join(output, 'workspace'));
      assert.equal(thread.messages.length, 0);
    }
    await waitFor('production MCP catalog connection', async () => {
      const statuses = await invoke('electronAPI.mcp.list()');
      return statuses.length === 1 && statuses[0].id === 'antimatter' && statuses[0].connected;
    });
    await run('window.__hagToolActivities = []; window.electronAPI.onToolActivity(item => window.__hagToolActivities.push(item)); void 0;');
    const checkCatalog = definitions => {
      assert.equal(definitions.length, 45);
      const names = definitions.map(tool => tool.function.name);
      assert.equal(new Set(names).size, 45);
      const groups = { antimatter: 21, antimatter_preview: 6, antimatter_agents: 4,
        antimatter_memory: 4, 'antimatter_pull-requests': 1, antimatter_conversations: 3, 'antimatter_code-review': 6 };
      assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([group]) =>
        [group, names.filter(name => name.startsWith(group + '__')).length])), groups);
      assert.ok(names.every(name => Object.keys(groups).some(group => name.startsWith(group + '__'))),
        'no optional Bot, skill or third-party tools');
      const listed = state.mcpTransports.find(transport => transport.tools.length === 21)?.tools;
      assert.ok(listed, 'real SDK tools/list must precede catalog assembly');
      for (const tool of listed) {
        const wire = definitions.find(entry => entry.function.name === 'antimatter__' + tool.name).function;
        assert.deepEqual(wire.parameters, tool.inputSchema, 'bundled schemas must survive production composition');
      }
      const byName = name => definitions.find(entry => entry.function.name === name).function.parameters;
      assert.equal(byName('antimatter_conversations__list_connected_chats').properties.limit.maximum, 64);
      assert.equal(byName('antimatter_conversations__read_chat').properties.limit.maximum, 32);
      assert.equal(byName('antimatter_conversations__read_chat').properties.max_chars.maximum, 32768);
      assert.deepEqual(byName('antimatter_code-review__update_review_finding').properties.status.enum, ['open', 'addressed']);
      assert.equal(byName('antimatter_code-review__read_code_review').properties.limit.maximum, 16000);
    };
    let acceptedTools;
    for (const [index, capacity] of [16384, 8192].entries()) {
      const chat = fullCatalogChats[index];
      const refreshed = await refresh(capacity);
      assert.equal(refreshed.models[0].maxEvaluatedTokens, capacity);
      assert.equal(refreshed.models[0].contextWindow, 65536);
      state.phase = `cap${capacity}-full-catalog`;
      await waitFor('isolated conversation row', () => run(`Boolean(document.querySelector('[data-thread-row="${chat.id}"]'))`));
      await run(`document.querySelector('[data-thread-row="${chat.id}"]').click()`);
      await waitFor('selected fresh composer draft', () => run(`document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(fullCatalogPrompt)}`));
      const before = posts();
      await waitFor('enabled full-catalog composer', () => run('Boolean(document.querySelector(\'[aria-label="Send message"]\') && !document.querySelector(\'[aria-label="Send message"]\').disabled)'));
      await run('document.querySelector(\'[aria-label="Send message"]\').click()');
      await waitFor('production full-catalog provider observation', () => state.providerBodies.some(record => record.phase === state.phase));
      await waitFor('full-catalog composer completion or refusal', () => run(index === 0
        ? 'Boolean(document.querySelector(\'[aria-label="Send message"]\'))'
        : 'document.body.textContent.includes("context_length_exceeded") && Boolean(document.querySelector(\'[aria-label="Send message"]\'))'));
      if (index === 0) await waitFor('completed synthetic reply in production conversation history', async () => {
        const stored = await invoke('electronAPI.conversations.load()');
        const thread = stored.threads.find(item => item.id === chat.id);
        return thread?.messages.some(message => message.role === 'assistant' && message.content === 'ready.' && !message.meta?.failed);
      });
      const observations = state.providerBodies.filter(record => record.phase === state.phase);
      assert.equal(observations.length, 1, 'one provider attempt per fresh composer submission');
      const observation = observations[0];
      assert.equal(observation.request.threadId, chat.id);
      assert.equal(observation.request.useTools, true);
      const wire = observation.wire ?? observation.refusedWireForInspection;
      checkCatalog(wire.tools);
      assert.equal(wire.max_tokens, capacity / 4, 'production default reply reservation follows observed capacity');
      assert.equal(wire.messages.filter(message => message.role === 'user').length, 1);
      assert.equal(wire.messages.at(-1).content, fullCatalogPrompt, 'current user input is preserved');
      const contexts = await run(`window.__hagContexts.filter(item => item.runId === ${JSON.stringify(observation.request.requestId)})`);
      assert.ok(contexts.length > 0);
      assert.equal(contexts[0].contextTokens, capacity);
      assert.equal(contexts[0].maxOutputTokens, capacity / 4);
      if (index === 0) {
        assert.equal(observation.accepted, true);
        assert.equal(posts() - before, 1);
        const transmitted = state.requests.filter(record => record.phase === state.phase && record.method === 'POST');
        assert.equal(transmitted.length, 1);
        assert.deepEqual(transmitted[0].body, wire, 'observed provider body equals received HTTP body');
        assert.deepEqual(JSON.parse(await fs.readFile(transmitted[0].rawBody.path, 'utf8')), wire);
        acceptedTools = structuredClone(wire.tools);
        state.fullCatalog = { acceptedRequest: transmitted[0].rawBody };
      } else {
        assert.equal(observation.accepted, false);
        assert.match(observation.error, /context_length_exceeded/);
        assert.equal(posts() - before, 0);
        assert.deepEqual(wire.tools, acceptedTools, 'refusal must preserve the full catalog and its constraints');
        state.fullCatalog.refusedRequest = { path: path.join(output, `request-${state.phase}.json`),
          phase: state.phase, toolCount: wire.tools.length, transmitted: false };
      }
      state.cases.push({ phase: state.phase, composerClicked: true, threadId: chat.id,
        postDelta: posts() - before, accepted: observation.accepted, error: observation.error,
        toolCount: wire.tools.length, maxTokens: wire.max_tokens, contexts });
    }
    const savedAfter = await invoke(`electronAPI.modelWorkloads.resolve(${JSON.stringify(sourceId)}, ${JSON.stringify(model)})`);
    assert.deepEqual(savedAfter, saved, 'observed capacities must not rewrite saved workload preferences');
    assert.deepEqual(await run('window.__hagToolActivities'), [], 'no tool actions may execute');
    await invoke('electronAPI.mcp.disconnect("antimatter")');
    assert.ok(state.mcpTransports.length >= 3 && state.mcpTransports.length <= 8);
    assert.ok(state.mcpTransports.every(transport => transport.opened && transport.closed && transport.tools.length === 21),
      'all global and per-turn catalog transports must retire');
    state.fullCatalog.discovery = { acceptedCapacity: 16384, refusedCapacity: 8192, savedContext: saved.contextTokens };
    // Exercise the actual review IPC, panel registration, shell action and mounted composer.
    // A fixture-only panel callback cannot catch a stale parent draft or a composer that
    // seeds its local text only on mount. This must stay draft-only: no extra HTTP turn.
    const workspace = path.join(output, 'workspace');
    await fs.writeFile(path.join(workspace, 'review-fixture.ts'), 'export const ready = true;\n');
    const review = await invoke(`electronAPI.codeReview.create(${JSON.stringify(workspace)}, ${JSON.stringify({
      title: 'Production review integration', scope: { kind: 'file', path: 'review-fixture.ts' },
    })})`);
    assert.equal(review.author.kind, 'human');
    const beforeReview = posts();
    await run('window.dispatchEvent(new Event("antimatter:code-review-selection")); void 0;');
    await waitFor('registered Code Review panel', () => run('Boolean(document.querySelector(\'[aria-label="Saved reviews"]\'))'));
    await run(`(() => { const picker = document.querySelector('[aria-label="Saved reviews"]'); picker.value = ${JSON.stringify(review.id)}; picker.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor('loaded review discussion', () => run('Boolean([...document.querySelectorAll("button")].find(button => button.textContent === "Ask agent to review"))'));
    const unsent = 'Keep this unsent note.';
    await run(`(() => { const input = document.querySelector('textarea[aria-label="Message"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(unsent)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await run('[...document.querySelectorAll("button")].find(button => button.textContent === "Ask agent to review").click()');
    await waitFor('review prompt appended to live composer', () => run(`document.querySelector('textarea[aria-label="Message"]')?.value.startsWith(${JSON.stringify(unsent + '\n\n')}) && document.querySelector('textarea[aria-label="Message"]')?.value.includes(${JSON.stringify(review.id)})`));
    const expectedDraft = await run('document.querySelector(\'textarea[aria-label="Message"]\').value');
    await run(`document.querySelector('[data-thread-row="${fullCatalogChats[0].id}"]').click()`);
    await waitFor('different composer mounted', () => run('document.querySelector(\'textarea[aria-label="Message"]\')?.value === ""'));
    await run(`document.querySelector('[data-thread-row="${fullCatalogChats[1].id}"]').click()`);
    await waitFor('review draft restored after chat switch', () => run(`document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(expectedDraft)}`));
    assert.equal(posts(), beforeReview, 'Ask agent only drafts; it must never send automatically');
    state.codeReviewDraft = { passed: true, reviewId: review.id, liveDraftPreserved: true, survivesChatSwitch: true, postDelta: 0 };
    return savedAfter;
  };
  // Let this ESM entry finish evaluating so Electron can emit ready and run the
  // production main's own ready handler before waiting for its renderer.
  app.whenReady().then(async () => {
  try {
    await waitFor('production main App renderer', async () => Boolean(window && !window.webContents.isLoading() && await run('Boolean(window.electronAPI && document.querySelector("textarea[aria-label=Message]"))')));
    await run('window.__hagContexts = []; window.electronAPI.onChatContext(report => window.__hagContexts.push(report)); void 0;');
    assert.deepEqual(await invoke('electronAPI.providers.list()'), [], 'private startup must have no configured sources');
    await invoke(`electronAPI.providers.add(${JSON.stringify({ id: sourceId, name: 'Synthetic HAG', kind: 'beholdd', protocol: 'openai-chat', baseUrl, apiKey: '', models: [{ id: model, name: model, contextWindow: 65536 }], supportsStreaming: true })})`);
    assert.equal((await source()).models[0].maxEvaluatedTokens, undefined, 'source starts without a fabricated cap');
    await invoke(`electronAPI.providers.updateModel(${JSON.stringify(sourceId)}, ${JSON.stringify(model)}, { name: ${JSON.stringify(model)}, contextWindow: 65536 })`);
    await invoke(`electronAPI.modelWorkloads.setDefaultSettings(${JSON.stringify(sourceId)}, ${JSON.stringify(model)}, { contextTokens: 32768, compaction: 'drop' })`);
    const saved = await invoke(`electronAPI.modelWorkloads.resolve(${JSON.stringify(sourceId)}, ${JSON.stringify(model)})`);
    let savedAfter;
    if (fullCatalogMode) {
      savedAfter = await fullCatalog(saved);
    } else {
    const first = await refresh(2048);
    assert.equal(first.models[0].maxEvaluatedTokens, 2048); assert.equal(first.models[0].contextWindow, 65536);
    // Curation flags are deliberately private; verify persistence on disk, while the
    // public catalog above must retain the curated value despite different server metadata.
    const catalog = JSON.parse(await fs.readFile(path.join(output, 'user-data/sources.json'), 'utf8'));
    const persisted = catalog.sources.find(item => item.id === sourceId);
    assert.equal(persisted.models[0].contextWindowCurated, true);
    state.discovery = { advertisedContext: 131072, publicSource: first, persistedSource: persisted };
    const baseline = await turn('cap2048-small', 'Reply exactly ready.');
    assert.equal(baseline.contexts[0].contextTokens, 2048); assert.equal(baseline.contexts[0].maxOutputTokens, 512);
    if (baseline.outcome.ok) assert.equal(baseline.postDelta, 1); else { assert.match(baseline.outcome.error, /context_length_exceeded/); assert.equal(baseline.postDelta, 0); }
    const oversized = await turn('cap2048-oversized', 'bounded-overflow '.repeat(2500));
    assert.equal(oversized.outcome.ok, false); assert.match(oversized.outcome.error, /context_length_exceeded/); assert.equal(oversized.postDelta, 0);
    await refresh(16384);
    const positive = await turn('cap16384-positive-control', 'Reply exactly ready.');
    assert.equal(positive.outcome.ok, true); assert.equal(positive.postDelta, 1); assert.equal(positive.contexts[0].contextTokens, 16384);
    const uncapped = await refresh(null);
    assert.equal(uncapped.models[0].maxEvaluatedTokens, null);
    const noPublishedCap = await turn('null-cap-saved-context', 'Reply exactly ready.');
    assert.equal(noPublishedCap.outcome.ok, true); assert.equal(noPublishedCap.postDelta, 1);
    assert.equal(noPublishedCap.contexts[0].contextTokens, saved.contextTokens, 'null restores finite saved context, not unlimited capacity');
    savedAfter = await invoke(`electronAPI.modelWorkloads.resolve(${JSON.stringify(sourceId)}, ${JSON.stringify(model)})`);
    assert.deepEqual(savedAfter, saved, 'temporary caps must not rewrite saved workload settings');
    await refresh(2048);
    await invoke(`electronAPI.model.set(${JSON.stringify(sourceId)}, ${JSON.stringify(model)})`);
    state.phase = 'cap2048-real-composer-with-tools';
    const composerPosts = posts();
    await run(`(() => { const input = document.querySelector('textarea[aria-label="Message"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify('bounded-composer-overflow '.repeat(1000))});
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor('actual enabled composer', () => run('Boolean(document.querySelector(\'[aria-label="Send message"]\') && !document.querySelector(\'[aria-label="Send message"]\').disabled)'));
    await run('document.querySelector(\'[aria-label="Send message"]\').click()');
    await waitFor('actual composer admission refusal', () => state.providerBodies.some(record => record.phase === state.phase));
    await waitFor('actual visible composer error and idle', () => run('document.body.textContent.includes("context_length_exceeded") && Boolean(document.querySelector(\'[aria-label="Send message"]\'))'));
    const composerBody = state.providerBodies.find(record => record.phase === state.phase);
    assert.equal(composerBody.accepted, false); assert.equal(composerBody.request.useTools, true);
    assert.ok(composerBody.request.tools?.length > 0, 'actual composer carries production tool definitions');
    assert.equal(posts(), composerPosts, 'actual oversized composer must not reach HTTP');
    assert.match(composerBody.error, /context_length_exceeded/);
    state.cases.push({ phase: state.phase, composerClicked: true, postDelta: posts() - composerPosts,
      toolCount: composerBody.request.tools.length, requestId: composerBody.request.requestId,
      error: composerBody.error, contexts: await run(`window.__hagContexts.filter(item => item.runId === ${JSON.stringify(composerBody.request.requestId)})`) });
    }
    state.persistedConversations = await invoke('electronAPI.conversations.load()');
    assert.deepEqual(serverFailures, []); assert.deepEqual(state.errors, []);
    assert.deepEqual(state.boundaries.deniedChildren, []); assert.deepEqual(state.boundaries.deniedNetwork, []);
    assert.equal(state.boundaries.bundledStartupSuppressed, 1); assert.equal(state.boundaries.updaterStartupSuppressed, 1);
    assert.equal(state.boundaries.trayStartupSuppressed, 1);
    assert.equal(state.boundaries.menuConstructionSuppressed, 1);
    assert.equal(state.boundaries.offscreenWindows, 1);
    for (const record of state.providerBodies) await writeJson(`request-${record.phase}.json`, record.wire ?? record.refusedWireForInspection);
    window.destroy(); // retire readiness polling before closing its sole allowed peer
    for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve));
    assert.equal(server.listening, false);
    assert.deepEqual(state.boundaries.deniedNetwork, []);
    await writeJson('report.json', { passed: true, ...state, endedAt: Date.now(), model, baseUrl, savedProfile: saved, savedAfter,
      syntheticPeerClosed: !server.listening,
      scope: { productionMain: 'src/main/index.ts', productionPreload: 'src/preload/index.ts', renderer: 'renderer/src/main.tsx and actual App; source setup/refresh through real preload IPC',
        composerClicked: true, sourceButtonsClicked: false, modelExecution: false, backendQualified: false, toolExecution: false,
        noToolsCases: fullCatalogMode ? null : 'real preload chat.startStream with useTools:false; distinct from final actual composer refusal with tools',
        catalogMode: fullCatalogMode ? 'two real composer submissions with production 45-tool assembly; C16384 synthetic success and C8192 pre-HTTP refusal' : null,
        mcpBoundary: fullCatalogMode ? 'real SDK client/listTools and production runtime composition; in-memory SDK peer lists production ALL_TOOLS; no MCP subprocess or tools/call' : 'bundled MCP disabled',
        boundaryShims: ['private os.homedir', 'deny child_process/node-pty', 'bundled Beholdd startup/status', 'automatic updater startup', 'headless native system tray/menu', 'real BrowserWindow with hidden offscreen rendering'],
        noPublishedCapMeans: fullCatalogMode ? null : 'finite saved/model profile; no fixed server cap was advertised',
        refusedWire: 'diagnostic only; serialized by actual production wireMessages after actual body admission throws' } });
    console.log('Real production source discovery, effective budgeting and pre-HTTP refusal passed.');
    app.quit();
  } catch (error) {
    await writeJson('failure.json', { error: String(error.stack ?? error), ...state, serverFailures });
    console.error(error);
    for (const socket of peers) socket.destroy(); server.close(); app.exit(1);
  }
  });
}
