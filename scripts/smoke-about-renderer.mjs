#!/usr/bin/env node
/** Standalone About HTML/CSS/script with mocked IPC; never opens the real application. */
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
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-about-smoke-'));
  await build({
    entryPoints: [path.join(root, 'test/fixtures/about-renderer.ts')], outfile: path.join(output, 'fixture.js'),
    bundle: true, platform: 'browser', format: 'esm', plugins: [{ name: 'raw-version', setup(builder) {
      builder.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }));
      builder.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({ contents: await fs.readFile(args.path, 'utf8'), loader: 'text' }));
    } }],
  });
  const html = (await fs.readFile(path.join(root, 'renderer/src/about.html'), 'utf8'))
    .replace('href="/about.css"', 'href="./fixture.css"').replace('src="/about.ts"', 'src="./fixture.js"');
  await fs.writeFile(path.join(output, 'index.html'), html);
  console.log(`About smoke output: ${output}`);
  const child = spawn(electron, ['--ozone-platform=headless', '--ozone-override-screen-size=1280,960', filename, '--fixture', output], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const deadline = setTimeout(() => { console.error('About fixture timed out; stopping only the isolated fixture.'); child.kill(); process.exitCode = 1; }, 30_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data'));
  app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`about-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, frame: false, width: 520, height: 730, enableLargerThanScreen: true,
      webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const failures = [];
    window.webContents.on('console-message', (event) => { if (event.level === 'error') failures.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 60))');
    const screenshot = async (name) => {
      // Let the staggered entrance animations finish before judging actual text/layout.
      await run('new Promise(resolve => setTimeout(resolve, 1100))');
      await fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
    };
    const styles = () => run(`(() => {
      const read = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
      return { scheme: read('html', 'colorScheme'), surface: read('body', 'backgroundColor'), ink: read('#product-name', 'color'),
        fact: read('.fact', 'backgroundColor'), electron: read('.electron', 'fill'), glow: read('.glow-teal', 'backgroundImage'),
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() };
    })()`);
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      assert.equal(await run('document.title'), 'About Antimatter');
      assert.equal(await run('document.querySelector("#description").textContent'), 'Appearance smoke fixture');
      assert.equal(await run('document.querySelector("#release").textContent'), 'Package 1.0.0');
      const light = await styles();
      assert.equal(light.scheme, 'light');
      // The chosen #7352b6 is darkened to #6c4dab to meet contrast on light/tinted surfaces.
      assert.equal(light.accent, '108 77 171');
      assert.equal(await run('aboutSmoke.appearanceListeners()'), 1);
      await screenshot('about-light.png');
      await run('document.querySelector("#core").click(); document.querySelector("#close").focus(); window.appearanceFocus = document.activeElement');
      await tick(); const hotLight = await styles();
      assert.notEqual(hotLight.electron, light.electron, 'hot reactor consumes the selected accent');
      await run('aboutSmoke.emitAppearance({theme:"dark",secondaryAccent:"#d88a49"})'); await tick();
      const dark = await styles();
      assert.equal(dark.scheme, 'dark');
      assert.equal(dark.accent, '216 138 73');
      assert.notEqual(dark.surface, light.surface);
      assert.notEqual(dark.ink, light.ink);
      assert.notEqual(dark.fact, light.fact);
      assert.notEqual(dark.glow, light.glow);
      assert.notEqual(dark.electron, hotLight.electron);
      assert.equal(await run('document.activeElement === appearanceFocus'), true);
      assert.equal(await run('document.body.classList.contains("hot")'), true, 'appearance leaves About interactions intact');
      await screenshot('about-dark-custom-accent.png');
      await run('document.querySelector("#close").click(); document.querySelector("#close-chrome").click(); document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape"}))');
      assert.deepEqual(await run('aboutSmoke.actions'), ['close', 'close', 'close']);
      await run('window.dispatchEvent(new Event("unload"))');
      assert.equal(await run('aboutSmoke.appearanceListeners()'), 0);
      await window.loadFile(path.join(output, 'index.html'), { query: { appearance: 'missing' } }); await tick();
      assert.equal((await styles()).scheme, 'dark', 'missing appearance bridge retains safe defaults');
      assert.equal(await run('aboutSmoke.appearanceListeners()'), 0);
      assert.deepEqual(failures, []);
      console.log('About renderer smoke passed: initial/light and live/dark themes, secondary accent, readable token surfaces, reactor interaction, focus, close/Escape, cleanup, missing-bridge fallback. No real application access.');
      window.destroy(); app.exit(0);
    } catch (error) { console.error(error); await screenshot('about-failure.png'); window.destroy(); app.exit(1); }
  }).catch((error) => { console.error(error); app.exit(1); });
}
