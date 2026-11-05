#!/usr/bin/env node
/** Real sidebar with synthetic chats and isolated localStorage. Never touches user preferences. */
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
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-sidebar-visibility-smoke-'));
  const assets = process.argv[2] ?? path.join(root, 'dist-electron/renderer/assets');
  for (const name of await fs.readdir(assets)) if (/\.(css|woff2?)$/.test(name)) await fs.copyFile(path.join(assets, name), path.join(output, name));
  // Compile current utilities so screenshots cover this new view before a full app rebuild.
  const css = await postcss([tailwindcss(tailwindConfig)]).process(await fs.readFile(path.join(root, 'renderer/src/index.css'), 'utf8'), { from: path.join(root, 'renderer/src/index.css') });
  await fs.writeFile(path.join(output, 'sidebar-visibility.css'), css.css);
  await build({ entryPoints: [path.join(root, 'test/fixtures/sidebar-visibility-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' });
  const links = '<link rel="stylesheet" href="./sidebar-visibility.css">';
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8">${links}</head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
  console.log(`Sidebar visibility smoke output: ${output}`);
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1440,1024', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data')); app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`sidebar-visibility-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, width: 1440, height: 1024, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const failures = []; window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 100))');
    const key = async (keyCode) => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      if (keyCode === 'Return' || keyCode === 'Space') window.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? '\r' : ' ' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      await tick();
    };
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      const snap = () => run('sidebarSmoke.snapshot()');
      const toggle = async (label) => { await run(`sidebarSmoke.toggle(${JSON.stringify(label)})`); await tick(); };
      const click = async (label) => { await run(`sidebarSmoke.click(${JSON.stringify(label)})`); await tick(); };
      let snapshot = await snap();
      const optional = ['Agents', 'Memory', 'Code', 'Tools', 'Skills', 'Plugins', 'Models', 'Orchestrator', 'Scheduled', 'Pull requests', 'Developer', "What's New"];
      for (const label of optional) assert.ok(snapshot.buttons.includes(label), `${label} visible by default`);
      assert.deepEqual(snapshot.sections, ['Pinned', 'Projects', 'Claude chats', 'Codex chats', 'OpenCode chats', 'Recent']);
      assert.ok(!snapshot.buttons.includes('Bot chat'));
      const originalThreads = snapshot.threads;
      const originalExpansion = snapshot.expansion;
      assert.match(snapshot.text, /Unsaved draft remains here/); assert.match(snapshot.text, /Working/);

      // Exercise actual Chromium keyboard activation and focus, rather than synthetic click handlers.
      window.webContents.focus();
      await run('sidebarSmoke.focus("Customize sidebar")'); await key('Return');
      snapshot = await snap(); assert.equal(snapshot.dialog, true); assert.equal(snapshot.focus, 'Agents');
      assert.equal(snapshot.checked['Bot chat'], undefined);
      await key('Space'); snapshot = await snap(); assert.equal(snapshot.checked.Agents, false); assert.ok(!snapshot.buttons.includes('Agents'));
      await key('Escape'); snapshot = await snap(); assert.equal(snapshot.dialog, false); assert.equal(snapshot.focus, 'Customize sidebar');
      await click('Customize sidebar');
      await run('sidebarSmoke.bot(true)'); await tick();
      snapshot = await snap(); assert.equal(snapshot.checked['Bot chat'], true); assert.ok(snapshot.buttons.includes('Bot chat'));
      await toggle('Bot chat'); assert.ok(!(await snap()).buttons.includes('Bot chat'));
      await toggle('Claude chats'); snapshot = await snap();
      assert.ok(!snapshot.sections.includes('Claude chats')); assert.ok(snapshot.sections.includes('Codex chats')); assert.ok(snapshot.sections.includes('OpenCode chats'));
      await toggle('Codex chats'); await toggle('OpenCode chats'); await toggle('Pinned'); await toggle('Projects'); await toggle('Recent');
      await toggle('Developer'); await toggle("What's New");
      snapshot = await snap(); assert.deepEqual(snapshot.sections, []); assert.deepEqual(snapshot.threads, originalThreads);
      await fs.writeFile(path.join(output, 'sidebar-customize-dark.png'), (await window.webContents.capturePage()).toPNG());
      await run('sidebarSmoke.outside()'); await tick(); assert.equal((await snap()).dialog, false);

      await run('sidebarSmoke.search("find")'); await tick();
      snapshot = await snap(); assert.match(snapshot.text, /Matching chats in hidden sections/);
      assert.deepEqual(snapshot.rows.sort(), ['claude', 'codex', 'native', 'opencode', 'pinned']);
      assert.ok(!snapshot.sections.includes('Projects')); assert.equal(snapshot.expansion, originalExpansion);
      await run('sidebarSmoke.openThread("pinned")'); await tick(); assert.deepEqual((await snap()).actions, [['open', 'pinned']]);
      await run('sidebarSmoke.search("")'); await tick(); assert.deepEqual((await snap()).sections, []);

      await click('Customize sidebar'); await run('sidebarSmoke.hideAll()'); await tick(); await click('Done');
      snapshot = await snap();
      for (const label of optional) assert.ok(!snapshot.buttons.includes(label), `${label} hidden`);
      for (const label of ['New chat', 'Chats', 'Settings', 'Customize sidebar']) assert.ok(snapshot.buttons.includes(label), `${label} remains reachable`);
      assert.deepEqual(snapshot.sections, []); assert.equal(Object.values(snapshot.saved).some(Boolean), false);
      await fs.writeFile(path.join(output, 'sidebar-minimal.png'), (await window.webContents.capturePage()).toPNG());
      window.webContents.reload(); await new Promise((resolve) => window.webContents.once('did-finish-load', resolve)); await tick();
      snapshot = await snap(); assert.equal(Object.values(snapshot.saved).some(Boolean), false);
      assert.deepEqual(snapshot.sections, []); assert.ok(!snapshot.buttons.includes('Models'));
      await click('New chat'); await click('Settings'); await click('Chats');
      assert.deepEqual((await snap()).actions, [['new'], ['page', 'settings'], ['page', 'chat']]);
      await click('Customize sidebar'); await click('Show all'); snapshot = await snap();
      assert.deepEqual(snapshot.saved, snapshot.defaultVisibility); assert.equal(snapshot.checked['Bot chat'], undefined);
      assert.ok(!snapshot.buttons.includes('Bot chat'), 'Show all does not enable a disabled feature');
      await click('Done');
      for (const label of optional) assert.ok((await snap()).buttons.includes(label), `${label} restored`);
      assert.equal((await snap()).expansion, originalExpansion, 'Show all preserves import collapse preferences');

      await click('Code'); assert.match((await snap()).text, /No directory open/);
      await click('Customize sidebar'); await toggle('Code'); await click('Done');
      assert.match((await snap()).text, /Current view: environment/);
      await click('Back to chat'); assert.ok(!(await snap()).buttons.includes('Code'));
      await click('Customize sidebar'); await run('sidebarSmoke.appearance({theme:"light",secondaryAccent:"#176f83"})'); await tick();
      snapshot = await snap(); assert.notEqual(snapshot.accents.checkbox, 'auto');
      assert.match(snapshot.accents.checkbox, /^rgb/);
      await fs.writeFile(path.join(output, 'sidebar-customize-light.png'), (await window.webContents.capturePage()).toPNG());
      // Native Tab traverses the dialog; Escape remains available after keyboard navigation.
      await run('sidebarSmoke.focus("Close sidebar customization")'); await key('Tab'); assert.equal((await snap()).focus, 'Agents');
      await key('Escape'); assert.equal((await snap()).dialog, false);
      await run('sidebarSmoke.externalReset()'); await tick(); assert.ok((await snap()).buttons.includes('Code'));
      window.setContentSize(760, 560); await tick(); await click('Customize sidebar');
      snapshot = await snap(); assert.ok(snapshot.panel.left >= 0 && snapshot.panel.top >= 0);
      assert.ok(snapshot.panel.right <= snapshot.panel.width && snapshot.panel.bottom <= snapshot.panel.height);
      await fs.writeFile(path.join(output, 'sidebar-customize-small.png'), (await window.webContents.capturePage()).toPNG());
      assert.deepEqual(failures, []);
      console.log('Sidebar smoke passed: default visibility, individual groups, keyboard/Space/Escape/focus, outside dismissal, search recovery, no data changes, persistent hide-all, always-available controls and Show all, Bot chat feature gating, Code access, theme accent, cross-window preference reset, and small viewport bounds.');
      window.destroy(); app.exit(0);
    } catch (error) {
      console.error(error, failures);
      console.error(await run('sidebarSmoke.snapshot()'));
      await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
      window.destroy(); app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
