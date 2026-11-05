#!/usr/bin/env node
/** Run with Node and a built renderer assets directory. Never loads the application main/preload. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const filename = fileURLToPath(import.meta.url);
if (!process.versions.electron) {
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  const assets = path.resolve(process.argv[2] || 'dist-electron/renderer/assets');
  const css = (await fs.readdir(assets)).find((name) => /^main-.*\.css$/.test(name));
  assert.ok(css, 'Pass an existing production renderer assets directory with main CSS.');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-voice-smoke-'));
  await build({ entryPoints: [path.resolve(path.dirname(filename), '../test/fixtures/voice-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.js': 'jsx' } });
  await fs.copyFile(path.join(assets, css), path.join(output, 'fixture.css'));
  // Production CSS can reference its bundled font. Copy only fonts, never application scripts.
  for (const name of await fs.readdir(assets)) if (/\.(woff2?|ttf)$/.test(name)) await fs.copyFile(path.join(assets, name), path.join(output, name));
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\'; img-src \'self\' data:; connect-src \'none\'; media-src \'none\'"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
  console.log(`Voice smoke output: ${output}`);
  const child = spawn(electron, [filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { console.error('Voice smoke exceeded 30 seconds; stopping only the isolated fixture.'); child.kill(); process.exitCode = 1; }, 30_000);
  child.on('error', (error) => { console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data'));
  app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
  const isolated = session.fromPartition(`voice-smoke-${process.pid}`);
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
  const window = new BrowserWindow({ show: false, width: 1024, height: 1050, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
  const failures = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) failures.push(message); });
  const run = (code) => window.webContents.executeJavaScript(code);
  const tick = () => run('new Promise(resolve => setTimeout(resolve, 60))');
  const click = async (label) => { await run(`(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw Error('Unavailable button: ' + ${JSON.stringify(label)}); button.click(); })()`); await tick(); };
  try {
    await window.loadFile(path.join(output, 'index.html')); await tick();
    assert.equal(await run('voiceSmoke.metrics.captures'), 0);
    await click('Start microphone');
    assert.equal(await run('voiceSmoke.metrics.captures'), 1);
    assert.equal(await run('voiceSmoke.state().active'), true);
    await click('Mute mic'); assert.equal(await run('voiceSmoke.metrics.muted'), true);
    await click('Unmute');
    await run('voiceSmoke.narrate()'); await tick();
    assert.equal(await run('voiceSmoke.metrics.muted'), false, 'Auto keeps echo-cancelled capture available for spoken interruption');
    assert.equal(await run('voiceSmoke.state().speaking'), true);
    await click('Interrupt & listen'); assert.equal(await run('voiceSmoke.metrics.muted'), false);
    await fs.writeFile(path.join(output, 'voice-listening.png'), (await window.webContents.capturePage()).toPNG());
    await run('voiceSmoke.utterance()'); await tick();
    assert.match(await run('document.body.innerText'), /Unsent transcript/);
    await fs.writeFile(path.join(output, 'voice-recovery.png'), (await window.webContents.capturePage()).toPNG());
    await run('voiceSmoke.metrics.accepted = true'); await click('Retry sending');
    assert.equal(await run('voiceSmoke.state().recoveredTranscript'), null);
    assert.equal(await run('voiceSmoke.metrics.ids[0] === voiceSmoke.metrics.ids[1]'), true);
    await click('Stop'); assert.ok(await run('voiceSmoke.metrics.stops > 0'));
    await run(`(() => { const source = document.querySelector('[aria-label="Audio input source"]'); source.value = 'remote'; source.dispatchEvent(new Event('change', { bubbles: true })); })()`); await tick();
    await run(`(() => { const input = document.querySelector('[aria-label="Audio input model"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'remote-audio'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`); await tick();
    assert.equal(await run(`[...document.querySelectorAll('button')].find(item => item.textContent === 'Save settings').disabled`), true);
    await fs.writeFile(path.join(output, 'voice-remote-consent.png'), (await window.webContents.capturePage()).toPNG());
    await run(`document.querySelectorAll('input[type="checkbox"]')[1].click()`); await tick();
    await click('Save settings'); assert.equal(await run('voiceSmoke.metrics.saved'), 1);
    await click('Check saved input');
    assert.match(await run('document.body.innerText'), /no endpoint was contacted/);
    assert.deepEqual(failures, []);
    console.log('Voice renderer smoke passed: start, hardware mute seam, safe playback interrupt, transcript recovery/stable retry, stop, remote consent, save, capability probe. No device/network access.');
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error); window.destroy(); app.exit(1); }
  }).catch((error) => { console.error(error); app.exit(1); });
}
