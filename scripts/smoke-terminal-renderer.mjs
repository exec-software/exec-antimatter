#!/usr/bin/env node
/** Real terminal renderer and xterm, mocked IPC only. No shells, input devices, or network. */
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
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-terminal-smoke-'));
  const assets = process.argv[2] ?? path.join(root, 'dist-electron/renderer/assets');
  for (const name of await fs.readdir(assets)) if (/\.(css|woff2?)$/.test(name)) await fs.copyFile(path.join(assets, name), path.join(output, name));
  await build({ entryPoints: [path.join(root, 'test/fixtures/terminal-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' });
  const links = (await fs.readdir(output)).filter((name) => name.endsWith('.css')).map((name) => `<link rel="stylesheet" href="./${name}">`).join('');
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8">${links}</head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
  console.log(`Terminal smoke output: ${output}`);
  const child = spawn(electron, ['--ozone-platform=headless', '--ozone-override-screen-size=1280,960', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data')); app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`terminal-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, width: 800, height: 480, enableLargerThanScreen: true, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const failures = []; window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code).catch((error) => { console.error('Renderer expression failed:', code, failures); throw error; });
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 80))');
    const capture = async (name) => fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      // The App bridge starts selection and floats immediately; mounting must not start a shell.
      await run('window.opening = terminalSmoke.select("command", true); terminalSmoke.show(true)'); await run('opening'); await tick();
      assert.equal(await run('terminalSmoke.current()'), 'command');
      assert.deepEqual(await run('terminalSmoke.metrics.created'), []);
      assert.deepEqual(await run('terminalSmoke.metrics.killed'), []);
      assert.equal(await run('document.activeElement.classList.contains("xterm-helper-textarea")'), false, 'automatic command reveal does not steal typing focus');
      const text = await run('terminalSmoke.text()');
      assert.equal(text.match(/Before snapshot/g)?.length, 1); assert.equal(text.match(/password for tester/g)?.length, 1);
      assert.equal(await run(`document.querySelector('[aria-label="Restart this shell"]') === null`), true);
      await capture('terminal-command.png');
      await run('window.savedTerminal = terminalSmoke.sameTerminal(); window.savedText = terminalSmoke.text()');
      const darkTheme = await run('terminalSmoke.theme()');
      await run('terminalSmoke.appearance({ theme: "light", secondaryAccent: "#aa8cf4" })'); await tick();
      const lightTheme = await run('terminalSmoke.theme()');
      assert.notEqual(lightTheme.background, darkTheme.background);
      assert.notEqual(lightTheme.blue, darkTheme.blue);
      assert.equal(await run('terminalSmoke.sameTerminal() === savedTerminal'), true, 'appearance must not replace xterm');
      assert.equal(await run('terminalSmoke.text() === savedText'), true, 'appearance must preserve output and cursor buffer');
      assert.deepEqual(await run('terminalSmoke.metrics.created'), [], 'appearance must not restart a shell');
      await capture('terminal-light.png');
      await run('terminalSmoke.appearance({ theme: "dark", secondaryAccent: "#33b7a6" })'); await tick();
      assert.deepEqual(await run('terminalSmoke.theme()'), darkTheme);
      // User starts private typing while the incoming command's snapshot is still loading.
      await run('terminalSmoke.addCommand("delayed"); terminalSmoke.holdSnapshot("delayed"); window.delayedSelection = terminalSmoke.select("delayed", true); true'); await tick();
      await run('terminalSmoke.input(); terminalSmoke.releaseSnapshot("delayed")'); await run('delayedSelection'); await tick();
      assert.equal(await run('terminalSmoke.current()'), 'command', 'snapshot completion must recheck private input');
      await run('window.savedHost = terminalSmoke.sameHost(); terminalSmoke.show(false)'); await tick();
      await run('terminalSmoke.emit("command", "\\r\\nOutput while hidden\\r\\n"); terminalSmoke.show(true)'); await tick();
      await run('terminalSmoke.move()'); await tick();
      assert.equal(await run('terminalSmoke.sameHost() === savedHost'), true);
      assert.match(await run('terminalSmoke.text()'), /Output while hidden/);
      await run('terminalSmoke.start("/workspace/antimatter")'); await tick(); assert.equal(await run('terminalSmoke.current()'), 'manual');
      assert.deepEqual(await run('terminalSmoke.metrics.created'), []); assert.deepEqual(await run('terminalSmoke.metrics.killed'), []);
      await run('terminalSmoke.select("done")'); await tick(); assert.match(await run('terminalSmoke.text()'), /Tests passed/);
      assert.equal(await run(`document.querySelector('[aria-label="Stop this process"]').disabled`), true);
      await capture('terminal-completed.png');
      await run('terminalSmoke.addCommand("picked"); terminalSmoke.addCommand("arrival"); terminalSmoke.holdSnapshot("picked"); window.picking = terminalSmoke.select("picked"); true'); await tick();
      await run('terminalSmoke.select("arrival", true)');
      await run('terminalSmoke.releaseSnapshot("picked")'); await run('picking'); await tick();
      assert.equal(await run('terminalSmoke.current()'), 'picked', 'automatic arrival must not cancel explicit pending selection');
      await run('terminalSmoke.holdList(); window.polling = terminalSmoke.refresh(); true'); await tick();
      await run('terminalSmoke.addCommand("new-during-poll"); window.newSelection = terminalSmoke.select("new-during-poll"); true');
      await run('terminalSmoke.releaseList()'); await run('newSelection'); await tick();
      assert.equal(await run('terminalSmoke.current()'), 'new-during-poll', 'command missing from stale joined poll is retried once');
      await run('terminalSmoke.select("command")'); await tick(); await run('terminalSmoke.input()'); await tick();
      assert.deepEqual(await run('terminalSmoke.metrics.writeIds'), ['command', 'command']);
      assert.match(await run('document.body.innerText'), /Command output is withheld from the agent/);
      await run('terminalSmoke.select("done", true)'); await tick();
      assert.equal(await run('terminalSmoke.current()'), 'command', 'new automatic commands must not redirect private typing');
      await run(`document.querySelector('[aria-label="Stop this process"]').click()`); await tick();
      assert.deepEqual(await run('terminalSmoke.metrics.killed'), ['command']);
      assert.match(await run('document.body.innerText'), /Stopping…/);
      assert.equal(await run(`document.querySelector('[aria-label="Stop this process"]').disabled`), false, 'unconfirmed termination remains retryable');
      await run(`document.querySelector('[aria-label="Stop this process"]').click()`); await tick();
      await run('terminalSmoke.start("/workspace/antimatter")'); await tick(); await run('terminalSmoke.restart()'); await tick();
      assert.deepEqual(await run('terminalSmoke.metrics.killed'), ['command', 'command', 'manual']);
      assert.equal(await run('terminalSmoke.metrics.created.length'), 1);
      await run('terminalSmoke.select("command")'); await tick(); assert.match(await run('terminalSmoke.text()'), /Output while hidden/);
      assert.deepEqual(failures, []);
      console.log('Terminal smoke passed: exact command/exited selection, no orphan kills, manual cwd adoption, snapshot dedupe, hidden/moved screen persistence, private input routing and selected-only stop/restart.');
      window.destroy(); app.exit(0);
    } catch (error) { console.error(error, failures); await capture('terminal-failure.png'); window.destroy(); app.exit(1); }
  }).catch((error) => { console.error(error); app.exit(1); });
}
