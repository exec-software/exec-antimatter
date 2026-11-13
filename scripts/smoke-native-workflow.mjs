#!/usr/bin/env node
/** Isolated native project and board UI; host compiler integration is covered separately. */
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
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-native-workflow-'));
  const assets = process.argv[2] ?? path.join(root, 'dist-electron/renderer/assets');
  for (const name of await fs.readdir(assets)) if (/\.(css|woff2?)$/.test(name)) await fs.copyFile(path.join(assets, name), path.join(output, name));
  await build({ entryPoints: [path.join(root, 'test/fixtures/native-workflow-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' });
  const links = (await fs.readdir(output)).filter((name) => name.endsWith('.css')).map((name) => `<link rel="stylesheet" href="./${name}">`).join('');
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8">${links}</head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
  console.log(`Code workspace smoke output: ${output}`);
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1280,960', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data')); app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`native-workflow-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const failures = []; window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 150))');
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      const screenshot = async name => fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
      const click = async label => { await run(`nativeSmoke.click(${JSON.stringify(label)})`); await tick(); };
      const change = async (label, value) => { await run(`nativeSmoke.change(${JSON.stringify(label)}, ${JSON.stringify(value)})`); await tick(); };
      const snapshot = () => run('nativeSmoke.snapshot()');
      const press = async (key, modifiers = {}) => { await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(modifiers)} }))`); await tick(); };
      await run('nativeSmoke.open()'); await tick();
      let current = await snapshot();
      assert.match(current.text, /Rust · Cargo/);
      await run('nativeSmoke.edit()'); await click('Build');
      current = await snapshot();
      assert.deepEqual(current.calls.slice(0, 2).map(item => item.method), ['save', 'build']);
      assert.equal(current.state.nativeResult.success, true);
      await change('Native build profile', 'release'); await change('Native build target', 'demo');
      await click('Project toolchain and arguments'); await change('Program arguments', 'first argument\n--check');
      await click('Run'); current = await snapshot();
      assert.deepEqual(current.state.run.spec.args, ['first argument', '--check']);
      assert.equal(current.calls.at(-1).input.profile, 'release');
      await click('Test'); assert.equal((await snapshot()).calls.at(-1).method, 'test');
      await run('nativeSmoke.compilerFailure(true)'); await click('Check');
      current = await snapshot(); assert.equal(current.state.diagnostics.length, 1); assert.match(current.text, /Synthetic Rust error/);
      await run('nativeSmoke.compilerFailure(false)');
      await click('Project toolchain and arguments'); await click('Show project board');
      await click('Add open file'); await click('Save board');
      current = await snapshot(); assert.equal(current.board.cards.length, 1);
      await click('New module'); await change('Module name', 'helper'); await click('Create module');
      await click('Save board'); current = await snapshot(); assert.equal(current.board.cards.length, 2);
      assert.equal(current.calls.find(item => item.method === 'createSource').input.path, 'src/helper.rs');
      const main = current.board.cards.find(card => card.path === 'src/main.rs');
      const helper = current.board.cards.find(card => card.path === 'src/helper.rs');
      await change('Dependency source', main.id); await change('Dependency module', helper.id); await click('Connect');
      current = await snapshot(); assert.equal(current.board.edges.length, 1); assert.match(current.files['src/main.rs'], /mod helper;/);
      await run(`document.querySelector('[aria-label="Move helper"]').focus()`);
      window.webContents.focus(); window.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'}); window.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'}); await tick();
      assert.equal((await snapshot()).state.board.cards.find(card => card.id === helper.id).x, helper.x + 8);
      await click('Save board');
      await screenshot('native-board-dark.png');
      await click('src/main.rs'); current = await snapshot();
      assert.equal(current.state.activePath, 'src/main.rs'); assert.match(current.state.files.find(file => file.path === 'src/main.rs').text, /mod helper;/);
      await run('nativeSmoke.edit(); nativeSmoke.failSave(true)'); await click('Build');
      current = await snapshot(); assert.match(current.state.error, /Synthetic save conflict/);
      await run('nativeSmoke.failSave(false)'); await click('Save');
      await run('nativeSmoke.conflict()'); await click('Show project board');
      await change('Card label', 'Main entry'); await click('Save board');
      current = await snapshot(); assert.ok(current.state.boardConflict); assert.ok(current.dirty.includes('.antimatter/project-board.json'));
      await click('Keep my board'); current = await snapshot(); assert.equal(current.state.boardConflict, null);
      assert.equal(current.board.cards.find(card => card.id === main.id).label, 'Main entry');
      await window.setSize(800, 760); await tick();
      assert.ok(await run('document.documentElement.scrollWidth <= innerWidth'));
      await screenshot('native-board-narrow.png');
      assert.deepEqual(failures, []);
      console.log('Native workflow smoke passed: save-before-build, Cargo profile/target/argv, check/test/results, board module creation/source navigation/dependency/keyboard layout, conflict recovery and narrow layout.');
      window.destroy(); app.exit(0);
    } catch (error) {
      console.error(error, failures);
      await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
      window.destroy(); app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
