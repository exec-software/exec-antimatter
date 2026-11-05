#!/usr/bin/env node
/** Isolated Pensieve Settings UI only: no production preload, real settings, network, or inference. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const processSeconds = 60;

if (!process.versions.electron) {
  assert.equal(process.argv.length, 2, 'This isolated smoke accepts no live endpoint or profile arguments.');
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  const { default: postcss } = await import('postcss');
  const { default: tailwindcss } = await import('tailwindcss');
  const { default: autoprefixer } = await import('autoprefixer');
  const { default: tailwindConfig } = await import('../tailwind.config.js');
  const base = process.env.PENSIEVE_UI_SMOKE_DIRECTORY || os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const output = await fs.mkdtemp(path.join(base, 'antimatter-pensieve-ui-'));
  await fs.chmod(output, 0o700);
  console.log(`Pensieve Settings UI smoke output: ${output}`);
  const entry = 'test/fixtures/pensieve-experimental-renderer.tsx';
  const built = await build({ absWorkingDir: root, entryPoints: [entry], outfile: path.join(output, 'fixture.js'),
    bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
  // Compile the actual current theme/utilities, including classes used only by the fixture.
  const cssPath = path.join(root, 'renderer/src/index.css');
  const css = await postcss([tailwindcss({ ...tailwindConfig,
    content: [...tailwindConfig.content, path.join(root, entry)] }), autoprefixer()])
    .process(await fs.readFile(cssPath, 'utf8'), { from: cssPath, to: path.join(output, 'fixture.css'), map: false });
  await fs.writeFile(path.join(output, 'fixture.css'), css.css);
  await fs.mkdir(path.join(output, 'assets/fonts'), { recursive: true });
  for (const name of ['c64-keyboard.woff2', 'ussr-stencil.ttf']) {
    await fs.copyFile(path.join(root, 'renderer/src/assets/fonts', name), path.join(output, 'assets/fonts', name));
  }
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\'; img-src \'self\' data:; connect-src \'none\'; media-src \'none\'"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
  const inputs = new Set(['scripts/smoke-pensieve-ui.mjs', 'renderer/src/index.css', 'tailwind.config.js',
    ...Object.keys(built.metafile.inputs).filter((input) => !input.startsWith('node_modules/'))]);
  const sources = {};
  for (const input of [...inputs].sort()) sources[input] = hash(await fs.readFile(path.resolve(root, input)));
  await fs.writeFile(path.join(output, 'source-hashes.json'), JSON.stringify(sources, null, 2) + '\n');
  for (const name of ['config', 'cache', 'state', 'data', 'runtime', 'tmp']) await fs.mkdir(path.join(output, name), { mode: 0o700 });
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1440,1200', filename, '--fixture', output], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '',
      XDG_CONFIG_HOME: path.join(output, 'config'), XDG_CACHE_HOME: path.join(output, 'cache'),
      XDG_STATE_HOME: path.join(output, 'state'), XDG_DATA_HOME: path.join(output, 'data'),
      XDG_RUNTIME_DIR: path.join(output, 'runtime'), TMPDIR: path.join(output, 'tmp') },
  });
  let timedOut = false, killDeadline;
  const deadline = setTimeout(() => {
    timedOut = true; console.error('Pensieve Settings fixture timed out; stopping only this isolated process.');
    child.kill(); killDeadline = setTimeout(() => child.kill('SIGKILL'), 2_000);
  }, processSeconds * 1000);
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(timedOut, false); assert.equal(signal, null); assert.equal(code, 0, 'Pensieve Settings UI smoke failed');
    const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
    assert.equal(report.passed, true);
  } finally { clearTimeout(deadline); clearTimeout(killDeadline); }
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  assert.ok(output && path.isAbsolute(output), 'An isolated fixture directory is required.');
  app.setPath('userData', path.join(output, 'user-data'));
  app.disableHardwareAcceleration();
  setTimeout(() => { console.error('Pensieve Settings process deadline exceeded.'); app.exit(1); }, processSeconds * 1000).unref();
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`pensieve-ui-${process.pid}`);
    const consoleErrors = [], deniedRequests = [], cases = [], screenshots = [];
    isolated.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let allowed = details.url.startsWith('data:');
      if (details.url.startsWith('file:')) {
        const relative = path.relative(output, fileURLToPath(details.url));
        allowed = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      }
      if (!allowed) deniedRequests.push(details.url);
      callback({ cancel: !allowed });
    });
    const window = new BrowserWindow({ show: false, width: 1160, height: 1000, enableLargerThanScreen: true,
      webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true,
        sandbox: true, offscreen: true, backgroundThrottling: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') { consoleErrors.push(event.message); console.error('Fixture renderer:', event.message); }
    });
    window.webContents.on('render-process-gone', (_event, details) => { consoleErrors.push(`Renderer exited: ${details.reason}`); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 40))');
    const waitFor = async (label, predicate) => {
      const until = Date.now() + 5_000;
      while (Date.now() < until) { if (await predicate()) return; await tick(); }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const button = (label) => `([...document.querySelectorAll('button')].find(item => item.checkVisibility() && item.textContent.trim() === ${JSON.stringify(label)}))`;
    const click = async (label) => {
      await run(`(() => { const item = ${button(label)}; if (!item || item.disabled) throw new Error('Unavailable button: ' + ${JSON.stringify(label)}); item.click(); })()`);
      await tick();
    };
    const state = () => run('window.pensieveSmoke.state()');
    const actions = () => run('[...window.pensieveSmoke.actions]');
    const screenshot = async (name) => {
      await run('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
      await fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
      screenshots.push(name);
    };
    const writeReport = async (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
    try {
      await window.loadFile(path.join(output, 'index.html'));
      await waitFor('initial controls', () => run('Boolean(window.pensieveSmoke && document.body.textContent.includes("Enable Pensieve"))'));
      assert.deepEqual(await actions(), []);
      assert.equal((await state()).enabled, false);
      assert.ok(await run('window.pensieveSmoke.stateReads() >= 1'));
      assert.match(await run('document.body.textContent'), /203 entries/);
      assert.match(await run('document.body.textContent'), /Corpus ID:/);
      assert.equal(await run(`${button('Enable Pensieve')}.disabled`), false);
      await screenshot('pensieve-disabled.png');
      cases.push('mount reads state without enabling and shows the pinned curriculum');

      await run('window.pensieveSmoke.hold(); void 0;');
      await run(`(() => { const item = ${button('Enable Pensieve')}; item.click(); item.click(); })()`);
      await waitFor('pending validation', () => run('document.body.textContent.includes("Checking memory and curriculum")'));
      assert.deepEqual(await actions(), [true]);
      assert.equal((await state()).enabled, false);
      assert.equal(await run(`${button('Enabling Pensieve…')}.disabled`), true);
      assert.equal(await run(`${button('Refresh status')}.disabled`), true);
      await run('window.pensieveSmoke.finish(); void 0;');
      await waitFor('enabled controls', () => run('document.body.textContent.includes("Turn off Pensieve")'));
      assert.equal((await state()).enabled, true);
      await run('window.pensieveSmoke.publish({statistics:{events:42,experiences:3,repairs:1},projectId:"project-fixture"}); void 0;');
      await waitFor('project counts', () => run('document.body.textContent.includes("42 recorded events" )'));
      window.setSize(560, 850); await tick();
      assert.equal(await run('document.documentElement.scrollWidth <= window.innerWidth'), true);
      await screenshot('pensieve-enabled.png');
      cases.push('enable validates once despite double click, disables busy controls and publishes project counts without narrow overflow');

      await click('Turn off Pensieve');
      await waitFor('off', async () => !(await state()).enabled);
      assert.equal((await state()).statistics.events, 42);
      await run('window.pensieveSmoke.failNextAction("Synthetic bridge failure. Memory remains off."); void 0;');
      await click('Enable Pensieve');
      await waitFor('visible failure', () => run('Boolean(document.querySelector("[role=alert]")?.textContent.includes("Synthetic bridge failure"))'));
      assert.equal((await state()).enabled, false);
      assert.equal(await run(`${button('Enable Pensieve')}.disabled`), false);
      await screenshot('pensieve-error.png');
      await click('Enable Pensieve');
      await waitFor('retry succeeds', async () => (await state()).enabled);
      assert.equal(await run('document.querySelector("[role=alert]") === null'), true);
      cases.push('off retains evidence counts; failed enable stays off and successful retry clears its visible error');

      await run('window.pensieveSmoke.publish({available:false,unavailableReason:"Bundle disappeared.",status:"error",error:"Bridge unavailable."}); void 0;');
      await waitFor('enabled unavailable controls', () => run('document.body.textContent.includes("Bridge unavailable")'));
      assert.equal(await run(`${button('Turn off Pensieve')}.disabled`), false);
      await click('Turn off Pensieve');
      await waitFor('disabled unavailable controls', async () => !(await state()).enabled);
      assert.equal(await run(`${button('Enable Pensieve')}.disabled`), true);
      cases.push('a failed runtime remains switchable off and an unavailable bundle cannot be enabled');
      assert.deepEqual(await actions(), [true, false, true, true, false]);
      assert.deepEqual(await run('window.pensieveSmoke.unexpected'), []);
      assert.deepEqual(consoleErrors, []); assert.deepEqual(deniedRequests, []);
      await writeReport('report.json', { passed: true, cases, screenshots, actions: await actions(),
        stateReads: await run('window.pensieveSmoke.stateReads()'), finalState: await state(), consoleErrors, deniedRequests,
        scope: { actualRendererComponent: true, actualThemeCSS: true, productionMain: false, productionPreload: false,
          realSettings: false, network: false, modelExecution: false, hardwareAcceleration: false } });
      console.log('Pensieve Settings UI smoke passed. Screenshots and report saved.');
      window.destroy(); app.exit(0);
    } catch (error) {
      await screenshot('pensieve-ui-failure.png').catch(() => undefined);
      await writeReport('failure.json', { error: String(error.stack ?? error), cases, screenshots, consoleErrors, deniedRequests });
      console.error(error); window.destroy(); app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
