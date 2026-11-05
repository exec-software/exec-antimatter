#!/usr/bin/env node
/** Isolated HAG opt-in UI only: no production preload, real settings, network, or inference. */
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
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-hag-opt-in-'));
  await fs.chmod(output, 0o700);
  console.log(`HAG opt-in UI smoke output: ${output}`);
  const entry = 'test/fixtures/hag-experimental-renderer.tsx';
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
  const inputs = new Set(['scripts/smoke-hag-opt-in.mjs', 'renderer/src/index.css', 'tailwind.config.js',
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
    timedOut = true; console.error('HAG opt-in fixture timed out; stopping only this isolated process.');
    child.kill(); killDeadline = setTimeout(() => child.kill('SIGKILL'), 2_000);
  }, processSeconds * 1000);
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(timedOut, false); assert.equal(signal, null); assert.equal(code, 0, 'HAG opt-in UI smoke failed');
    const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
    assert.equal(report.passed, true);
  } finally { clearTimeout(deadline); clearTimeout(killDeadline); }
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  assert.ok(output && path.isAbsolute(output), 'An isolated fixture directory is required.');
  app.setPath('userData', path.join(output, 'user-data'));
  app.disableHardwareAcceleration();
  setTimeout(() => { console.error('HAG opt-in process deadline exceeded.'); app.exit(1); }, processSeconds * 1000).unref();
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`hag-opt-in-${process.pid}`);
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
    const state = () => run('window.hagSmoke.state()');
    const actions = () => run('[...window.hagSmoke.actions]');
    const screenshot = async (name) => {
      await run('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
      await fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
      screenshots.push(name);
    };
    const writeReport = async (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
    try {
      await window.loadFile(path.join(output, 'index.html'));
      await waitFor('first-update offer', () => run('Boolean(window.hagSmoke && document.querySelector("[role=dialog]"))'));
      assert.deepEqual(await actions(), []);
      assert.ok(await run('window.hagSmoke.stateReads() >= 1'));
      assert.equal((await state()).enabled, false);
      assert.deepEqual(await run('window.hagSmoke.submitted'), []);
      assert.deepEqual(await run('window.hagSmoke.previousChoice()'), { providerId: 'local-openmythos-27b', modelId: 'openmythos-27b' });
      assert.equal(await run('document.activeElement.id'), 'hag-welcome-title');
      const background = await run('getComputedStyle(document.querySelector("[role=dialog]")).backgroundColor');
      assert.ok(background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)', 'Actual theme CSS must paint an opaque dialog.');
      assert.match(await run('document.querySelector("[role=dialog]").textContent'), /1,024 evaluated tokens/);
      await screenshot('hag-welcome.png');
      cases.push('welcome is observational, preserves default choice, focuses the dialog, and uses actual theme CSS');

      await click('Keep current setup');
      await waitFor('dismissal', () => run('!document.querySelector("[role=dialog]")'));
      assert.deepEqual(await actions(), ['dismissWelcome']);
      assert.equal((await state()).enabled, false);
      await run('window.hagSmoke.publish({ showWelcome: true }); void 0;');
      await waitFor('reopened offer', () => run('Boolean(document.querySelector("[role=dialog]"))'));
      // Two immediate clicks exercise the hook's in-flight guard before React disables the DOM.
      await run(`(() => { const item = ${button('Download & enable HAG')}; if (!item || item.disabled) throw new Error('Enable unavailable'); item.click(); item.click(); })()`);
      await waitFor('pending download', () => run('Boolean(document.querySelector("progress"))'));
      assert.deepEqual(await actions(), ['dismissWelcome', 'enable']);
      assert.equal(await run(`${button('Keep current setup')}.disabled`), true);
      assert.equal(await run(`${button('Enabling HAG…')}.disabled`), true);
      assert.equal(await run('document.querySelector("progress").value'), 123000000);
      assert.equal((await state()).enabled, false);
      await run(`${button('Keep current setup')}.click()`); await tick();
      assert.deepEqual(await actions(), ['dismissWelcome', 'enable']);
      await screenshot('hag-download.png');
      cases.push('dismissal stays off; explicit enable starts one synthetic download; busy controls cannot duplicate or cancel it');

      await run('window.hagSmoke.finishDownload(); void 0;');
      await waitFor('enabled settings and composer', () => run('Boolean(!document.querySelector("[role=dialog]") && document.querySelector("textarea[aria-label=Message]") && document.body.textContent.includes("Enabled · starts with your first message"))'));
      assert.equal((await state()).status, 'stopped', 'Enable never starts the model.');
      assert.equal(await run(`document.querySelector('[aria-label="Add files"]').disabled`), true);
      assert.equal(await run('document.body.textContent.includes("Permissions:")'), false);
      assert.match(await run(`document.querySelector('[aria-label="HAG text preview"]').textContent`), /replies are limited to 64 tokens/);
      await run('(() => { const input = document.querySelector("textarea[aria-label=Message]"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "Say hello in one sentence."); input.dispatchEvent(new Event("input", { bubbles: true })); })()');
      await tick();
      window.setSize(680, 1000); await tick();
      assert.equal(await run('document.documentElement.scrollWidth <= window.innerWidth'), true);
      await screenshot('hag-settings-composer.png');
      await run(`document.querySelector('[aria-label="Send message"]').click()`);
      await waitFor('synthetic text submission', () => run('window.hagSmoke.submitted.length === 1'));
      assert.deepEqual(await run('window.hagSmoke.submitted'), ['Say hello in one sentence.']);
      assert.equal(await run('document.querySelector("textarea[aria-label=Message]").value'), '');
      assert.deepEqual(await run('window.hagSmoke.previousChoice()'), { providerId: 'local-openmythos-27b', modelId: 'openmythos-27b' });
      cases.push('completion closes welcome, leaves model stopped, exposes bounded text composer, preserves default, and renders without narrow overflow');

      await click('Turn off HAG');
      await waitFor('disabled setting', async () => !(await state()).enabled);
      assert.equal(await run('document.querySelector("textarea[aria-label=Message]") === null'), true);
      assert.equal((await state()).modelDownloadBytes, 0, 'Disable retains the verified checkpoint in fixture state.');
      await run('window.hagSmoke.failNextAction("Synthetic enable failure. Retry is safe."); void 0;');
      await click('Enable experimental HAG');
      await waitFor('visible action failure', () => run('Boolean(document.querySelector("[role=alert]")?.textContent.includes("Synthetic enable failure"))'));
      assert.equal((await state()).enabled, false);
      assert.equal(await run(`${button('Enable experimental HAG')}.disabled`), false);
      await click('Enable experimental HAG');
      await waitFor('successful retry', async () => (await state()).enabled);
      assert.equal(await run('document.querySelector("[role=alert]") === null'), true);
      assert.equal((await state()).status, 'stopped');
      cases.push('off control retains checkpoint; failed enable remains off, shows error, and permits a successful retry');

      await run('window.hagSmoke.publish({ available: false, unavailableReason: "Synthetic unsupported GPU.", status: "error", error: "Synthetic device disappeared." }); void 0;');
      await waitFor('unavailable enabled state', () => run('document.body.textContent.includes("Synthetic device disappeared")'));
      assert.equal(await run(`${button('Turn off HAG')}.disabled`), false);
      await click('Turn off HAG');
      await waitFor('unavailable disabled state', async () => !(await state()).enabled);
      assert.equal(await run(`${button('Enable experimental HAG')}.disabled`), true);
      const beforeBlocked = await actions();
      await run(`${button('Enable experimental HAG')}.click()`); await tick();
      assert.deepEqual(await actions(), beforeBlocked);
      cases.push('unsupported hardware can still be turned off, then cannot be enabled');

      assert.deepEqual(await actions(), ['dismissWelcome', 'enable', 'disable', 'enable', 'enable', 'disable']);
      assert.deepEqual(await run('window.hagSmoke.unexpected'), []);
      assert.deepEqual(consoleErrors, []); assert.deepEqual(deniedRequests, []);
      await writeReport('report.json', { passed: true, cases, screenshots, actions: await actions(),
        stateReads: await run('window.hagSmoke.stateReads()'), finalState: await state(),
        previousChoice: await run('window.hagSmoke.previousChoice()'), submitted: await run('window.hagSmoke.submitted'),
        consoleErrors, deniedRequests, scope: { rendererComponents: true, productionMain: false,
          productionPreload: false, realSettings: false, network: false, modelExecution: false,
          hardwareAcceleration: false, download: 'in-memory simulated progress only', defaultModelRevert: 'fixture choice preserved; backend persistence covered separately' } });
      console.log('HAG opt-in UI smoke passed: welcome, explicit single download, completion, text composer, off switch, failure/retry, unsupported hardware. Screenshots and report saved.');
      window.destroy(); app.exit(0);
    } catch (error) {
      await screenshot('hag-opt-in-failure.png').catch(() => undefined);
      await writeReport('failure.json', { error: String(error.stack ?? error), cases, screenshots, consoleErrors, deniedRequests,
        fixture: await run('window.hagSmoke ? { actions: window.hagSmoke.actions, state: window.hagSmoke.state(), unexpected: window.hagSmoke.unexpected } : null').catch(() => null) });
      console.error(error); window.destroy(); app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
