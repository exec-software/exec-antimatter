#!/usr/bin/env node
/** Exercise rich notes and header controls in an isolated, network-disabled Electron renderer. */
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
  const { default: config } = await import('../tailwind.config.js');
  const root = path.resolve(path.dirname(filename), '..');
  const output = await fs.mkdtemp(path.join(process.env.ANTIMATTER_SMOKE_OUTPUT ?? os.tmpdir(), 'chat-workflows-'));
  await build({ entryPoints: [path.join(root, 'test/fixtures/chat-workflows-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' });
  const css = await postcss([tailwindcss(config)]).process(await fs.readFile(path.join(root, 'renderer/src/index.css'), 'utf8'), { from: path.join(root, 'renderer/src/index.css') });
  await fs.writeFile(path.join(output, 'fixture.css'), css.css);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="./fixture.css"></head><body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>');
  console.log(`Chat workflows smoke output: ${output}`);
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1440,1024', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 60_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data'));
  app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
  const isolated = session.fromPartition(`chat-workflows-${process.pid}`);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  const network = [];
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const cancel = !details.url.startsWith('file:') && !details.url.startsWith('data:');
    if (cancel) { network.push(details.url); }
    callback({ cancel });
  });
  const window = new BrowserWindow({ show: false, width: 1180, height: 880, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
  const errors = [];
  window.webContents.on('console-message', (event) => { if (event.level === 'error') { errors.push(event.message); } });
  const run = (code) => window.webContents.executeJavaScript(code);
  const tick = () => run('new Promise(resolve => setTimeout(resolve, 30))');
  const call = async (method, ...args) => { const value = await run(`workflowSmoke.${method}(${args.map((arg) => JSON.stringify(arg)).join(',')})`); await tick(); return value; };
  const snap = () => call('snapshot');
  const click = (label) => call('click', label);
  const key = async (keyCode) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode === 'Return' || keyCode === 'Space') { window.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? '\r' : ' ' }); }
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await tick();
  };
  try {
    await window.loadFile(path.join(output, 'index.html')); await tick();
    const markdown = '# Plan\n\nA **bold** and *italic* [link](https://example.com/a?q=1&x=2 "Docs").\n\n- [x] Complete\n- Nested\n  - child\n\n> Quote\n\n```ts\nconst value = `safe`;\n```\n\n| Left | Center | Right |\n| :--- | :---: | ---: |\n| A | B | C |\n\n![asset](https://tracking.example/image.png "caption")';
    const roundtrip = await call('roundtrip', markdown);
    assert.equal(roundtrip.html, roundtrip.original, roundtrip.markdown);
    for (const sample of [
      '3. Third\n4. Fourth\n   1. Inner\n\n- First paragraph\n\n- Second paragraph',
      'Text `a``b` and `` `ticks` `` and [plain](https://example.com).',
      '```cpp\nfirst();\n\n\n\nlast();\n```',
      '> ```rust\n> one();\n>\n>\n> three();\n> ```',
      '- Code\n\n  ```rust\n  one();\n\n\n  three();\n  ```',
      '| Code | Lines |\n| --- | --- |\n| `a\\|b` | first<br>second |',
    ]) {
      const result = await call('roundtrip', sample);
      assert.equal(result.html, result.original, result.markdown);
    }
    await call('update', markdown);
    await call('select', 'bold');
    await call('richInput');
    assert.equal((await snap()).selected, 'bold', 'autosave-style rerender must preserve selection');
    await click('Italic');
    assert.match((await snap()).markdown, /\*\*\*bold\*\*\*/);
    await click('Markdown');
    assert.equal(await run('document.querySelector("textarea").value'), (await snap()).markdown);
    await click('Write');
    assert.equal(await run('document.querySelector("[contenteditable] em strong, [contenteditable] strong em")?.textContent'), 'bold');
    await call('update', 'Before');
    await call('composition', 'compositionstart');
    await call('richHtml', '<p>Before 日本語</p>');
    assert.equal((await snap()).markdown, 'Before');
    await call('composition', 'compositionend');
    assert.equal((await snap()).markdown, 'Before 日本語');
    await call('select', 'Before');
    await call('plainPaste');
    assert.doesNotMatch((await snap()).rich, /<img/);
    await call('update', '<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n![track](https://tracking.example/pixel)');
    assert.equal(await run('document.querySelectorAll("script:not([src]), img, a[href]").length'), 0);
    assert.match((await snap()).rich, /&lt;script&gt;/);
    assert.deepEqual(network, []);

    await call('carbon');
    assert.equal((await snap()).clipboard, '7906ebbe-1111-2222-3333-444455556666');
    assert.deepEqual((await snap()).exports, []);
    await call('carbon', 2); await call('doubleCarbon');
    assert.deepEqual((await snap()).exports, ['7906ebbe-1111-2222-3333-444455556666']);
    await call('clipboardFailure'); await call('carbon');
    assert.match((await snap()).text, /Clipboard unavailable/);

    await click('Chat view: Transcript');
    assert.deepEqual((await snap()).menu, ['Transcript', 'Atlas', 'Research', 'Code', 'Flow']);
    window.webContents.focus(); await key('End');
    assert.equal((await snap()).active, 'Flow'); assert.equal((await snap()).mode, 'Chat view: Transcript');
    await key('Return'); assert.equal((await snap()).mode, 'Chat view: Flow');
    assert.equal((await snap()).active, 'Chat view: Flow');
    await key('Down'); await key('Home'); await key('Escape');
    assert.equal((await snap()).mode, 'Chat view: Flow'); assert.deepEqual((await snap()).menu, []);
    await key('Down'); await key('Tab');
    assert.equal(await run('document.activeElement.textContent'), 'Open notes');

    await click('Open notes'); assert.equal((await snap()).dialog, true);
    await call('richHtml', '<h2>Persist this</h2><p><b>Private</b> notes</p>');
    await click('Close chat notes'); assert.equal((await snap()).dialog, false);
    assert.equal((await snap()).saved[0].markdown, '## Persist this\n\n**Private** notes');
    await click('Open notes'); assert.match((await snap()).rich, /Persist this/);
    await fs.writeFile(path.join(output, 'notes-desktop.png'), (await window.webContents.capturePage()).toPNG());
    window.setContentSize(390, 844); await tick();
    assert.equal(await run('document.documentElement.scrollWidth > innerWidth'), false);
    const bounds = await run('(() => { const r = document.querySelector("[role=dialog]").getBoundingClientRect(); return { left:r.left,right:r.right,top:r.top,bottom:r.bottom }; })()');
    assert.ok(bounds.left >= 0 && bounds.right <= 390 && bounds.top >= 0 && bounds.bottom <= 844);
    await fs.writeFile(path.join(output, 'notes-narrow.png'), (await window.webContents.capturePage()).toPNG());
    await click('Close chat notes');
    assert.deepEqual(errors, []);
    console.log('Chat workflows smoke passed: Markdown roundtrip, safe HTML/links/images, selection, IME, paste, notes close/reopen, full carbon copy/double export, menu keyboard and focus.');
    window.destroy(); app.exit(0);
  } catch (error) {
    console.error(error, errors); console.error(await snap());
    await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
    window.destroy(); app.exit(1);
  }
  }).catch((error) => { console.error(error); app.exit(1); });
}
