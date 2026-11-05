#!/usr/bin/env node
/** Actual avatar HTML/CSS/renderer with mocked IPC. Never starts the application or microphone. */
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
  const root = path.resolve(path.dirname(filename), '..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-avatar-smoke-'));
  await build({ entryPoints: [path.join(root, 'test/fixtures/avatar-renderer.ts')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' });
  const html = (await fs.readFile(path.join(root, 'renderer/src/avatar.html'), 'utf8'))
    .replace('</head>', '<link rel="stylesheet" href="./fixture.css"></head>')
    .replace('src="./avatar.ts"', 'src="./fixture.js"');
  await fs.writeFile(path.join(output, 'index.html'), html);
  console.log(`Avatar smoke output: ${output}`);
  const child = spawn(electron, ['--ozone-platform=headless', '--ozone-override-screen-size=1280,960', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { console.error('Avatar fixture timed out; stopping only the isolated fixture.'); child.kill(); process.exitCode = 1; }, 30_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data'));
  app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`avatar-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, frame: false, transparent: true, width: 180, height: 208, enableLargerThanScreen: true, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const failures = [];
    window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 50))');
    const click = async (selector) => { await run(`(() => { const button = document.querySelector(${JSON.stringify(selector)}); if (!button || button.disabled || !button.checkVisibility()) throw Error('Unavailable control'); button.focus(); button.click(); })()`); await tick(); };
    const state = (overrides = {}) => ({ kind: 'atom', running: 1, approvals: 0, voice: { active: true, phase: 'listening', muted: false, speaking: false }, ...overrides });
    const emit = async (next) => { await run(`avatarSmoke.emit(${JSON.stringify(next)})`); await tick(); };
    const finish = async () => { await run('avatarSmoke.resolve()'); await tick(); };
    const focused = () => run('document.activeElement.dataset.command ?? document.activeElement.id');
    const appearance = async (theme, secondaryAccent) => {
      await run(`avatarSmoke.emitAppearance(${JSON.stringify({ theme, secondaryAccent })})`);
      await tick();
    };
    const colors = () => run(`(() => {
      const read = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
      return { scheme: read('html', 'colorScheme'), outer: read('html', 'backgroundColor'), body: read('body', 'backgroundColor'),
        surface: read('#avatar-actions', 'backgroundColor'), ink: read('#status', 'color'),
        face: document.querySelector('.face-surface') ? read('.face-surface', 'fill') : null,
        voice: read('#voice-status', 'color'), accent: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() };
    })()`);
    const screenshot = async (name) => fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
    const layout = async () => {
      assert.equal(await run('getComputedStyle(document.querySelector("main")).webkitAppRegion'), 'drag');
      assert.equal(await run('getComputedStyle(document.querySelector("main")).userSelect'), 'none');
      assert.equal(await run('getComputedStyle(document.querySelector("#avatar-actions")).webkitAppRegion'), 'no-drag');
      assert.equal(await run('document.querySelector("#face").closest("button")'), null, 'grabbing the companion must not open the app');
      assert.equal(await run('document.querySelector("#open").parentElement.id'), 'avatar-actions');
      const buttons = await run(`[...document.querySelectorAll('#avatar-actions button')].filter(b => b.checkVisibility()).map(b => { const r = b.getBoundingClientRect(); const icon = b.querySelector('svg'); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height, text:b.textContent.trim(), label:b.getAttribute('aria-label'), title:b.title, iconWidth:icon.getBoundingClientRect().width, animation:getComputedStyle(icon).animationName, hidden:icon.getAttribute('aria-hidden'), drag:getComputedStyle(b).webkitAppRegion }; })`);
      for (const button of buttons) {
        assert.ok(button.x >= 0 && button.right <= 180 && button.y >= 0 && button.bottom <= 208);
        assert.equal(button.y, buttons[0].y, 'all icons share one row');
        assert.ok(button.width >= 28 && button.height >= 28);
        assert.equal(button.text, ''); assert.ok(button.title && button.label);
        assert.equal(button.iconWidth, 16); assert.equal(button.animation, 'none');
        assert.equal(button.hidden, 'true'); assert.equal(button.drag, 'no-drag');
      }
    };
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      assert.deepEqual(await run('avatarSmoke.actions'), []);
      await layout(); await screenshot('avatar-idle.png');
      await click('[data-command=open]'); await finish();
      assert.deepEqual(await run('avatarSmoke.actions'), ['open'], 'idle opens setup, never starts capture');
      await emit(state()); await layout();
      assert.equal(await run('document.querySelectorAll("#avatar-actions button").length'), 5);
      assert.equal(await run('document.querySelector("[data-command=interrupt]").disabled'), true);
      await run('document.querySelector("[data-command=toggleMute]").focus(); window.originalFocus = document.activeElement; avatarSmoke.emit()');
      assert.equal(await run('document.activeElement === originalFocus'), true, 'polling retains the focused node');
      await screenshot('avatar-listening.png');
      await click('[data-command=toggleMute]');
      assert.equal(await run('[...document.querySelectorAll("#voice-controls button")].every(b => b.disabled)'), true);
      await finish(); assert.equal(await focused(), 'toggleMute');
      assert.equal(await run('document.querySelector("[data-command=toggleMute]").getAttribute("aria-pressed")'), 'true');
      assert.equal(await run('document.querySelector("[data-command=toggleMute]").title'), 'Unmute microphone');
      await screenshot('avatar-muted.png');
      await emit(state({ voice: { active: true, phase: 'speaking', muted: false, speaking: true } }));
      await click('[data-command=interrupt]'); await finish();
      assert.equal(await focused(), 'toggleMute', 'interrupt disabling itself retains keyboard navigation');
      assert.equal(await run('document.querySelector("#status").textContent'), '1 running');
      await click('[data-command=stop]'); await finish(); assert.equal(await focused(), 'open');
      assert.equal(await run('document.querySelector("#status").textContent'), '1 running');
      await click('[data-command=open]'); await run('document.querySelector("#menu").focus()'); await finish();
      assert.equal(await focused(), 'menu', 'completion does not steal focus from menu');
      await click('[data-command=open]'); await run('avatarSmoke.reject()'); await tick();
      assert.equal(await run('document.querySelector("#voice-status").textContent'), 'Open app for voice');
      await click('#menu'); await click('#open');
      assert.deepEqual(await run('avatarSmoke.actions'), ['open', 'toggleMute', 'interrupt', 'stop', 'open', 'open', 'menu', 'openApp']);
      await run('document.querySelector("#portrait").click()');
      assert.equal(await run('avatarSmoke.actions.length'), 8, 'the old face-click action is gone');
      await run('document.querySelector("#portrait").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }))');
      assert.equal(await run('avatarSmoke.actions.length'), 8, 'no custom context menu on native drag regions');
      await run('document.querySelector("#avatar-actions").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }))');
      assert.equal(await run('avatarSmoke.actions.at(-1)'), 'menu');
      for (const kind of ['atom', 'robot', 'cat']) {
        await emit(state({ kind, approvals: 1 })); await layout();
        await screenshot(`avatar-${kind}-approval.png`);
      }
      await click('[data-command=toggleMute]'); await finish(); // Clear the earlier simulated IPC error.
      await emit(state({ kind: 'robot' }));
      const darkColors = await colors();
      assert.equal(darkColors.scheme, 'dark');
      assert.equal(darkColors.outer, 'rgba(0, 0, 0, 0)');
      assert.equal(darkColors.body, 'rgba(0, 0, 0, 0)');
      assert.equal(await run('avatarSmoke.appearanceListeners()'), 1);
      await run('document.querySelector("#menu").focus(); window.appearanceFocus = document.activeElement');
      await appearance('light', '#7352b6');
      const lightColors = await colors();
      assert.equal(lightColors.scheme, 'light');
      assert.equal(lightColors.outer, darkColors.outer, 'appearance must preserve transparent native-window exterior');
      assert.equal(lightColors.body, darkColors.body);
      assert.notEqual(lightColors.surface, darkColors.surface, 'controls adopt light surfaces');
      assert.notEqual(lightColors.ink, darkColors.ink, 'labels adopt light-theme text');
      assert.notEqual(lightColors.face, darkColors.face, 'robot face fill adopts light surface');
      assert.equal(lightColors.accent, await run('avatarSmoke.expectedAccent()'), 'custom accent uses the shared contrast-adjusted tone');
      assert.equal(await run('document.activeElement === appearanceFocus'), true, 'appearance changes preserve focus');
      await layout(); await screenshot('avatar-light-robot.png');
      await emit(state({ kind: 'cat' }));
      assert.equal((await colors()).face, lightColors.face, 'cat shares the themed face surface');
      await screenshot('avatar-light-cat.png');
      await appearance('dark', '#d88a49');
      const customDark = await colors();
      assert.equal(customDark.scheme, 'dark');
      assert.equal(customDark.surface, darkColors.surface);
      assert.equal(customDark.accent, await run('avatarSmoke.expectedAccent()'));
      assert.notEqual(customDark.voice, darkColors.voice, 'active voice follows the new secondary accent');
      await screenshot('avatar-dark-custom-accent.png');
      await emit({ kind: 'atom', running: 0, approvals: 0 }); await layout();
      assert.equal(await run('document.querySelector("#voice-controls").checkVisibility()'), false);
      await run('window.dispatchEvent(new Event("unload"))');
      assert.equal(await run('avatarSmoke.appearanceListeners()'), 0, 'unload releases the read-only appearance subscription');
      await window.loadFile(path.join(output, 'index.html'), { query: { appearance: 'missing' } }); await tick();
      await layout();
      assert.equal((await colors()).scheme, 'dark', 'older mocked bridges safely retain the default theme');
      assert.equal(await run('avatarSmoke.appearanceListeners()'), 0);
      assert.deepEqual(failures, []);
      console.log('Avatar renderer smoke passed: native drag region and no-drag toolbar, dedicated app-open icon, icon layout and labels, companion styles, voice controls/focus/error recovery, dark/light live appearance, secondary accents, transparent exterior, subscription cleanup, and missing-bridge fallback. No real device/network/application access.');
      window.destroy(); app.exit(0);
    } catch (error) { console.error(error); await screenshot('avatar-failure.png'); window.destroy(); app.exit(1); }
  }).catch((error) => { console.error(error); app.exit(1); });
}
