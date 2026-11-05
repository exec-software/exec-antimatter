#!/usr/bin/env node
/** Isolated renderer checks: fake picker/IPC/clipboard, no real history or app startup. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const filename = fileURLToPath(import.meta.url);
if (!process.versions.electron) {
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  const assets = path.resolve(process.argv[2] || 'dist-electron/renderer/assets');
  const css = (await fs.readdir(assets)).find((name) => /^main-.*\.css$/.test(name));
  assert.ok(css, 'Pass a built renderer assets directory.');
  const output = await fs.mkdtemp('/var/tmp/antimatter-chat-import-ui-');
  await build({ entryPoints: [path.resolve(path.dirname(filename), '../test/fixtures/chat-import-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.js': 'jsx' } });
  await fs.copyFile(path.join(assets, css), path.join(output, 'fixture.css'));
  for (const name of await fs.readdir(assets)) if (/\.(woff2?|ttf)$/.test(name)) await fs.copyFile(path.join(assets, name), path.join(output, name));
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\'; img-src \'none\'; connect-src \'none\'"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
  console.log(`Chat import UI output: ${output}`);
  const child = spawn(electron, ['--ozone-platform=headless', '--ozone-override-screen-size=1440,1100', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const timeout = setTimeout(() => { console.error('Isolated import UI fixture timed out.'); child.kill(); process.exitCode = 1; }, 30_000);
  child.on('error', (error) => { console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(timeout); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data'));
  app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`chat-import-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, answer) => answer({ cancel: !details.url.startsWith('file:') }));
    const window = new BrowserWindow({ show: false, width: 1160, height: 900, enableLargerThanScreen: true, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const errors = [];
    window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 60))');
    const click = async (label) => {
      await run(`(() => { const item = [...document.querySelectorAll('button')].find(b => b.checkVisibility() && (b.getAttribute('aria-label') === ${JSON.stringify(label)} || b.textContent.trim() === ${JSON.stringify(label)})); if (!item || item.disabled) throw Error('Unavailable button: ' + ${JSON.stringify(label)}); item.click(); })()`); await tick();
    };
    const search = async (value) => {
      await run(`(() => { const input = document.querySelector('[aria-label="Search fixture chats"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', {bubbles:true})); })()`); await tick();
    };
    const screenshot = async (name) => fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      assert.deepEqual(await run('importSmoke.actions'), [], 'opening developer must not read chats or run tools');
      assert.equal(await run('document.querySelectorAll("textarea").length'), 8);
      await run('document.querySelector("#model-test-prompts-title").scrollIntoView(); document.querySelector("section[aria-labelledby=model-test-prompts-title] details details > summary").click()'); await tick();
      await run('document.querySelector("[aria-label^=\\"Copy full prompt:\\"]").click()'); await tick();
      assert.equal(await run('importSmoke.copy[0] === importSmoke.expectedPrompt'), true);
      await run('importSmoke.failCopy(); document.querySelector("[aria-label^=\\"Copy full prompt:\\"]").click()'); await tick();
      assert.equal(await run('document.activeElement.tagName'), 'TEXTAREA');
      assert.equal(await run('document.activeElement.selectionEnd - document.activeElement.selectionStart === importSmoke.expectedPrompt.length'), true);
      await screenshot('developer-model-prompts.png');
      await click('Import Codex chats');
      assert.equal(await run('document.querySelector("h1").textContent'), 'Import Codex chats');
      assert.deepEqual(await run('importSmoke.actions'), [], 'opening import must not read sessions until requested');
      await run('importSmoke.cancel()'); await click('Choose files');
      assert.equal(await run('document.querySelector("#import-review")'), null);
      await click('Choose session folder');
      assert.equal(await run('document.querySelector("[aria-label=\\"Import Already copied\\"]").disabled'), true);
      assert.equal(await run('[...document.querySelectorAll("button")].find(b => b.textContent === "Import 0 selected").disabled'), true);
      await click('Select available (1)');
      await screenshot('chat-import-review-dark.png');
      await run('importSmoke.light()'); await tick();
      await screenshot('chat-import-review-light.png');
      await run('importSmoke.fail()'); await click('Import 1 selected');
      assert.match(await run('document.querySelector("[role=alert]").textContent'), /disk full/);
      assert.equal(await run('document.querySelector("[data-thread-row=imported]")'), null);
      await click('Import 1 selected');
      assert.match(await run('document.querySelector("section[aria-label=\\"Import result\\"]").textContent'), /Imported 1 chat/);
      assert.equal(await run('document.querySelectorAll("[data-thread-row=imported]").length'), 1, 'imported row is not duplicated in Recent');
      assert.equal(await run('document.querySelector("[data-thread-row=native]").textContent.includes("Unsaved work")'), true);
      await click('Toggle Codex chats');
      assert.equal(await run('document.querySelector("[data-thread-row=imported]").checkVisibility()'), true);
      await click('Toggle Codex chats');
      await search('library');
      assert.equal(await run('document.querySelector("[data-thread-row=imported]").checkVisibility()'), true);
      assert.equal(await run('document.querySelector("[aria-label=\\"Toggle Codex chats\\"]").disabled'), true);
      await search('');
      assert.equal(await run('document.querySelector("[data-thread-row=imported]").checkVisibility()'), false, 'search did not overwrite saved collapse choice');
      await click('Toggle Codex chats');
      await click('Open first imported chat');
      assert.deepEqual(await run('importSmoke.actions.at(-1)'), ['open', 'imported']);
      await screenshot('chat-import-result-sidebar.png');
      await click('Import Claude chats'); await click('Choose files');
      const batch = await run('importSmoke.actions.filter(a => a[0] === "choose").length');
      assert.equal(batch, 3);
      await click('Developer');
      assert.equal(await run('importSmoke.actions.at(-1)[0]'), 'discard', 'leaving import discards its staged batch');
      await click('Import OpenCode chats');
      assert.equal(await run('document.querySelector("h1").textContent'), 'Import OpenCode chats');
      assert.match(await run('document.querySelector("main").textContent'), /opencode export SESSION_ID/);
      assert.equal(await run('document.querySelector("#import-review")'), null);
      assert.equal(await run('importSmoke.actions.filter(a => a[0] === "choose").length'), 3, 'opening OpenCode import must not read data');
      await click('Choose export folder');
      assert.deepEqual(await run('importSmoke.actions.at(-1)'), ['choose', 'opencode', 'folder']);
      assert.match(await run('document.querySelector("main").textContent'), /OpenCode export/);
      assert.match(await run('document.querySelector("main").textContent'), /Date unavailable/);
      await click('Select available (1)');
      await screenshot('chat-import-opencode-review.png');
      await click('Import 1 selected');
      assert.equal(await run('document.querySelectorAll("[data-thread-row=imported-opencode]").length'), 1);
      await click('Toggle OpenCode chats');
      assert.equal(await run('document.querySelector("[data-thread-row=imported-opencode]").checkVisibility()'), true);
      await click('Open first imported chat');
      assert.deepEqual(await run('importSmoke.actions.at(-1)'), ['open', 'imported-opencode']);
      window.setSize(700, 900); await tick();
      assert.equal(await run('document.documentElement.scrollWidth <= window.innerWidth'), true);
      assert.deepEqual(errors, []);
      console.log('Import/developer UI smoke passed: exact prompt copy/manual fallback, inert opening, picker cancel, preview selection/duplicates, failed-save retry, Claude/Codex/OpenCode sidebar grouping, search, draft retention, preview cleanup, dark/light/responsive layouts.');
      window.destroy(); app.exit(0);
    } catch (error) { console.error(error); await screenshot('failure.png'); window.destroy(); app.exit(1); }
  }).catch((error) => { console.error(error); app.exit(1); });
}
