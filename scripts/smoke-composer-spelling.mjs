#!/usr/bin/env node
/** Real native spelling + React drafts, using only an explicitly supplied stock dictionary. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const filename = fileURLToPath(import.meta.url);
if (!process.versions.electron) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node scripts/smoke-composer-spelling.mjs --dictionary /path/to/en-US-10-1.bdic\nLinux requires Xvfb and xdotool. Use ANTIMATTER_XVFB_BINARY to override the Xvfb executable.\nStarts a private virtual display and copies only that stock dictionary to a temporary profile. No network, real chats, or live app access.');
    process.exit(0);
  }
  assert.equal(process.argv[2], '--dictionary', 'Pass --dictionary with a cached stock English dictionary.');
  assert.equal(process.argv.length, 4);
  const dictionary = path.resolve(process.argv[3]);
  assert.equal(path.basename(dictionary), 'en-US-10-1.bdic');
  assert.ok((await fs.lstat(dictionary)).isFile(), 'Dictionary must be a regular file.');
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  const root = path.resolve(path.dirname(filename), '..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-composer-spelling-'));
  await fs.mkdir(path.join(output, 'user-data', 'Dictionaries'), { recursive: true });
  await fs.copyFile(dictionary, path.join(output, 'user-data', 'Dictionaries', path.basename(dictionary)));
  await build({ entryPoints: [path.join(root, 'test/fixtures/composer-spelling.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' });
  await build({ entryPoints: [path.join(root, 'src/main/spellingMenu.ts')], outfile: path.join(output, 'menu.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  await build({ entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(output, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html lang="en-US"><meta charset="utf-8"><style>body{background:#222;color:#eee}textarea{display:block;width:600px;font:18px monospace;padding:10px;margin:20px}</style><div id="root"></div><script type="module" src="./fixture.js"></script></html>');
  console.log(`Composer spelling smoke: ${output}`);
  assert.equal(process.platform, 'linux', 'This native input fixture uses a private X11 display.');
  // Electron's synthetic typing does not reliably produce Linux spelling markers.
  // Real X11 input is scoped to this private display, never the user's desktop.
  const displayServer = spawn(process.env.ANTIMATTER_XVFB_BINARY || 'Xvfb', ['-displayfd', '3', '-screen', '0', '1280x960x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'inherit', 'pipe'],
  });
  try {
    const display = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Private Xvfb did not start.')), 8000);
      let response = '';
      displayServer.once('error', (error) => { clearTimeout(deadline); reject(error); });
      displayServer.once('exit', () => { clearTimeout(deadline); reject(new Error('Private Xvfb exited.')); });
      displayServer.stdio[3].on('data', (data) => {
        response += data;
        if (/^\d+\n$/.test(response)) { clearTimeout(deadline); resolve(`:${response.trim()}`); }
      });
    });
    const child = spawn(electron, ['--ozone-platform=x11', filename, '--fixture', output], {
      stdio: 'inherit', env: { ...process.env, DISPLAY: display, WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: '' },
    });
    process.exitCode = await new Promise((resolve) => {
      const timeout = setTimeout(() => { console.error('Spelling fixture timed out.'); child.kill(); }, 45_000);
      child.on('error', (error) => { clearTimeout(timeout); console.error(error); resolve(1); });
      child.on('exit', (code) => { clearTimeout(timeout); resolve(code ?? 1); });
    });
  } finally {
    displayServer.kill();
  }
} else {
  const { app, BrowserWindow, ipcMain, Menu, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data'));
  app.setPath('sessionData', path.join(output, 'user-data'));
  app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.defaultSession;
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const dictionaryReady = new Promise((resolve) => isolated.once('spellcheck-dictionary-initialized', resolve));
    isolated.setSpellCheckerLanguages(['en-US']);
    isolated.setSpellCheckerEnabled(true);
    ipcMain.on('appearance:initial', (event) => { event.returnValue = null; });
    const window = new BrowserWindow({ show: true, width: 900, height: 700, webPreferences: {
      preload: path.join(output, 'preload.cjs'), session: isolated, spellcheck: true, nodeIntegration: false, contextIsolation: true, sandbox: false,
    } });
    window.removeMenu();
    const { installSpellingMenu } = await import(path.join(output, 'menu.cjs'));
    let menu;
    const dispose = installSpellingMenu(window, () => window.webContents.getURL().endsWith('/index.html'), {
      buildFromTemplate: (template) => { menu = Menu.buildFromTemplate(template); return menu; },
    });
    const failures = [];
    window.webContents.on('console-message', (event) => { if (event.level === 'error') { failures.push(event.message); } });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 250))');
    const typeText = async (text) => {
      await run('document.querySelector("[aria-label=Message]").focus()');
      execFileSync('xdotool', ['windowfocus', '--sync', window.getNativeWindowHandle().readUInt32LE(0).toString()], { timeout: 3000 });
      execFileSync('xdotool', ['type', '--clearmodifiers', '--delay', '25', text], { timeout: 5000 });
      await tick();
    };
    const pressKey = async (key) => {
      execFileSync('xdotool', ['windowfocus', '--sync', window.getNativeWindowHandle().readUInt32LE(0).toString()], { timeout: 3000 });
      execFileSync('xdotool', ['key', '--clearmodifiers', key], { timeout: 3000 });
      await tick();
    };
    const openMenu = async (selector = '[aria-label="Message"]') => {
      menu = undefined;
      const point = await run(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); const rect = input.getBoundingClientRect(); return {x:Math.round(rect.x+18),y:Math.round(rect.y+20)}; })()`);
      const event = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No native context-menu event')), 3000);
        window.webContents.once('context-menu', (_event, params) => { clearTimeout(timeout); resolve(params); });
      });
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...point });
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...point });
      return event;
    };
    const openSpellingMenu = async () => {
      let params = await openMenu();
      for (let attempt = 0; attempt < 20 && !params.misspelledWord; attempt += 1) {
        menu?.closePopup(window);
        await tick();
        params = await openMenu();
      }
      return params;
    };
    try {
      await window.loadFile(path.join(output, 'index.html'));
      window.show();
      window.focus();
      window.webContents.focus();
      await Promise.race([dictionaryReady, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Cached dictionary did not initialize.')), 8000))]);
      await tick();
      assert.equal(await run('document.querySelector("[aria-label=Message]").spellcheck'), true);
      // A completed word boundary lets Chromium schedule its native spelling markers.
      await typeText('teh code please ');
      console.log('Native input:', await run('({text:spellingSmoke.current().text,focus:document.hasFocus()})'), process.versions.electron);
      const params = await openSpellingMenu();
      console.log('Native spelling context:', JSON.stringify({ word: params.misspelledWord, suggestions: params.dictionarySuggestions, editable: params.isEditable, enabled: params.spellcheckEnabled, type: params.formControlType, selection: params.selectionText, x:params.x,y:params.y,languages: isolated.getSpellCheckerLanguages() }));
      assert.equal(params.misspelledWord, 'teh');
      assert.ok(params.dictionarySuggestions.includes('the'), 'Real cached Hunspell dictionary supplies a correction.');
      assert.ok(menu, 'Trusted composer gets the real native menu.');
      assert.equal(window.webContents.focusedFrame, window.webContents.mainFrame);
      menu.items.find((item) => item.label === 'the').click();
      menu.closePopup(window);
      await tick();
      assert.equal((await run('spellingSmoke.current()')).text, 'the code please ');
      assert.equal((await run('spellingSmoke.flush()')).attachments[0].id, 'note');
      await run('spellingSmoke.rerender()'); await tick();
      assert.equal(await run('document.querySelector("[aria-label=Message]").value'), 'the code please ');
      window.webContents.undo(); await tick();
      assert.equal((await run('spellingSmoke.current()')).text, 'teh code please ');
      window.webContents.redo(); await tick();
      assert.equal((await run('spellingSmoke.current()')).text, 'the code please ');
      await run('spellingSmoke.switchThread("second")'); await tick();
      await run('spellingSmoke.switchThread("first")'); await tick();
      assert.equal((await run('spellingSmoke.current()')).text, 'the code please ');
      assert.deepEqual(await run('spellingSmoke.submitted'), [], 'Corrections do not send a message.');
      await run('document.querySelector("[aria-label=Message]").focus(); document.querySelector("[aria-label=Message]").setSelectionRange(16,16)');
      await pressKey('shift+Return');
      assert.equal((await run('spellingSmoke.current()')).text, 'the code please \n');
      await run('document.querySelector("[aria-label=Message]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true}))');
      assert.deepEqual(await run('spellingSmoke.submitted'), []);
      await pressKey('Return');
      assert.deepEqual(await run('spellingSmoke.submitted'), ['the code please']);
      await run('spellingSmoke.stream(true)'); await tick();
      await typeText('teh code please ');
      assert.equal((await openSpellingMenu()).misspelledWord, 'teh');
      menu.items.find((item) => item.label === 'the').click(); menu.closePopup(window); await tick();
      await pressKey('Return');
      assert.deepEqual(await run('spellingSmoke.steered'), ['the code please']);
      await openMenu('#code');
      assert.equal(menu, undefined, 'Code controls retain spellcheck=false and no spelling menu.');
      assert.deepEqual(failures, []);
      console.log('Composer spelling smoke passed: real native dictionary suggestions, replacement, React draft/attachments, undo/redo, thread switch, no auto-send, Shift+Enter/IME, Enter submission, streaming steer, code exclusion. No network or real application/profile changes.');
      dispose(); window.destroy(); app.exit(0);
    } catch (error) {
      console.error(error, failures);
      await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG());
      dispose(); window.destroy(); app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
