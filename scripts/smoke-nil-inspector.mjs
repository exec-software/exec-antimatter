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
  const { default: postcss } = await import('postcss');
  const { default: tailwindcss } = await import('tailwindcss');
  const { default: tailwindConfig } = await import('../tailwind.config.js');
  const root = path.resolve(path.dirname(filename), '..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-nil-inspector-smoke-'));
  const assets = process.argv[2] ?? path.join(root, 'dist-electron/renderer/assets');
  for (const name of await fs.readdir(assets)) if (/\.(css|woff2?)$/.test(name)) await fs.copyFile(path.join(assets, name), path.join(output, name));
  // Compile current utilities so screenshots cover this new view before a full app rebuild.
  const css = await postcss([tailwindcss(tailwindConfig)]).process(await fs.readFile(path.join(root, 'renderer/src/index.css'), 'utf8'), { from: path.join(root, 'renderer/src/index.css') });
  await fs.writeFile(path.join(output, 'nil-inspector.css'), css.css);
  await build({ entryPoints: [path.join(root, 'test/fixtures/nil-inspector-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' });
  const links = '<link rel="stylesheet" href="./nil-inspector.css">';
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8">${links}</head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
  console.log(`NIL inspector smoke output: ${output}`);
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1280,960', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data')); app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`nil-inspector-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const failures = []; window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 150))');
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      let snapshot = await run('nilInspectorSmoke.snapshot()');
      assert.match(snapshot.text, /Binary NIL v5/);
      assert.match(snapshot.text, /demo.main/);
      assert.equal(snapshot.editor, false);
      assert.equal(snapshot.instructions.length, 100);
      assert.equal(snapshot.mappedButtons, 0);
      await run('nilInspectorSmoke.click("Open src/main.ny:3")');
      assert.deepEqual((await run('nilInspectorSmoke.snapshot()')).reveals, [{ path: 'src/main.ny', line: 3 }]);
      await run('nilInspectorSmoke.click("Next NIL page")'); await tick();
      snapshot = await run('nilInspectorSmoke.snapshot()');
      assert.equal(snapshot.instructions.length, 20); assert.equal(snapshot.instructions[0], 100);
      await run('nilInspectorSmoke.search("needle103")'); await tick();
      assert.deepEqual((await run('nilInspectorSmoke.snapshot()')).instructions, [103]);
      await run('nilInspectorSmoke.search(""); nilInspectorSmoke.tab("Constants")'); await tick();
      snapshot = await run('nilInspectorSmoke.snapshot()');
      assert.match(snapshot.text, /<img src=x/);
      assert.equal(snapshot.injectedImages, 0);
      await run('nilInspectorSmoke.tab("Types")'); await tick();
      snapshot = await run('nilInspectorSmoke.snapshot()');
      assert.match(snapshot.text, /Point/); assert.match(snapshot.text, /virtual describe/);
      await run('nilInspectorSmoke.tab("Sources")'); await tick();
      snapshot = await run('nilInspectorSmoke.snapshot()');
      assert.match(snapshot.text, /stdlib\/core.ny/); assert.match(snapshot.text, /ny.core/);
      assert.equal(snapshot.mappedButtons, 0);
      await run('nilInspectorSmoke.tab("Instructions")'); await tick();
      await fs.writeFile(path.join(output, 'nil-inspector-dark.png'), (await window.webContents.capturePage()).toPNG());
      await run('nilInspectorSmoke.appearance({theme:"light",secondaryAccent:"#176f83"})'); await tick();
      await fs.writeFile(path.join(output, 'nil-inspector-light.png'), (await window.webContents.capturePage()).toPNG());
      const callsBefore = (await run('nilInspectorSmoke.snapshot()')).calls.length;
      await run('nilInspectorSmoke.refresh()'); await tick();
      await run('nilInspectorSmoke.click("Reload NIL")'); await tick();
      assert.equal((await run('nilInspectorSmoke.snapshot()')).calls.length, callsBefore + 2);
      await run('nilInspectorSmoke.open("broken.nil")'); await tick();
      assert.match((await run('nilInspectorSmoke.snapshot()')).text, /Unsupported NIL version 99/);
      await run('nilInspectorSmoke.repair(); nilInspectorSmoke.click("Try again")'); await tick();
      assert.match((await run('nilInspectorSmoke.snapshot()')).text, /Binary NIL v5/);
      await run('nilInspectorSmoke.open("slow.nil")'); await tick();
      await run('nilInspectorSmoke.open("other.nil")'); await tick();
      await run('nilInspectorSmoke.release()'); await tick();
      snapshot = await run('nilInspectorSmoke.snapshot()');
      assert.match(snapshot.text, /other-module/); assert.ok(!snapshot.text.includes('STALE MODULE'));
      assert.deepEqual(failures, []);
      console.log('NIL inspector smoke passed: structured metadata/instructions, pagination/filtering, safe constants, type/source views, validated navigation, rebuild/reload, errors and stale-request protection.');
      window.destroy(); app.exit(0);
    } catch (error) {
      console.error(error, failures);
      await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
      window.destroy(); app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
