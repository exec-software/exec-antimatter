#!/usr/bin/env node
/** Real DOM behavior with mocked IPC; no user profile, inference, subprocess tools, or network. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('ANTIMATTER_SMOKE_OUTPUT=/external/build/tests node scripts/smoke-desktop-preferences.mjs\nTests real Electron controls with isolated storage and mocked IPC; no live user profile or inference.');
  process.exit(0);
}

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '..');
if (!process.versions.electron) {
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  const base = process.env.ANTIMATTER_SMOKE_OUTPUT;
  if (!base) throw new Error('Set ANTIMATTER_SMOKE_OUTPUT to an external build directory.');
  await fs.mkdir(base, { recursive: true });
  const output = await fs.mkdtemp(path.join(base, 'desktop-'));
  await build({ absWorkingDir: root, entryPoints: ['test/fixtures/desktop-preferences-panel.tsx'], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'unsafe-inline\'"><style>body{background:#141414;color:#eee;font-family:sans-serif}button,input,textarea,select{margin:4px}textarea{display:block;width:80%;min-height:80px}fieldset,section{margin:12px}header{display:flex}svg{max-height:18px;max-width:18px}</style></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { console.error('Desktop smoke timed out.'); child.kill(); process.exitCode = 1; }, 45000);
  child.on('error', (error) => { console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data'));
  app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
  const isolated = session.fromPartition(`desktop-preferences-${process.pid}`);
  isolated.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith('file:') }));
  const window = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const run = (source) => window.webContents.executeJavaScript(source);
  const tick = () => run('new Promise(resolve => setTimeout(resolve, 40))');
  const click = async (label, modifier = '') => { await run(`(() => { const b=[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)}); if(!b||b.disabled) throw Error('Missing button: '+${JSON.stringify(label)}); b.dispatchEvent(new MouseEvent('click',{bubbles:true,${modifier ? `${modifier}:true,` : ''}})); })()`); await tick(); };
  const type = async (text) => { await run(`(() => {const t=document.querySelector('textarea[aria-label="Message"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(text)});t.dispatchEvent(new Event('input',{bubbles:true}));})()`); await tick(); };
  const key = async (selector, key, options = {}) => { await run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:${JSON.stringify(key)},...${JSON.stringify(options)}}))`); await tick(); };
  try {
    await window.loadFile(path.join(output, 'index.html')); await tick();
    await type('guarded draft'); await click('Send message');
    assert.deepEqual(await run('desktopSmoke.metrics.sends'), []);
    assert.equal(await run('document.querySelector("textarea").value'), 'guarded draft');
    await run('document.querySelector("form").requestSubmit()'); await tick();
    assert.deepEqual(await run('desktopSmoke.metrics.sends'), [], 'native form cannot bypass click guard');
    await click('Send message', 'ctrlKey'); assert.deepEqual(await run('desktopSmoke.metrics.sends'), ['guarded draft']);
    await key('input[aria-label="Send message shortcut"]', 'Enter', { ctrlKey: true });
    await type('shortcut draft'); await key('textarea', 'Enter');
    assert.equal(await run('desktopSmoke.metrics.sends.length'), 1);
    await key('textarea', 'Enter', { ctrlKey: true, isComposing: true });
    await key('textarea', 'Enter', { ctrlKey: true, repeat: true });
    assert.equal(await run('desktopSmoke.metrics.sends.length'), 1);
    await key('textarea', 'Enter', { ctrlKey: true }); assert.equal(await run('desktopSmoke.metrics.sends.length'), 2);
    await click('Toggle running'); await type('steer draft'); await click('Queue steer');
    assert.deepEqual(await run('desktopSmoke.metrics.steers'), []);
    await click('Queue steer', 'ctrlKey'); assert.deepEqual(await run('desktopSmoke.metrics.steers'), ['steer draft']);
    await click('Stop generating'); assert.equal(await run('desktopSmoke.metrics.stops'), 1);
    await key('input[aria-label="New chat shortcut"]', 'j', { ctrlKey: true, shiftKey: true });
    await key('textarea', 'n', { ctrlKey: true }); assert.equal(await run('desktopSmoke.metrics.newChats'), 0);
    await key('textarea', 'j', { ctrlKey: true, shiftKey: true }); assert.equal(await run('desktopSmoke.metrics.newChats'), 1);
    await click('Hide all'); assert.equal(await run('document.querySelectorAll("#tool-stripe nav").length'), 0);
    await click('Show all'); assert.equal(await run('document.querySelectorAll("#tool-stripe nav button").length'), 2);
    await click('Maximize window'); await click('Restore window'); await click('Enter full screen'); await click('Leave full screen'); await click('Always on top'); await click('Minimize window'); await click('Close window');
    assert.deepEqual(await run('desktopSmoke.metrics.actions'), ['toggle-maximize', 'toggle-maximize', 'toggle-fullscreen', 'toggle-fullscreen', 'toggle-always-on-top', 'minimize', 'close']);
    await click('Gruvbox'); assert.equal(await run('desktopSmoke.appearance().themePreset'), 'gruvbox');
    assert.equal(await run('document.documentElement.style.getPropertyValue("--ds-bg-page")'), '#282828');
    await click('Toggle running');
    await run('desktopSmoke.update({macroPadEnabled:true})'); await tick();
    await click('Add saved reply');
    await run(`(()=>{for(const [label,value] of [['Reply title','Continue'],['Saved reply text','Continue with the current plan.']]){const e=document.querySelector('[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}))}})()`); await tick();
    await click('Save reply'); assert.equal(await run('desktopSmoke.preferences().replyMacros.length'),1);
    await click('Send'); assert.equal(await run('desktopSmoke.metrics.sends.length'),2,'macro respects Ctrl+click');
    await click('Send','ctrlKey'); assert.equal(await run('desktopSmoke.metrics.sends.length'),3);
    await click('Insert'); assert.equal(await run(`document.querySelector('textarea[aria-label="Message"]').value`),'Continue with the current plan.');
    await click('Send','ctrlKey'); assert.equal(await run('desktopSmoke.metrics.sends.length'),3,'existing draft is preserved');
    await click('Delete Continue'); assert.equal(await run('desktopSmoke.preferences().replyMacros.length'),0);
    assert.deepEqual(errors, []);
    console.log('Desktop preferences smoke passed: send guard, IME/repeat, remapping, steering, stop, rail visibility, window controls, themes.');
  } catch (error) { console.error(error); console.error(errors); process.exitCode = 1; }
  finally { window.destroy(); app.exit(process.exitCode ?? 0); }
  }).catch((error) => { console.error(error); app.exit(1); });
}
