#!/usr/bin/env node
/** Atlas navigation, document interactions, streaming, and approvals with synthetic data only. */
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
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-atlas-smoke-'));
  const assets = process.argv[2] ?? path.join(root, 'dist-electron/renderer/assets');
  for (const name of await fs.readdir(assets)) if (/\.(css|woff2?)$/.test(name)) await fs.copyFile(path.join(assets, name), path.join(output, name));
  // Compile current utilities so screenshots cover this new view before a full app rebuild.
  const css = await postcss([tailwindcss(tailwindConfig)]).process(await fs.readFile(path.join(root, 'renderer/src/index.css'), 'utf8'), { from: path.join(root, 'renderer/src/index.css') });
  await fs.writeFile(path.join(output, 'atlas.css'), css.css);
  await build({ entryPoints: [path.join(root, 'test/fixtures/atlas-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' });
  const links = '<link rel="stylesheet" href="./atlas.css"><link rel="stylesheet" href="./fixture.css">';
  await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8">${links}</head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
  console.log(`Atlas smoke output: ${output}`);
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1440,1024', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data')); app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`atlas-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, width: 1440, height: 1024, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const failures = []; window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 100))');
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      const snap = () => run('atlasSmoke.snapshot()');
      const click = async (label) => { await run(`atlasSmoke.click(${JSON.stringify(label)})`); await tick(); };
      const exchange = async (number) => { await run(`atlasSmoke.exchange(${number})`); await tick(); };
      const search = async (value) => { await run(`atlasSmoke.search(${JSON.stringify(value)})`); await tick(); };
      let state = await snap();
      assert.match(state.selected, /Open exchange 4:/); assert.equal(state.panels, 1);
      assert.equal(state.tab, 'Nova'); assert.equal(state.approvals, 1); assert.match(state.text, /Following latest/);
      await fs.writeFile(path.join(output, 'atlas-live.png'), (await window.webContents.capturePage()).toPNG());
      await exchange(1); state = await snap();
      assert.match(state.panel, /A small, verifiable launch/); assert.equal(state.approvals, 0);
      assert.match(state.text, /1 action needs approval in the live reply/);
      await run('atlasSmoke.append()'); await tick(); assert.equal((await snap()).panel, state.panel, 'Updates preserve the reader’s chosen exchange');
      await click('Unpin message'); assert.deepEqual((await snap()).calls, [['pin', 'a1']]);
      await click('Pin message'); await fs.writeFile(path.join(output, 'atlas-dark.png'), (await window.webContents.capturePage()).toPNG());

      await search('launch-checklist.md'); state = await snap();
      assert.equal(state.matches, 1); assert.equal(state.tab, 'Your prompt'); assert.match(state.panel, /launch-checklist.md/);
      await click('Nova'); assert.match((await snap()).panel, /fn main/);
      await click('Copy'); assert.ok((await snap()).calls.some((call) => call[0] === 'copy' && call[1].includes('fn main')));
      await click('Clear Atlas search'); await search('npm run check'); state = await snap();
      assert.equal(state.matches, 1); assert.equal(state.approvals, 1);
      await search('missing phrase xyz'); state = await snap(); assert.equal(state.panels, 0); assert.match(state.text, /No matching messages/);
      await click('Clear Atlas search');

      await exchange(2); await run('atlasSmoke.keyOnExchange("ArrowUp")'); await tick(); state = await snap();
      assert.match(state.selected, /Open exchange 1:/); assert.match(state.focus, /Open exchange 1:/);
      await run('atlasSmoke.keyOnExchange("End")'); await tick(); assert.match((await snap()).selected, /Open exchange 4:/);
      await run('atlasSmoke.keyOnExchange("Home")'); await tick(); assert.match((await snap()).selected, /Open exchange 1:/);
      await run('atlasSmoke.tabKey("ArrowLeft")'); await tick(); state = await snap(); assert.equal(state.tab, 'Your prompt'); assert.equal(state.focus, 'tab');
      await run('atlasSmoke.tabKey("End")'); await tick(); assert.equal((await snap()).tab, 'Nova');
      await click('1 action needs approval in the live replyOpen');
      assert.equal((await snap()).approvals, 1); await click('Allow'); state = await snap();
      assert.ok(state.calls.some((call) => call[0] === 'approval' && call[1] === 'approval-build-check' && call[2] === true)); assert.equal(state.approvals, 0);

      await run(`atlasSmoke.append(${JSON.stringify('\n\n' + 'Recorded detail for the workspace.\n\n'.repeat(90))})`); await tick();
      assert.ok((await snap()).scroll.remaining < 4, 'The latest reply follows streamed output');
      await run('atlasSmoke.scroll("top")'); await tick(); await run('atlasSmoke.append()'); await tick(); state = await snap();
      assert.ok(state.scroll.top < 4, 'Reading earlier content holds position while new output arrives'); assert.match(state.text, /New activity below/);
      await click('New activity below'); assert.ok((await snap()).scroll.remaining < 4);
      await run('atlasSmoke.finish()'); await tick(); assert.doesNotMatch((await snap()).panel, /Live reply/);

      await exchange(1); const accent = (await snap()).accent;
      await run('atlasSmoke.appearance({theme:"light",secondaryAccent:"#176f83"})'); await tick();
      state = await snap(); assert.notEqual(state.accent, accent); assert.equal(state.documentOverflow, false);
      await fs.writeFile(path.join(output, 'atlas-light.png'), (await window.webContents.capturePage()).toPNG());
      window.setContentSize(480, 800); await tick(); state = await snap();
      assert.equal(state.navVisible, false); assert.equal(state.documentOverflow, false);
      await click('Explore map'); assert.equal((await snap()).navVisible, true);
      await exchange(2); state = await snap(); assert.equal(state.navVisible, false); assert.equal(state.focus, 'tabpanel');
      await fs.writeFile(path.join(output, 'atlas-narrow.png'), (await window.webContents.capturePage()).toPNG());
      await click('Explore map'); await search('launch-checklist.md'); assert.equal((await snap()).matches, 1);
      await exchange(2); assert.match((await snap()).panel, /launch-checklist.md/); assert.equal((await snap()).documentOverflow, false);
      await run('atlasSmoke.empty()'); await tick(); assert.match((await snap()).text, /A map of your conversation/);
      assert.deepEqual(failures, []);
      console.log('Atlas smoke passed: map/search/keyboard navigation, one reading document, personality attribution, attachments, code copy, pin callback, scoped approvals, stable browsing while streaming, live scroll recovery, light/accent/narrow layouts, and empty state.');
      window.destroy(); app.exit(0);
    } catch (error) {
      console.error(error, failures); console.error(await run('atlasSmoke.snapshot()'));
      await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
      window.destroy(); app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
