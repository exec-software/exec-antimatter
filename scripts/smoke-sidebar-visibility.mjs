#!/usr/bin/env node
/** Real sidebar, private temporary store, synthetic chats. No network or user's data. */
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
  const { default: postcss } = await import('postcss');
  const { default: tailwindcss } = await import('tailwindcss');
  const { default: tailwindConfig } = await import('../tailwind.config.js');
  const root = path.resolve(path.dirname(filename), '..');
  const outputRoot = process.env.ANTIMATTER_SMOKE_ROOT ?? os.tmpdir();
  await fs.mkdir(outputRoot, { recursive: true });
  const output = await fs.mkdtemp(path.join(outputRoot, 'antimatter-sidebar-smoke-'));
  const css = await postcss([tailwindcss(tailwindConfig)]).process(await fs.readFile(path.join(root, 'renderer/src/index.css'), 'utf8'), { from: path.join(root, 'renderer/src/index.css') });
  await fs.writeFile(path.join(output, 'fixture.css'), css.css);
  await Promise.all([
    build({ entryPoints: [path.join(root, 'test/fixtures/sidebar-visibility-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' }),
    build({ entryPoints: [path.join(root, 'src/main/sidebar.ts')], outfile: path.join(output, 'store.cjs'), bundle: true, platform: 'node', format: 'cjs' }),
  ]);
  await fs.writeFile(path.join(output, 'preload.cjs'), `const { contextBridge, ipcRenderer } = require('electron'); contextBridge.exposeInMainWorld('sidebarHost', {load: () => ipcRenderer.invoke('fixture:load'), update: request => ipcRenderer.invoke('fixture:update', request)});`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
  console.log(`Sidebar smoke output: ${output}`);
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1440,1200', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  const { SidebarStore } = await import(pathToFileURL(path.join(output, 'store.cjs')).href);
  const store = new SidebarStore(path.join(output, 'private-state/sidebar.json'));
  app.setPath('userData', path.join(output, 'user-data')); app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`sidebar-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, width: 1440, height: 1100, webPreferences: { session: isolated, preload: path.join(output, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    ipcMain.handle('fixture:load', (event) => { assert.equal(event.sender.id, window.webContents.id); return store.read(); });
    ipcMain.handle('fixture:update', (event, request) => { assert.equal(event.sender.id, window.webContents.id); return store.update(request); });
    const failures = []; window.webContents.on('console-message', (event) => { if (event.level === 'error' && !event.message.includes('ERR_FILE_NOT_FOUND')) failures.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 90))');
    const snap = () => run('sidebarSmoke.snapshot()');
    const click = async (label) => { await run(`sidebarSmoke.click(${JSON.stringify(label)})`); await tick(); };
    const toggle = async (label) => { await run(`sidebarSmoke.toggle(${JSON.stringify(label)})`); await tick(); };
    const field = async (selector, value) => { await run(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('Missing field'); Object.getOwnPropertyDescriptor(e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event(e instanceof HTMLSelectElement ? 'change' : 'input', {bubbles:true}));})()`); await tick(); };
    const drag = async (id, destination, before) => { await run(`(() => {
      const source=[...document.querySelectorAll('[data-thread-row]')].find(e=>e.dataset.threadRow===${JSON.stringify(id)} && !e.closest('[hidden]'));
      const section=[...document.querySelectorAll('aside section')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(destination)});
      const target=${JSON.stringify(before ?? null)} ? [...section.querySelectorAll('[data-thread-row]')].find(e=>e.dataset.threadRow===${JSON.stringify(before ?? null)}) : section;
      if(!source || !target) throw Error('Missing drag target'); const dataTransfer=new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', {bubbles:true,dataTransfer})); target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));
      target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer})); source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer}));
    })()`); await tick(); };
    const key = async (keyCode) => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode }); if (keyCode === 'Return' || keyCode === 'Space') window.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? '\r' : ' ' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await tick(); };
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      let snapshot = await snap();
      for (const label of ['Agents', 'Memory', 'Tools', 'Skills', 'Plugins', 'Models', 'Orchestrator', "What's New", 'Customize sidebar']) assert.ok(!snapshot.buttons.includes(label), `${label} moved to Settings`);
      assert.deepEqual(snapshot.sectionRows.Recent, ['native', 'second', 'third']);
      assert.deepEqual(snapshot.sectionRows['Codex chats'], []);
      await click('Toggle Codex chats'); assert.deepEqual((await snap()).sectionRows['Codex chats'], ['codex']);
      const originalImports = snapshot.threads.filter(thread => thread.importedFrom);

      // All sections support pointer reordering; context-menu Move up is the keyboard alternative.
      await drag('third', 'Recent', 'native'); assert.deepEqual((await snap()).sectionRows.Recent, ['third', 'native', 'second']);
      await click('Actions for Find second'); await click('Move up'); assert.deepEqual((await snap()).sectionRows.Recent, ['third', 'second', 'native']);
      await drag('native', 'Pinned', 'pinned'); assert.deepEqual((await snap()).sectionRows.Pinned, ['native', 'pinned']);
      await drag('native', 'Recent', 'second'); assert.deepEqual((await snap()).sectionRows.Recent, ['third', 'native', 'second']);
      await drag('codex', 'Recent', 'native'); assert.deepEqual((await snap()).sectionRows.Recent, ['third', 'codex', 'native', 'second']);
      assert.deepEqual((await snap()).threads.filter(thread => thread.importedFrom), originalImports);
      await click('Actions for Find codex'); await click('Move to imported chats'); assert.deepEqual((await snap()).sectionRows['Codex chats'], ['codex']);

      await click('New project group'); await field('dialog input', 'Parent'); await click('Save');
      let parent = (await snap()).workspace.projects.find(project => project.name === 'Parent'); assert.ok(parent);
      await click('Actions for Parent'); await click('New subgroup'); await field('dialog input', 'Child'); await click('Save');
      let child = (await snap()).workspace.projects.find(project => project.name === 'Child'); assert.equal(child.parentId, parent.id);
      await click('Actions for Child'); await click('Edit group'); await field('dialog input', 'Renamed child'); await click('Save');
      child = (await snap()).workspace.projects.find(project => project.id === child.id); assert.equal(child.name, 'Renamed child');
      await click('Actions for Find native'); await click('Move to project…'); await field('dialog select', child.id); await click('Move');
      assert.equal((await snap()).workspace.threadProjects.native, child.id);
      await click('Collapse Parent'); assert.ok(!(await snap()).projects.some(project => project.id === child.id));
      await click('Expand Parent'); assert.ok((await snap()).projects.some(project => project.id === child.id));
      await click('Actions for Parent'); await click('Remove group'); await click('Remove group');
      assert.equal((await snap()).workspace.projects.find(project => project.id === child.id).parentId, null);
      await click('Actions for Renamed child'); await click('Remove group'); await click('Remove group');
      assert.equal((await snap()).workspace.threadProjects.native, null);
      for (const label of ['Inbox', 'Projects', 'Research']) { await click(`Actions for ${label}`); await click('Remove group'); await click('Remove group'); }
      assert.equal((await snap()).workspace.projects.length, 0);
      assert.ok((await snap()).buttons.includes('All chats')); assert.ok((await snap()).buttons.includes('Ungrouped'));
      assert.equal((await snap()).threads.length, 7);

      // Preferences in Settings update the mounted rail immediately, then survive renderer reload.
      await click('Settings'); await toggle('Code'); assert.ok(!(await snap()).buttons.includes('Code'));
      await run('sidebarSmoke.hideAll()'); await tick(); assert.deepEqual((await snap()).sections, []);
      await run('sidebarSmoke.search("find")'); await tick(); snapshot = await snap();
      assert.deepEqual(snapshot.rows.sort(), ['claude','codex','native','opencode','pinned','second','third']);
      await run('sidebarSmoke.search("")'); await tick(); assert.deepEqual((await snap()).sections, []);
      await click('Show all sections'); assert.ok((await snap()).buttons.includes('Code'));
      await click('Chats'); await click('Toggle Recent'); assert.equal((await snap()).workspace.collapsed.recent, true);
      await fs.writeFile(path.join(output, 'sidebar-organized.png'), (await window.webContents.capturePage()).toPNG());
      window.webContents.reload(); await new Promise(resolve => window.webContents.once('did-finish-load', resolve)); await tick();
      snapshot = await snap(); assert.equal(snapshot.workspace.projects.length, 0); assert.equal(snapshot.workspace.collapsed.recent, true);
      assert.deepEqual(snapshot.sectionRows.Recent, []); await click('Toggle Recent');
      assert.deepEqual((await snap()).sectionRows.Recent, ['third','native','second']);
      window.webContents.focus(); await run('sidebarSmoke.focus("New project group")'); await key('Return');
      assert.equal(await run('document.activeElement?.tagName'), 'INPUT'); await key('Escape');
      assert.equal(await run('document.querySelector("dialog") === null'), true);
      assert.equal((await snap()).focus, 'New project group');
      await click('Settings'); await fs.writeFile(path.join(output, 'sidebar-settings.png'), (await window.webContents.capturePage()).toPNG());
      assert.deepEqual(failures, []);
      console.log('Sidebar smoke passed: settings relocation, same-window preferences, search recovery, drag/drop, keyboard reorder, import provenance, nested CRUD, deleting defaults, private store reload, collapse, modal keyboard focus.');
      window.destroy(); app.exit(0);
    } catch (error) {
      console.error(error, failures); console.error(await snap());
      await fs.writeFile(path.join(output, 'failure.png'), (await window.webContents.capturePage()).toPNG()); window.destroy(); app.exit(1);
    }
  }).catch(error => { console.error(error); app.exit(1); });
}
