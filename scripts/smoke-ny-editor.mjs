#!/usr/bin/env node
/** Synthetic SDK IPC in the real editor. No microphone, provider or workspace writes. */
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
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-ny-editor-smoke-'));
  const assets = process.argv[2] ?? path.join(root, 'dist-electron/renderer/assets');
  for (const name of await fs.readdir(assets)) if (/\.(css|woff2?)$/.test(name)) await fs.copyFile(path.join(assets, name), path.join(output, name));
  await build({ entryPoints: [path.join(root, 'test/fixtures/ny-editor-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' });
  const links = (await fs.readdir(output)).filter((name) => name.endsWith('.css')).map((name) => `<link rel="stylesheet" href="./${name}">`).join('');
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8">${links}</head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
  console.log(`Ny editor smoke output: ${output}`);
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1280,960', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data')); app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`ny-editor-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const failures = []; window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 150))');
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      await run('nyEditorSmoke.open("main.ny")'); await tick();
      assert.match((await run('nyEditorSmoke.snapshot()')).status, /Completion, hover, F12/);
      await run('nyEditorSmoke.complete()'); await tick();
      assert.ok((await run('nyEditorSmoke.completions()')).includes('println'));
      assert.equal(await run('nyEditorSmoke.accept()'), true); await tick();
      assert.match((await run('nyEditorSmoke.snapshot()')).text, /println\(answer\)/);
      await run('nyEditorSmoke.hover()'); await tick();
      assert.match((await run('nyEditorSmoke.snapshot()')).hover, /let answer: i32/);
      assert.equal(await run('document.querySelectorAll(".cm-ny-hover script").length'), 0);
      await run('nyEditorSmoke.diagnose()'); await tick();
      assert.equal((await run('nyEditorSmoke.snapshot()')).diagnostics, 1);
      await run('nyEditorSmoke.edit()'); await tick();
      assert.equal((await run('nyEditorSmoke.snapshot()')).diagnostics, 0);
      await run('nyEditorSmoke.debug()'); await tick();
      const markers = (await run('nyEditorSmoke.snapshot()')).markers;
      assert.ok(markers.includes('○')); assert.ok(markers.includes('●'));
      await run('nyEditorSmoke.definition()'); await tick();
      assert.match((await run('nyEditorSmoke.snapshot()')).text, /pub fn helper/);
      await run('nyEditorSmoke.open("main.ny")'); await tick();
      assert.match((await run('nyEditorSmoke.snapshot()')).text, /println\(answer\)/);
      await run('nyEditorSmoke.open("other.txt")'); await tick();
      assert.equal((await run('nyEditorSmoke.snapshot()')).hover, undefined);
      assert.deepEqual(failures, []);
      console.log('Ny editor smoke passed: semantic completion/snippet, safe hover, F12 definition, checked diagnostics retired on edit, verified breakpoint markers, cached Ny tabs and plain-text cleanup.');
      window.destroy(); app.exit(0);
    } catch (error) {
      console.error(error, failures);
      await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
      window.destroy(); app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
