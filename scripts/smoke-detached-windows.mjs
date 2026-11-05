#!/usr/bin/env node
/** Actual packaged detached entry + preload + host lifecycle, using a synthetic main shell. No inference. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.versions.electron) {
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  await fs.access(path.join(root, 'dist-electron/renderer/detached.html'));
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-detached-'));
  for (const [source, name, platform] of [
    ['test/fixtures/detached-window-renderer.tsx', 'fixture.js', 'browser'],
    ['src/preload/index.ts', 'preload.cjs', 'node'],
    ['src/main/detachedWindows.ts', 'manager.cjs', 'node'],
    ['src/main/appEvents.ts', 'events.cjs', 'node'],
  ]) await build({ absWorkingDir: root, entryPoints: [source], outfile: path.join(output, name), bundle: true,
    platform, format: platform === 'node' ? 'cjs' : 'esm', external: platform === 'node' ? ['electron'] : [], logLevel: 'warning' });
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', fileURLToPath(import.meta.url), '--fixture', output], { cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '',
    XDG_CONFIG_HOME: path.join(output, 'config'), XDG_CACHE_HOME: path.join(output, 'cache'), XDG_DATA_HOME: path.join(output, 'data') } });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (status, signal) => { if (signal) console.error('Electron smoke signal:', signal); resolve(status ?? 1); }); });
  clearTimeout(timer);
  console.log(`Detached smoke evidence: ${output}`);
  process.exitCode = code;
} else {
  void (async () => {
  const require = createRequire(import.meta.url);
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'profile'));
  app.disableHardwareAcceleration();
  const { DetachedWindowManager } = require(path.join(output, 'manager.cjs'));
  const { AppEventBus } = require(path.join(output, 'events.cjs'));
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/' || pathname === '/index.html') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); return;
      }
      const base = pathname.startsWith('/fixture.') ? output : path.join(root, 'dist-electron/renderer');
      const file = path.resolve(base, `.${pathname}`);
      if (!file.startsWith(`${base}/`)) throw new Error('Invalid path');
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      response.end(await fs.readFile(file));
    } catch { response.statusCode = 404; response.end(); }
  });
  let main; let manager;
  try {
    await app.whenReady();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(url) && !details.url.startsWith('data:') }));
    const makeWindow = (bounds = {}) => {
      const win = new BrowserWindow({ width: 1000, height: 700, ...bounds, show: false,
        webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(output, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
      win.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message); });
      win.webContents.on('render-process-gone', (_event, details) => failures.push(`renderer gone: ${details.reason}`));
      return win;
    };
    main = makeWindow();
    manager = new DetachedWindowManager({ mainWindow: () => main, showMain: () => {}, background: () => '#141414', events: new AppEventBus(), devServerUrl: url,
      createWindow: makeWindow, workArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }) });
    manager.initialize();
    ipcMain.on('appearance:initial', (event) => { event.returnValue = null; });
    ipcMain.handle('appearance:get', () => ({}));
    const evaluate = (window, code) => window.webContents.executeJavaScript(code);
    const wait = async (check, label) => {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
      throw new Error(`Timed out: ${label}`);
    };
    await main.loadURL(url);
    await wait(() => evaluate(main, '!!window.detachedSmoke'), 'main fixture');
    await evaluate(main, 'document.querySelector("#float").click()');
    await wait(() => evaluate(main, '!!document.querySelector("[title=\\"Detach into a separate window\\"]")'), 'float controls');
    await evaluate(main, 'document.querySelector("[title=\\"Detach into a separate window\\"]").click()');
    await wait(() => BrowserWindow.getAllWindows().length === 2, 'detached window');
    const child = BrowserWindow.getAllWindows().find((window) => window !== main);
    await wait(() => evaluate(child, 'document.body.innerText.includes("Fixture source")'), 'actual packaged source panel with shell');
    await wait(() => evaluate(main, 'window.detachedSmoke.layout.detached.includes("core.sources") && !window.detachedSmoke.layout.floating.includes("core.sources")'), 'main layout ownership');
    const first = await evaluate(child, 'window.electronAPI.detached.ready()');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const later = await evaluate(child, 'window.electronAPI.detached.ready()');
    assert.ok(later.revision > first.revision, 'continuous 10ms renders must not starve 100ms snapshot delivery');
    assert.equal(later.shell.workspace, '/synthetic-project');
    assert.ok(!JSON.stringify(later.shell).includes('apiKey'));
    const choice = await evaluate(child, 'window.electronAPI.detached.action({type:"openModelLibrary",request:{title:"Choose fixture model"}})');
    assert.deepEqual(choice, { providerId: 'fixture', modelId: 'chosen-model' });
    assert.equal(await evaluate(main, 'document.querySelector("#page").textContent'), 'hub');
    // A main reload reuses the existing OS window and recovers shell state after late subscription.
    const reloaded = new Promise((resolve) => main.webContents.once('did-finish-load', resolve));
    main.reload();
    await reloaded;
    await wait(() => evaluate(main, '!!window.detachedSmoke && window.detachedSmoke.layout.detached.includes("core.sources")'), 'persisted detached restoration');
    assert.equal(BrowserWindow.getAllWindows().length, 2);
    await evaluate(child, 'document.querySelector("[title=\\"Dock to the side\\"]").click()');
    await wait(() => BrowserWindow.getAllWindows().length === 1, 'OS window closed by docking');
    await wait(() => evaluate(main, 'document.querySelector("#docked").textContent.includes("core.sources") && window.detachedSmoke.layout.detached.length === 0'), 'docked layout restored');
    assert.deepEqual(failures, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, actualPackagedEntry: true, boundedStreamingUpdates: true, modelPickerRoundTrip: true, reloadRestore: true, docked: true }, null, 2));
    console.log('Detached window smoke passed: actual packaged entry, live shell, picker, reload, dock.');
  } catch (error) { console.error(error); console.error(failures); process.exitCode = 1; }
  finally { manager?.dispose(); if (main && !main.isDestroyed()) main.destroy(); server.close(); app.exit(process.exitCode ?? 0); }
  })();
}
