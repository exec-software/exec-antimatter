#!/usr/bin/env node
/** Real Electron preload/IPC/first-paint check. Never boots Antimatter or accesses its user profile. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const filename = fileURLToPath(import.meta.url);
if (!process.versions.electron) {
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  const root = path.resolve(path.dirname(filename), '..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-appearance-bootstrap-'));
  const preloadFlag = process.argv.indexOf('--preload-dir');
  const preloadSource = preloadFlag === -1 ? null : process.argv[preloadFlag + 1];
  if (preloadFlag !== -1 && (!preloadSource || preloadSource.startsWith('--'))) throw new Error('--preload-dir requires an existing build directory.');
  await Promise.all([
    preloadSource ? fs.cp(path.resolve(preloadSource), path.join(output, 'preload'), { recursive: true }) :
      build({ entryPoints: [path.join(root, 'src/preload/index.ts'), path.join(root, 'src/preload/avatar.ts')],
        outdir: path.join(output, 'preload'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'warning' }),
    build({ entryPoints: [path.join(root, 'test/fixtures/appearance-bootstrap.ts')], outfile: path.join(output, 'fixture.js'),
      bundle: true, platform: 'browser', format: 'esm', logLevel: 'warning' }),
    build({ entryPoints: [path.join(root, 'src/main/appearance.ts')], outfile: path.join(output, 'host.cjs'),
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning' }),
  ]);
  await fs.writeFile(path.join(output, 'preload-source.json'), JSON.stringify({ source: preloadSource ? path.resolve(preloadSource) : 'source-bundle' }));
  const html = (avatar) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'"><style>:root{--color-surface:20 20 20;color-scheme:dark}html,body{margin:0;width:100%;height:100%;${avatar ? 'background:transparent;' : ''}}body{background:${avatar ? 'transparent' : 'rgb(var(--color-surface))'}}</style></head><body><script type="module" src="fixture.js"></script></body></html>`;
  for (const name of ['index.html', 'about.html', 'avatar.html']) await fs.writeFile(path.join(output, name), html(name === 'avatar.html'));
  // Exercise the recovery page's actual standalone stylesheet with the same appearance controller.
  await fs.writeFile(path.join(output, 'recovery.html'), (await fs.readFile(path.join(root, 'renderer/src/recovery.html'), 'utf8'))
    .replace('src="/recovery.ts"', 'src="./fixture.js"'));
  for (const name of ['config', 'cache', 'state', 'data', 'runtime', 'tmp']) await fs.mkdir(path.join(output, name), { mode: 0o700 });
  console.log(`Native appearance bootstrap smoke output: ${output}`);
  const child = spawn(electron, ['--ozone-platform=headless', '--ozone-override-screen-size=1024,768', filename, '--fixture', output], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '',
      XDG_CONFIG_HOME: path.join(output, 'config'), XDG_CACHE_HOME: path.join(output, 'cache'),
      XDG_STATE_HOME: path.join(output, 'state'), XDG_DATA_HOME: path.join(output, 'data'),
      XDG_RUNTIME_DIR: path.join(output, 'runtime'), TMPDIR: path.join(output, 'tmp') },
  });
  const timeout = setTimeout(() => { console.error('Appearance bootstrap fixture exceeded 30 seconds.'); child.kill(); process.exitCode = 1; }, 30_000);
  child.on('error', (error) => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(timeout); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, nativeTheme, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data'));
  app.commandLine.appendSwitch('disable-gpu');
  const { AppearanceSettingsStore, appearanceBackground, isAppearancePage, mayReadAppearance, mayUpdateAppearance } = await import(pathToFileURL(path.join(output, 'host.cjs')).href);
  const windows = new Map();
  const syncReads = [];
  const errors = [];
  const firstPaints = new Map();
  const store = new AppearanceSettingsStore(path.join(output, 'user-data', 'appearance.json'));
  store.update({ theme: 'light', secondaryAccent: '#aa88cc' });
  const authorize = (event, write = false) => {
    const surface = [...windows.entries()].find(([, window]) => window.webContents === event.sender)?.[0] ?? null;
    const owned = ['main', 'about', 'avatar', 'recovery'].includes(surface) ? surface : null;
    const top = !event.sender.isDestroyed() && event.senderFrame !== null && event.senderFrame === event.sender.mainFrame;
    const entry = owned === 'about' ? 'about.html' : owned === 'avatar' ? 'avatar.html' : owned === 'recovery' ? 'recovery.html' : 'index.html';
    const page = top && isAppearancePage(event.senderFrame.url, entry, output);
    return (write ? mayUpdateAppearance : mayReadAppearance)(owned, top, page);
  };
  ipcMain.on('appearance:initial', (event) => {
    const allowed = authorize(event);
    syncReads.push({ url: event.senderFrame?.url, top: event.senderFrame === event.sender.mainFrame, allowed });
    event.returnValue = allowed ? store.get() : null;
  });
  ipcMain.handle('appearance:get', (event) => {
    if (!authorize(event)) throw new Error('Untrusted appearance read.');
    return store.get();
  });
  ipcMain.handle('appearance:update', (event, patch) => {
    if (!authorize(event, true)) throw new Error('Untrusted appearance update.');
    const saved = store.update(patch);
    nativeTheme.themeSource = saved.theme;
    for (const [surface, window] of windows) {
      if (!['main', 'about', 'avatar', 'recovery'].includes(surface)) continue;
      if (surface !== 'avatar') window.setBackgroundColor(appearanceBackground(saved));
      window.webContents.send('appearance:changed', saved);
    }
    return saved;
  });
  const pixel = (image) => {
    const { width, height } = image.getSize();
    const bytes = image.toBitmap();
    const offset = (Math.min(8, height - 1) * width + Math.min(8, width - 1)) * 4;
    return { r: bytes[offset + 2], g: bytes[offset + 1], b: bytes[offset], a: bytes[offset + 3] };
  };
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`appearance-bootstrap-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const create = (surface) => {
      const avatar = surface === 'avatar';
      const window = new BrowserWindow({ show: false, width: 320, height: 240, frame: false, transparent: avatar,
        backgroundColor: avatar ? '#00000000' : appearanceBackground(store.get()),
        webPreferences: { session: isolated, preload: path.join(output, 'preload', avatar ? 'avatar.js' : 'index.js'),
          nodeIntegration: false, contextIsolation: true, sandbox: avatar, offscreen: true,
          // Fixture-only: run the real preload inside a same-page iframe to exercise denied IPC.
          nodeIntegrationInSubFrames: !avatar },
      });
      windows.set(surface, window);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('console-message', (event) => {
        if (event.level === 'error' || event.message.includes('[appearance]')) errors.push({ surface, message: event.message });
      });
      window.webContents.on('paint', (_event, _dirty, image) => {
        if (!firstPaints.has(surface)) firstPaints.set(surface, pixel(image));
      });
      return window;
    };
    const run = (surface, code) => windows.get(surface).webContents.executeJavaScript(code);
    const waitFor = async (surface, expression) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await run(surface, expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${surface}: ${expression}`);
    };
    try {
      for (const surface of ['main', 'about', 'avatar', 'recovery', 'preview']) {
        const window = create(surface);
        await window.loadFile(path.join(output, surface === 'main' || surface === 'preview' ? 'index.html' : `${surface}.html`));
        await waitFor(surface, 'Boolean(window.bootstrapSmoke)');
      }
      for (const surface of ['main', 'about', 'avatar', 'recovery']) {
        const before = await run(surface, 'bootstrapSmoke.before');
        assert.equal(before.surface, '246 245 242', `${surface} must use saved light vars before renderer initialization`);
        assert.equal(before.scheme, 'light');
        assert.equal(before.primary, before.accent, `${surface} first-paint actions use the selected accent`);
        if (surface === 'recovery') assert.equal(before.body, 'rgb(246, 245, 242)', 'standalone recovery CSS uses the saved palette');
        assert.equal(before.inlineSurface, '', 'only the author-origin preload fallback is active');
        assert.deepEqual(before.initial, { theme: 'light', secondaryAccent: '#aa88cc' });
        assert.equal(before.hasUpdate, surface !== 'avatar');
      }
      assert.equal(await run('avatar', 'bootstrapSmoke.before.body'), 'rgba(0, 0, 0, 0)', 'preload styling must preserve avatar transparency');
      const avatarLightPixel = pixel(await windows.get('avatar').webContents.capturePage());
      assert.equal(avatarLightPixel.a, 0, 'loaded avatar is transparent before the renderer controller starts');
      await run('avatar', 'document.documentElement.style.colorScheme="normal"');
      const avatarNormalPixel = pixel(await windows.get('avatar').webContents.capturePage());
      await run('avatar', 'document.documentElement.style.colorScheme=""');
      assert.equal(await run('preview', 'bootstrapSmoke.before.initial.theme'), 'dark', 'unknown windows receive only public defaults');
      for (const surface of ['about', 'recovery', 'preview']) {
        assert.equal(await run(surface, 'electronAPI.appearance.update({theme:"dark"}).then(()=>false,()=>true)'), true);
      }
      assert.equal(await run('preview', 'electronAPI.appearance.get().then(()=>false,()=>true)'), true);
      await run('main', 'new Promise(resolve=>{const frame=document.createElement("iframe");frame.onload=resolve;frame.src="index.html?iframe=1";document.body.appendChild(frame);})');
      const childFrame = windows.get('main').webContents.mainFrame.frames.find((frame) => frame.url.includes('iframe=1'));
      assert.ok(childFrame);
      assert.equal(await childFrame.executeJavaScript('electronAPI.appearance.get().then(()=>false,()=>true)'), true);
      assert.equal(await childFrame.executeJavaScript('electronAPI.appearance.update({theme:"dark"}).then(()=>false,()=>true)'), true);
      assert.ok(syncReads.some((entry) => !entry.top && !entry.allowed && entry.url.includes('iframe=1')));
      assert.ok(syncReads.filter((entry) => entry.allowed).every((entry) => entry.top && entry.url.startsWith('file:')));
      const firstImage = await windows.get('about').webContents.capturePage();
      assert.deepEqual(pixel(firstImage), { r: 246, g: 245, b: 242, a: 255 });
      for (const surface of ['main', 'about']) {
        assert.deepEqual(firstPaints.get(surface), { r: 246, g: 245, b: 242, a: 255 }, `${surface} first paint must already be light`);
      }
      await fs.writeFile(path.join(output, 'preload-light-before-renderer.png'), firstImage.toPNG());
      for (const surface of ['main', 'about', 'avatar', 'recovery']) await run(surface, 'bootstrapSmoke.start(); true');
      await run('main', 'bootstrapSmoke.save({theme:"dark",secondaryAccent:"#629cf5"})');
      for (const surface of ['main', 'about', 'avatar', 'recovery']) {
        await waitFor(surface, 'bootstrapSmoke.read().surface === "20 20 20"');
        const after = await run(surface, 'bootstrapSmoke.read()');
        assert.equal(after.scheme, 'dark');
        assert.equal(after.primary, after.accent, `${surface} actions follow the live accent`);
        assert.equal(after.primary, '98 156 245');
        assert.equal(after.inlineSurface, '20 20 20', 'live inline styling supersedes the light preload fallback');
      }
      assert.deepEqual(new AppearanceSettingsStore(path.join(output, 'user-data', 'appearance.json')).get(), { theme: 'dark', secondaryAccent: '#629cf5' });
      assert.equal(await run('avatar', 'typeof desktopAvatar.appearance.update'), 'undefined');
      assert.equal(await run('avatar', 'bootstrapSmoke.read().body'), 'rgba(0, 0, 0, 0)');
      const avatarDarkPixel = pixel(await windows.get('avatar').webContents.capturePage());
      assert.equal(avatarDarkPixel.a, 0, 'avatar stays transparent after a live theme update');
      assert.deepEqual(errors, []);
      const report = { passed: true, realPreloads: true, preloadSource: JSON.parse(await fs.readFile(path.join(output, 'preload-source.json'), 'utf8')).source,
        savedLightBeforeRenderer: true, liveInlineOverride: true,
        iframeDenied: true, previewDenied: true, aboutMutationDenied: true, recoveryReadOnly: true, avatarReadOnly: true, sharedActionAccent: true,
        avatarCssTransparent: true, avatarCompositorPixels: { light: avatarLightPixel, normal: avatarNormalPixel, dark: avatarDarkPixel },
        syncReads, firstPaints: Object.fromEntries(firstPaints), realUserProfileTouched: false };
      await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify(report, null, 2));
      for (const window of windows.values()) window.destroy();
      app.exit(0);
    } catch (error) {
      console.error(error, errors, syncReads);
      for (const window of windows.values()) if (!window.isDestroyed()) window.destroy();
      app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
