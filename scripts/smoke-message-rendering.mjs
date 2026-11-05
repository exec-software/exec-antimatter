#!/usr/bin/env node
/** Counts real Markdown renders while exercising real message bodies in isolated Electron. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const filename = fileURLToPath(import.meta.url);
if (!process.versions.electron) {
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  const root = path.resolve(path.dirname(filename), '..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-message-rendering-'));
  const markdown = createRequire(import.meta.url).resolve('react-markdown');
  await build({ entryPoints: [path.join(root, 'test/fixtures/message-rendering.tsx')], outfile: path.join(output, 'fixture.js'),
    bundle: true, platform: 'browser', format: 'esm', plugins: [{ name: 'count-real-markdown', setup(build) {
      build.onResolve({ filter: /^react-markdown$/ }, () => ({ path: 'counted', namespace: 'markdown-count' }));
      build.onLoad({ filter: /.*/, namespace: 'markdown-count' }, () => ({ resolveDir: root, contents: `
        import { createElement } from 'react';
        import Markdown from ${JSON.stringify(markdown)};
        export default function CountedMarkdown(props) {
          const key = /^# (History \\d+|Live|Image)/.exec(props.children)?.[1] ?? 'fragment';
          const counts = window.markdownParses ??= {};
          counts[key] = (counts[key] ?? 0) + 1;
          return createElement(Markdown, props);
        }` }));
    } }] });
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', filename, '--fixture', output], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30_000);
  child.once('error', (error) => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
  child.once('exit', (code) => { clearTimeout(timeout); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data'));
  app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
  const isolated = session.fromPartition(`message-rendering-${process.pid}`);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
  const window = new BrowserWindow({ show: false, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
  const errors = [];
  window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  const run = (code) => window.webContents.executeJavaScript(code);
  const snapshot = () => run('messageSmoke.snapshot()');
  const call = (name, ...args) => run(`messageSmoke.${name}(${args.map((arg) => JSON.stringify(arg)).join(',')})`);
  const historical = (state) => Object.fromEntries(Object.entries(state.parses).filter(([key]) => key.startsWith('History ')));
  try {
    await window.loadFile(path.join(output, 'index.html'));
    const first = await snapshot();
    assert.equal(Object.keys(historical(first)).length, 40);
    assert.ok(Object.values(historical(first)).every((count) => count === 1));
    assert.equal(first.imageCount, 0); assert.equal(first.importedImage, true);
    for (let index = 0; index < 20; index++) {
      await call('append', ` chunk${index}`);
      assert.match((await snapshot()).live, new RegExp(`chunk${index}`));
      await call('think', `Reasoning ${index}: inspect the code carefully.`);
      await call('parent');
    }
    await call('cloneHistory');
    let state = await snapshot();
    assert.deepEqual(historical(state), historical(first), 'unchanged history must not reparse for text, reasoning, context or checkpoint object changes');
    assert.equal(state.parses.Live, first.parses.Live + 20, 'current text must render every chunk immediately');
    await call('showThinking');
    await call('think', 'Newest reasoning is visible immediately.');
    assert.match((await snapshot()).live, /Newest reasoning is visible immediately/);
    await call('editHistory');
    state = await snapshot(); assert.match(state.edited, /Edited history/);
    assert.equal(state.parses['History 3'], 2);
    assert.equal(state.parses['History 4'], 1);
    await call('approval', 'pending'); assert.equal((await snapshot()).allow, 1);
    await call('append', ' Still streaming.'); assert.equal((await snapshot()).allow, 1);
    await call('click', 'Allow');
    assert.deepEqual((await snapshot()).effects, [['approve-once', true]]);
    await call('approval', 'done'); assert.equal((await snapshot()).allow, 0);
    await call('active', false);
    assert.doesNotMatch((await snapshot()).live, /Waiting for model output|Thinking/);
    await call('imported', false); assert.equal((await snapshot()).imageCount, 1);
    await call('imported', true); assert.equal((await snapshot()).imageCount, 0);
    assert.equal((await snapshot()).importedImage, true);
    assert.deepEqual(errors, []);
    console.log('Message rendering smoke passed: 40 settled Markdown messages parsed once across 20 immediate text chunks, reasoning/context updates and cloned checkpoints; history edits, thinking, approvals and imported-image policy remain live.');
    window.destroy(); app.exit(0);
  } catch (error) {
    console.error(error, errors); console.error(await snapshot()); window.destroy(); app.exit(1);
  }
  }).catch((error) => { console.error(error); app.exit(1); });
}
