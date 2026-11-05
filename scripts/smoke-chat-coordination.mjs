#!/usr/bin/env node
/** Synthetic chat mailbox IPC in the real panel, header and composer. No real chats or providers. */
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
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-chat-coordination-smoke-'));
  const assets = process.argv[2] ?? path.join(root, 'dist-electron/renderer/assets');
  for (const name of await fs.readdir(assets)) if (/\.(css|woff2?)$/.test(name)) await fs.copyFile(path.join(assets, name), path.join(output, name));
  // Compile current utilities so screenshots cover this new view before a full app rebuild.
  const css = await postcss([tailwindcss(tailwindConfig)]).process(await fs.readFile(path.join(root, 'renderer/src/index.css'), 'utf8'), { from: path.join(root, 'renderer/src/index.css') });
  await fs.writeFile(path.join(output, 'chat-coordination.css'), css.css);
  await build({ entryPoints: [path.join(root, 'test/fixtures/chat-coordination-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' });
  const links = '<link rel="stylesheet" href="./chat-coordination.css">';
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8">${links}</head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
  console.log(`Chat coordination smoke output: ${output}`);
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1280,960', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data')); app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`chat-coordination-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, width: 1080, height: 1000, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const failures = []; window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 150))');
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      let snapshot = await run('coordinationSmoke.snapshot()');
      assert.match(snapshot.text, /read each other’s visible user and assistant messages/);
      assert.match(snapshot.text, /stays enabled until you disconnect/);
      assert.match(snapshot.badge, /1 queued notes/);
      assert.equal(snapshot.calls.filter(call => call.startsWith('connect:')).length, 0);
      assert.deepEqual(snapshot.calls.slice(0, 2), ['checkpoint:a', 'state:a']);
      assert.equal(snapshot.images, 0); assert.match(snapshot.text, /<img src=x/);
      assert.match(snapshot.text, /Agent note from/); assert.match(snapshot.text, /Added to a turn/);
      assert.equal(snapshot.continuations.length, 0);
      const draft = snapshot.draft;
      await run('coordinationSmoke.click("Connect API review")'); await tick();
      snapshot = await run('coordinationSmoke.snapshot()');
      assert.ok(snapshot.buttons.includes('Disconnect API review'));
      const connection = snapshot.calls.indexOf('connect:a:b');
      assert.equal(snapshot.calls[connection - 1], 'checkpoint:a');
      await run('coordinationSmoke.click("Disconnect API review")'); await tick();
      assert.ok((await run('coordinationSmoke.snapshot()')).buttons.includes('Connect API review'));
      await run('coordinationSmoke.failConnect(true); coordinationSmoke.click("Connect API review")'); await tick();
      assert.match((await run('coordinationSmoke.snapshot()')).alert, /working folder changed/);
      assert.ok((await run('coordinationSmoke.snapshot()')).buttons.includes('Connect API review'));
      await run('coordinationSmoke.failConnect(false); coordinationSmoke.click("Refresh connected chats")'); await tick();
      await run('coordinationSmoke.peerRunning(true)'); await tick();
      assert.match((await run('coordinationSmoke.snapshot()')).text, /Not connected · Working/);
      await run('coordinationSmoke.click("Sent")'); await tick();
      snapshot = await run('coordinationSmoke.snapshot()');
      assert.match(snapshot.text, /Agent note to/); assert.match(snapshot.text, /Please check the API types/);
      assert.ok(!snapshot.buttons.some(label => label?.startsWith('Dismiss')));
      await run('coordinationSmoke.click("Received")'); await tick();
      await fs.writeFile(path.join(output, 'chat-coordination-dark.png'), (await window.webContents.capturePage()).toPNG());
      await run('coordinationSmoke.appearance({theme:"light",secondaryAccent:"#176f83"})'); await tick();
      await fs.writeFile(path.join(output, 'chat-coordination-light.png'), (await window.webContents.capturePage()).toPNG());
      await run('coordinationSmoke.click("Continue with notes")'); await tick();
      snapshot = await run('coordinationSmoke.snapshot()');
      assert.deepEqual(snapshot.continuations, ['Continue with the notes from connected chats.']);
      assert.deepEqual(snapshot.draft, draft);
      assert.ok(!snapshot.buttons.includes('Continue with notes'));
      assert.match(snapshot.text, /without interrupting its current action/);
      await run('coordinationSmoke.click("Dismiss note from API review")'); await tick();
      snapshot = await run('coordinationSmoke.snapshot()');
      assert.match(snapshot.text, /Dismissed/); assert.equal(snapshot.badge, 'Connected chats');
      assert.deepEqual(snapshot.draft, draft);
      await run('coordinationSmoke.click("API review")'); await tick();
      assert.deepEqual((await run('coordinationSmoke.snapshot()')).opened, ['b']);
      await run('coordinationSmoke.thread("slow")'); await tick();
      await run('coordinationSmoke.thread("c")'); await tick();
      await run('coordinationSmoke.releaseState()'); await tick();
      snapshot = await run('coordinationSmoke.snapshot()');
      assert.match(snapshot.text, /Choose a working folder/); assert.ok(!snapshot.text.includes('STALE-FOLDER'));
      await run('coordinationSmoke.thread("a"); coordinationSmoke.slowConnect(true)'); await tick();
      await run('coordinationSmoke.click("Connect API review")'); await tick();
      await run('coordinationSmoke.thread("c")'); await tick();
      await run('coordinationSmoke.releaseConnect()'); await tick();
      snapshot = await run('coordinationSmoke.snapshot()');
      assert.match(snapshot.text, /Other project/); assert.ok(!snapshot.buttons.includes('Disconnect API review'));
      await run('coordinationSmoke.api(false)'); await tick();
      assert.match((await run('coordinationSmoke.snapshot()')).text, /unavailable in this window/);
      await run('coordinationSmoke.failCheckpoint(true); coordinationSmoke.api(true)'); await tick();
      assert.match((await run('coordinationSmoke.snapshot()')).alert, /Could not save the working folder/);
      assert.deepEqual(failures, []);
      console.log('Chat coordination smoke passed: explicit connections/revocation, checkpoint order, attributed safe notes, delivery status, lifecycle badges, dismiss, source navigation, explicit continuation and real composer draft preservation, stale responses, missing API and errors.');
      window.destroy(); app.exit(0);
    } catch (error) {
      console.error(error, failures);
      await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
      window.destroy(); app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
