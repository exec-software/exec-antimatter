#!/usr/bin/env node
/** Real Electron UI with mocked providers, no external account access or messages. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '..');
if (process.argv.includes('--help')) {
  console.log('ANTIMATTER_SMOKE_OUTPUT=/external/build/tests node scripts/smoke-connections.mjs\nTests Comms/Email UI races, draft recovery, reviewed sends and plugin/project controls with mocked IPC and no network.');
  process.exit(0);
}
if (!process.versions.electron) {
  if (!process.env.ANTIMATTER_SMOKE_OUTPUT) { throw new Error('Set ANTIMATTER_SMOKE_OUTPUT to an external build directory.'); }
  const { build } = await import('esbuild'); const { default: electron } = await import('electron');
  await fs.mkdir(process.env.ANTIMATTER_SMOKE_OUTPUT, { recursive: true });
  const output = await fs.mkdtemp(path.join(process.env.ANTIMATTER_SMOKE_OUTPUT, 'connections-'));
  await build({ entryPoints: [path.join(root, 'test/fixtures/connections-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
  const { default: postcss } = await import('postcss'); const { default: tailwindcss } = await import('tailwindcss'); const { default: config } = await import('../tailwind.config.js');
  const css = await postcss([tailwindcss(config)]).process(await fs.readFile(path.join(root, 'renderer/src/index.css'), 'utf8'), { from: path.join(root, 'renderer/src/index.css') });
  await fs.writeFile(path.join(output, 'fixture.css'), css.css); await fs.cp(path.join(root, 'renderer/src/assets/fonts'), path.join(output, 'assets/fonts'), { recursive: true });
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\'; img-src \'self\' data:; connect-src \'none\'"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1440,1000', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const timer = setTimeout(() => { console.error('Connections smoke timed out.'); child.kill(); process.exitCode = 1; }, 60000);
  child.on('error', (error) => { console.error(error); process.exitCode = 1; }); child.on('exit', (code) => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data')); app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`connections-smoke-${process.pid}`); isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, width: 1200, height: 900, enableLargerThanScreen: true, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const errors = []; window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) { errors.push(message); } });
    const run = async (code) => { try { return await window.webContents.executeJavaScript(code); } catch (error) { console.error('Fixture script:', code.slice(0, 240)); throw error; } };
    const tick = () => run('new Promise(resolve=>setTimeout(resolve,45))');
    const click = async (label) => { await run(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}||e.getAttribute('aria-label')===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Missing enabled '+${JSON.stringify(label)});b.click()})()`); await tick(); };
    const field = async (label, value) => { await run(`(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']')||[...document.querySelectorAll('label')].find(e=>e.textContent.trim()===${JSON.stringify(label)})?.querySelector('input,select,textarea');if(!e)throw Error('Missing field '+${JSON.stringify(label)});const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`); await tick(); };
    const check = (label) => run(`[...document.querySelectorAll('label')].find(e=>e.textContent.trim()===${JSON.stringify(label)})?.querySelector('input').checked`);
    const toggle = async (label) => { await run(`(()=>{const e=document.querySelector('input[aria-label='+${JSON.stringify(JSON.stringify(label))}+']')||[...document.querySelectorAll('label')].find(e=>e.textContent.trim()===${JSON.stringify(label)})?.querySelector('input');if(!e||e.disabled)throw Error('Missing enabled checkbox');e.click()})()`); await tick(); };
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      await click('Accounts');
      assert.equal(await run(`[...document.querySelectorAll('label')].find(e=>e.textContent.trim()==='Redirect URL').querySelector('input').value`), 'http://127.0.0.1:47833/callback');
      assert.equal(await run(`[...document.querySelectorAll('label')].find(e=>e.textContent.trim()==='Microsoft tenant').querySelector('input').value`), 'saved-tenant');
      await field('Client ID', ''); await click('Save registration');
      assert.equal(await run('connectionsSmoke.metrics.registrations[0].clientId'), '', 'cleared fields must not silently restore saved values');
      await field('Account name', 'Test account'); await run(`connectionsSmoke.defer('authorize')`); await click('Sign in with Outlook'); await click('Accounts');
      await run(`connectionsSmoke.resolve('authorize',{id:'auth-attempt',manual:false})`); await tick();
      assert.deepEqual(await run('connectionsSmoke.metrics.cancels'), ['auth-attempt']);
      await field('Connected account', 'mail-b'); await run(`connectionsSmoke.defer('folders:mail-a')`); await field('Connected account', 'mail-a'); await field('Connected account', 'mail-b');
      await run(`connectionsSmoke.resolve('folders:mail-a',{items:[{id:'stale',name:'STALE ACCOUNT FOLDER'}]})`); await tick();
      assert.equal(await run(`document.body.textContent.includes('STALE ACCOUNT FOLDER')`), false);
      await run(`connectionsSmoke.defer('message:mail-b:inbox')`); await click('mail-b inbox messagePeer <peer@example.com>2026-11-13');
      await click('mail-b Archive'); await run(`connectionsSmoke.resolve('message:mail-b:inbox',{id:'old',from:'old',subject:'STALE DETAIL',text:'stale',date:''})`); await tick();
      assert.equal(await run(`document.body.textContent.includes('STALE DETAIL')`), false);
      await run(`connectionsSmoke.defer('messages:mail-b:inbox')`); await click('mail-b Inbox'); await click('mail-b Archive');
      await run(`connectionsSmoke.resolve('messages:mail-b:inbox',{items:[{id:'old',from:'old',subject:'STALE MESSAGE',text:'stale',date:''}]})`); await tick();
      assert.equal(await run(`document.body.textContent.includes('STALE MESSAGE')`), false);
      await run(`connectionsSmoke.project('project-two')`); await tick(); await run(`connectionsSmoke.defer('grant:project-one');connectionsSmoke.project('project-one')`); await tick();
      assert.equal(await run(`[...document.querySelectorAll('label')].find(e=>e.textContent==='Read').querySelector('input').disabled`), true, 'grants cannot overwrite unread saved permissions');
      await run(`connectionsSmoke.project('project-two')`); await tick();
      await run(`connectionsSmoke.resolve('grant:project-one',{read:false,send:true})`); await tick();
      assert.equal(await check('Read'), true); assert.equal(await check('Send with approval'), false);
      await toggle('Send with approval'); assert.equal(await run('connectionsSmoke.metrics.grants.at(-1).thread'), 'project-two');
      await click('Compose'); await field('Message destination', 'review@example.com'); await field('Message subject', 'Reviewed subject'); await field('Message text', 'Exact reviewed body');
      await click('Review send'); assert.equal(await run('connectionsSmoke.metrics.sends.length'), 0);
      await run(`connectionsSmoke.defer('send');(()=>{const b=[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent==='Send message');b.click();b.click()})()`); await tick();
      assert.equal(await run('connectionsSmoke.metrics.sends.length'), 1); assert.equal(await run(`JSON.parse(localStorage.getItem('antimatter.connections.drafts.v1'))[0].submitted`), true);
      const requestId = await run('connectionsSmoke.metrics.sends[0].requestId');
      await run('connectionsSmoke.remount()'); await tick(); await field('Connected account', 'mail-b');
      assert.equal(await run(`document.querySelector('[aria-label="Message text"]').readOnly`), true);
      await click('Check delivery'); assert.equal(await run('connectionsSmoke.metrics.sends.length'), 1, 'checking delivery must never call send');
      await run(`connectionsSmoke.resolve('send',{requestId:${JSON.stringify(requestId)},state:'sent'});connectionsSmoke.receipt(${JSON.stringify(requestId)},'sent')`); await tick();
      await click('Check delivery'); assert.equal(await run(`!!document.querySelector('[aria-label="Message draft"]')`), false);
      await click('Compose'); await field('Message destination', 'review@example.com'); await field('Message text', 'Retry only if never submitted'); await click('Review send'); await run(`connectionsSmoke.defer('send')`); await click('Send message');
      const retryId = await run('connectionsSmoke.metrics.sends.at(-1).requestId'); await run(`connectionsSmoke.reject('send')`); await tick();
      assert.equal(await run(`document.querySelector('[aria-label="Message text"]').readOnly`), true);
      await run(`connectionsSmoke.receipt(${JSON.stringify(retryId)},null)`); await click('Check delivery');
      assert.equal(await run(`document.querySelector('[aria-label="Message text"]').readOnly`), false);
      assert.equal(await run('connectionsSmoke.metrics.sends.length'), 2);
      await fs.writeFile(path.join(output, 'email-desktop.png'), (await window.webContents.capturePage()).toPNG());
      window.setSize(390, 844); await tick();
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, 'narrow layout does not overflow');
      await fs.writeFile(path.join(output, 'email-narrow.png'), (await window.webContents.capturePage()).toPNG());
      window.setSize(1200, 900); await run(`connectionsSmoke.navigate('plugins')`); await tick(); await toggle('Enable built-in email');
      await run(`connectionsSmoke.navigate('email')`); await tick(); assert.equal(await run(`!!document.querySelector('[aria-label="Mail folders"]')`), false);
      await toggle('Enable Email plugin'); await run(`connectionsSmoke.project('')`); await tick(); assert.equal(await run(`[...document.querySelectorAll('label')].find(e=>e.textContent==='Read').querySelector('input').disabled`), true);
      await run(`connectionsSmoke.navigate('comms')`); await tick(); await click('slack-a inbox messagePeer <peer@example.com>2026-11-13');
      assert.equal(await run(`document.querySelector('article script')`), null); assert.match(await run(`document.querySelector('article').textContent`), /untrusted message stays text/);
      await fs.writeFile(path.join(output, 'comms-desktop.png'), (await window.webContents.capturePage()).toPNG());
      await run(`localStorage.setItem('antimatter.connections.drafts.v1','{corrupt drafts')`); await window.reload(); await new Promise((resolve) => window.webContents.once('did-finish-load', resolve)); await tick();
      await click('Compose'); assert.equal(await run(`localStorage.getItem('antimatter.connections.drafts.v1')`), '{corrupt drafts');
      assert.equal(await run(`connectionsSmoke.blockers().length`), 1);
      await run('window.confirm=()=>true;void 0'); await click('Reset draft storage'); assert.equal(await run('connectionsSmoke.blockers().length'), 0);
      assert.deepEqual(errors, []);
      console.log(`Connections UI passed: registration, cancellation, stale account/folder/detail/grants, exact-once reviewed send, receipt-only recovery, corrupt drafts, plugins and responsive layout. ${output}`);
      app.exit(0);
    } catch (error) {
      console.error(error); await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG()); app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
