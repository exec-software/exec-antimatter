#!/usr/bin/env node
/** Actual bundled WASM engine + save/reload using an isolated profile and no network. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('ANTIMATTER_DOOM_RUNTIME=/external/build/doom ANTIMATTER_SMOKE_OUTPUT=/external/build/tests node scripts/smoke-doom.mjs\nRuns the actual pinned engine, checks iframe isolation and durable save/reload in a fresh profile. No network or existing user storage.');
  process.exit(0);
}
const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '..');
if (!process.versions.electron) {
  if (!process.env.ANTIMATTER_SMOKE_OUTPUT || !process.env.ANTIMATTER_DOOM_RUNTIME) throw new Error('Set ANTIMATTER_SMOKE_OUTPUT and ANTIMATTER_DOOM_RUNTIME to external build directories.');
  const { build } = await import('esbuild'); const { default: electron } = await import('electron');
  await fs.mkdir(process.env.ANTIMATTER_SMOKE_OUTPUT, { recursive: true });
  const output = await fs.mkdtemp(path.join(process.env.ANTIMATTER_SMOKE_OUTPUT, 'doom-'));
  await build({ absWorkingDir: root, entryPoints: ['test/fixtures/doom-panel.tsx'], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
  await build({ absWorkingDir: root, entryPoints: ['src/main/doom.ts'], outfile: path.join(output, 'store.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><style>body{margin:0;background:#141414;color:#eee;font-family:sans-serif}iframe{width:800px;height:540px;display:block}button{margin:4px}svg{width:16px;height:16px}</style></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
  await fs.writeFile(path.join(output, 'preload.cjs'), `const { contextBridge, ipcRenderer }=require('electron');contextBridge.exposeInMainWorld('doomFixture',{runtime:()=>ipcRenderer.invoke('runtime'),chooseWad:async()=>null,openSession:id=>ipcRenderer.invoke('open',id),save:(token,files)=>ipcRenderer.invoke('save',token,files)});`);
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1440,1000', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const timeout = setTimeout(() => { console.error('Doom smoke timed out.'); child.kill(); process.exitCode = 1; }, 55000);
  child.on('exit', (code) => { clearTimeout(timeout); process.exitCode = code ?? 1; });
  child.on('error', (error) => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, session, ipcMain } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  const { DoomSaveStore, readDoomRuntime } = await import(pathToFileURL(path.join(output, 'store.cjs')).href);
  app.setPath('userData', path.join(output, 'profile')); app.commandLine.appendSwitch('disable-gpu');
  const store = new DoomSaveStore(path.join(output, 'saves'));
  let saved = 0;
  ipcMain.handle('runtime', () => readDoomRuntime(process.env.ANTIMATTER_DOOM_RUNTIME));
  ipcMain.handle('open', (_event, id) => store.open(id));
  ipcMain.handle('save', (_event, token, files) => { store.save(token, files); saved++; });
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`doom-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    isolated.webRequest.onBeforeRequest((detail, cb) => cb({ cancel: !/^(file:|blob:|about:|data:)/.test(detail.url) }));
    const window = new BrowserWindow({ show: false, width: 1000, height: 850, enableLargerThanScreen: true, webPreferences: { preload: path.join(output, 'preload.cjs'), session: isolated, contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true } });
    const errors = []; window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = (ms = 80) => run(`new Promise(resolve=>setTimeout(resolve,${ms}))`);
    const click = async (text) => { await run(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Missing button '+${JSON.stringify(text)});b.click()})()`); await tick(); };
    const waitFor = async (check, label) => { for (let i = 0; i < 150; i++) { if (await check()) return; await tick(); } throw new Error(`Timed out: ${label}`); };
    const frame = () => window.webContents.mainFrame.frames.find((entry) => entry.url === 'about:srcdoc');
    const key = async (key, code) => { await frame().executeJavaScript(`(()=>{const c=document.getElementById('canvas');for(const type of ['keydown',...(${JSON.stringify(key)}.length===1?['keypress']:[]),'keyup'])c.dispatchEvent(new KeyboardEvent(type,{bubbles:true,cancelable:true,key:${JSON.stringify(key)},code:${JSON.stringify(key.length === 1 ? 'Key' + key.toUpperCase() : key)},keyCode:${code},which:${code},charCode:${code}}))})()`); await tick(180); };
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick(); await click('Play');
      await waitFor(() => run(`[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Save'&&!e.disabled)`), 'engine running');
      assert.equal(await frame().executeJavaScript(`typeof window.electronAPI`), 'undefined');
      assert.equal(await frame().executeJavaScript(`(()=>{try{return parent.document.title}catch{return 'blocked'}})()`), 'blocked');
      await tick(1500); console.log('Canvas geometry', await frame().executeJavaScript(`(()=>{const c=document.getElementById('canvas');return {width:c.width,height:c.height,css:[c.clientWidth,c.clientHeight],dpr:devicePixelRatio}})()`)); await fs.writeFile(path.join(output, 'doom-title.png'), (await window.webContents.capturePage()).toPNG());
      await key('Escape', 27); await key('Enter', 13); await key('Enter', 13);
      await tick(1200); await fs.writeFile(path.join(output, 'doom-level.png'), (await window.webContents.capturePage()).toPNG()); await click('Save'); await key('Enter', 13);
      for (const ch of 'SMOKE') await key(ch, ch.charCodeAt(0));
      await key('Enter', 13);
      await waitFor(() => saved > 0, 'durable save');
      assert.deepEqual(await run('doomSmoke.flush()'), [], 'update/close flush waits for game snapshot and disk persistence');
      const files = store.open('freedoom2-0.13.0').saves;
      assert.ok(files.length > 0); assert.ok(files[0].bytes.length > 1000);
      await fs.writeFile(path.join(output, 'doom-saved.png'), (await window.webContents.capturePage()).toPNG());
      await click('Exit game'); await click('Play');
      await waitFor(() => run(`[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Load'&&!e.disabled)`), 'engine restart');
      await click('Load'); await key('Enter', 13); await tick(1000);
      await fs.writeFile(path.join(output, 'doom-reloaded.png'), (await window.webContents.capturePage()).toPNG());
      assert.deepEqual(errors.filter((error) => !/AudioContext|WebGL|GPU/i.test(error)), []);
      console.log(`Doom smoke passed: real Freedoom level, save to private disk, restart/load, iframe isolation. Evidence: ${output}`);
    } catch (error) { console.error(error); console.error(errors); console.error(await run('document.body.innerText')); await fs.writeFile(path.join(output, 'doom-failed.png'), (await window.webContents.capturePage()).toPNG()); console.error('Evidence:', output); console.error('Frame:', await frame()?.executeJavaScript('document.body.innerText')); console.error('Engine log:', await frame()?.executeJavaScript('document.documentElement.dataset.engineLog'));  process.exitCode = 1; }
    finally { window.destroy(); app.exit(process.exitCode ?? 0); }
  }).catch((error) => { console.error(error); app.exit(1); });
}
