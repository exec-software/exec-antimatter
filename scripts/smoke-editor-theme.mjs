#!/usr/bin/env node
/** Real CodeEditor/CodeMirror with synthetic files and mocked IPC; no file/provider/network access. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const filename = fileURLToPath(import.meta.url);
if (!process.versions.electron) {
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  const root = path.resolve(path.dirname(filename), '..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-editor-theme-smoke-'));
  const assets = process.argv[2] ?? path.join(root, 'dist-electron/renderer/assets');
  for (const name of await fs.readdir(assets)) if (/\.(css|woff2?)$/.test(name)) await fs.copyFile(path.join(assets, name), path.join(output, name));
  await build({ entryPoints: [path.join(root, 'test/fixtures/editor-theme-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' });
  const links = (await fs.readdir(output)).filter((name) => name.endsWith('.css')).map((name) => `<link rel="stylesheet" href="./${name}">`).join('');
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8">${links}</head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
  console.log(`Editor theme smoke output: ${output}`);
  const child = spawn(electron, ['--ozone-platform=headless', '--ozone-override-screen-size=1280,960', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data')); app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`editor-theme-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, width: 900, height: 600, enableLargerThanScreen: true, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const failures = []; window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 100))');
    const capture = async (name) => fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      await run('editorThemeSmoke.open("sample.ts")'); await tick();
      await run('editorThemeSmoke.edit("// unsaved edit\\n")'); await tick();
      await run('editorThemeSmoke.scroll(180)'); await tick();
      await run('window.originalEditor = editorThemeSmoke.view(); true');
      const before = await run('editorThemeSmoke.snapshot()');
      assert.equal(before.dark, true); assert.equal(before.undo, 1); assert.ok(before.scroll > 0);
      await capture('editor-dark.png');
      await run('editorThemeSmoke.appearance({ theme: "light", secondaryAccent: "#aa8cf4" })'); await tick();
      const light = await run('editorThemeSmoke.snapshot()');
      assert.equal(light.dark, false); assert.notEqual(light.background, before.background);
      assert.equal(await run('editorThemeSmoke.view() === originalEditor'), true);
      for (const key of ['text', 'selection', 'undo', 'scroll']) assert.equal(light[key], before[key], `${key} survives appearance change`);
      await capture('editor-light.png');
      // Switch documents, recolor with the first state cached, then restore it without losing undo.
      await run('editorThemeSmoke.open("second.py")'); await tick();
      await run('editorThemeSmoke.edit("# unsaved edit\\n")'); await tick();
      const second = await run('editorThemeSmoke.snapshot()');
      await run('editorThemeSmoke.appearance({ theme: "dark", secondaryAccent: "#dba844" })'); await tick();
      await run('editorThemeSmoke.open("sample.ts")'); await tick();
      const restored = await run('editorThemeSmoke.snapshot()');
      assert.equal(restored.dark, true); assert.equal(restored.text, before.text); assert.equal(restored.selection, before.selection); assert.equal(restored.undo, before.undo);
      assert.equal(await run('editorThemeSmoke.undo()'), true); await tick();
      assert.equal((await run('editorThemeSmoke.snapshot()')).text.startsWith('// unsaved edit'), false);
      await run('editorThemeSmoke.open("second.py")'); await tick();
      const secondRestored = await run('editorThemeSmoke.snapshot()');
      assert.equal(secondRestored.dark, true); assert.equal(secondRestored.text, second.text); assert.equal(secondRestored.undo, 1);
      assert.deepEqual(failures, []);
      console.log('Editor theme smoke passed: live palette/dark facet, same view, text/selection/scroll/undo preservation, and cached-document reconfiguration.');
      window.destroy(); app.exit(0);
    } catch (error) { console.error(error, failures); await capture('editor-theme-failure.png'); window.destroy(); app.exit(1); }
  }).catch((error) => { console.error(error); app.exit(1); });
}
