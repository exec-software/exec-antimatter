#!/usr/bin/env node
/** Real React outline, synthetic SDK responses; no workspace or SDK writes. */
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
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-ny-outline-smoke-'));
  const assets = process.argv[2] ?? path.join(root, 'dist-electron/renderer/assets');
  for (const name of await fs.readdir(assets)) if (/\.(css|woff2?)$/.test(name)) await fs.copyFile(path.join(assets, name), path.join(output, name));
  await build({ entryPoints: [path.join(root, 'test/fixtures/ny-outline-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' });
  const links = (await fs.readdir(output)).filter((name) => name.endsWith('.css')).map((name) => `<link rel="stylesheet" href="./${name}">`).join('');
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8">${links}</head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
  console.log(`Ny outline smoke output: ${output}`);
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1280,960', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data')); app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`ny-outline-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, width: 500, height: 600, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const failures = []; window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = (delay = 100) => run(`new Promise(resolve => setTimeout(resolve, ${delay}))`);
    const snapshot = () => run('nyOutlineSmoke.snapshot()');
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick(400);
      assert.deepEqual((await snapshot()).labels, ['Function alpha, line 1', 'Function beta, line 3']);
      await run('document.querySelectorAll("li button")[1].click()');
      assert.deepEqual((await snapshot()).revealed, { path: 'main.ny', line: 3 });
      await run('nyOutlineSmoke.filter("beta")'); await tick();
      assert.deepEqual((await snapshot()).labels, ['Function beta, line 3']);
      await run('nyOutlineSmoke.filter("")');
      await run('nyOutlineSmoke.file("main.ny", "fn unsaved()\\nend fn\\n")'); await tick(400);
      assert.deepEqual((await snapshot()).labels, ['Function unsaved, line 1']);
      assert.equal((await snapshot()).calls.at(-1).text, 'fn unsaved()\nend fn\n');

      await run('nyOutlineSmoke.mode("deferred"); nyOutlineSmoke.file("main.ny", "fn stale()\\nend fn\\n")'); await tick(300);
      assert.equal((await snapshot()).pending, 1);
      await run('nyOutlineSmoke.file("other.ny", "fn fresh()\\nend fn\\n")'); await tick(300);
      assert.equal((await snapshot()).pending, 2);
      await run('nyOutlineSmoke.resolve()'); await tick();
      assert.deepEqual((await snapshot()).labels, []);
      await run('nyOutlineSmoke.resolve()'); await tick();
      assert.deepEqual((await snapshot()).labels, ['Function fresh, line 1']);
      await run('document.querySelector("li button").click()');
      assert.deepEqual((await snapshot()).revealed, { path: 'other.ny', line: 1 });

      await run('nyOutlineSmoke.mode("error"); document.querySelector("aside > div button").click()'); await tick(400);
      assert.match((await snapshot()).error, /Synthetic SDK unavailable/);
      assert.deepEqual((await snapshot()).labels, []);
      await run('nyOutlineSmoke.mode("immediate"); nyOutlineSmoke.file("other.ny", "fn <script>()\\nend fn\\n")'); await tick(400);
      assert.deepEqual((await snapshot()).labels, ['Function <script>, line 1']);
      assert.equal(await run('document.querySelectorAll("aside script").length'), 0);
      assert.deepEqual(failures, []);
      await fs.writeFile(path.join(output, 'outline.png'), (await window.webContents.capturePage()).toPNG());
      console.log('Ny outline smoke passed: filtering, source navigation, unsaved buffers, stale response rejection, SDK failure recovery, and literal symbol text.');
      window.destroy(); app.exit(0);
    } catch (error) {
      console.error(error, failures);
      await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
      window.destroy(); app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
