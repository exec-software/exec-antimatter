#!/usr/bin/env node
/** Isolated Electron exercise for Research, Code, Flow, and their keyboard view switcher. */
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
  const { default: postcss } = await import('postcss');
  const { default: tailwindcss } = await import('tailwindcss');
  const { default: config } = await import('../tailwind.config.js');
  const root = path.resolve(path.dirname(filename), '..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-conversation-views-smoke-'));
  const assets = process.argv[2] ?? path.join(root, 'dist-electron/renderer/assets');
  for (const name of await fs.readdir(assets)) if (/\.woff2?$/.test(name)) await fs.copyFile(path.join(assets, name), path.join(output, name));
  const css = await postcss([tailwindcss(config)]).process(await fs.readFile(path.join(root, 'renderer/src/index.css'), 'utf8'), { from: path.join(root, 'renderer/src/index.css') });
  await fs.writeFile(path.join(output, 'views.css'), css.css);
  await build({ entryPoints: [path.join(root, 'test/fixtures/conversation-views-renderer.tsx')], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm' });
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="./views.css"><link rel="stylesheet" href="./fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>');
  console.log(`Conversation views smoke output: ${output}`);
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1440,1024', filename, '--fixture', output], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 60_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data')); app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const isolated = session.fromPartition(`conversation-views-smoke-${process.pid}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
    const window = new BrowserWindow({ show: false, width: 1180, height: 880, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
    const errors = []; window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    const run = (code) => window.webContents.executeJavaScript(code);
    const tick = () => run('new Promise(resolve => setTimeout(resolve, 100))');
    const snap = () => run('viewSmoke.snapshot()');
    const call = async (method, ...args) => { await run(`viewSmoke.${method}(${args.map((arg) => JSON.stringify(arg)).join(',')})`); await tick(); };
    const click = async (label) => {
      if (['Transcript', 'Atlas', 'Research', 'Code', 'Flow'].includes(label)) {
        await call('click', `Chat view: ${(await snap()).mode}`);
      }
      await call('click', label);
    };
    const capture = async (name) => fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
    const key = async (keyCode) => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      if (keyCode === 'Return' || keyCode === 'Space') window.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? '\r' : ' ' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await tick();
    };
    try {
      await window.loadFile(path.join(output, 'index.html')); await tick();
      let state = await snap();
      assert.equal(state.mode, 'Research'); assert.equal(state.headers.length, 6); assert.equal(state.researchRows.length, 6);
      assert.equal(state.modes.length, 0);
      window.webContents.focus(); await call('focus', 'Chat view: Research');
      await key('Down'); state = await snap();
      assert.deepEqual(state.modes.map((item) => item.label), ['Transcript', 'Atlas', 'Research', 'Code', 'Flow']);
      assert.equal(state.focus, 'Research');
      await key('End'); assert.equal((await snap()).mode, 'Research'); assert.equal((await snap()).focus, 'Flow');
      await key('Return'); assert.equal((await snap()).mode, 'Flow');
      await key('Down'); await key('Left'); await key('Return'); assert.equal((await snap()).mode, 'Code');
      await key('Down'); await key('Home'); await key('Return'); assert.equal((await snap()).mode, 'Transcript'); assert.equal((await snap()).conversationCard, true);
      await key('Down'); await key('Right'); await key('Return'); assert.equal((await snap()).mode, 'Atlas'); assert.equal((await snap()).conversationCard, false);
      await key('Down'); await key('Right'); await key('Return'); assert.equal((await snap()).mode, 'Research');
      assert.equal((await snap()).focus, 'Chat view: Research');

      await call('select', 'Filter research by role', 'assistant');
      state = await snap(); assert.equal(state.researchRows.length, 3);
      await click('Sort by First token'); await click('Sort by First token');
      state = await snap(); assert.equal(state.direction, 'descending');
      assert.match(state.researchRows[0].label, /turn 2/); assert.match(state.researchRows[1].label, /turn 4/);
      assert.equal(state.researchRows[1].cells[2], '—');
      await click('Show detailed metrics'); assert.equal((await snap()).headers.length, 14);
      await click('Sort by Words'); await click('Show detailed metrics');
      assert.equal((await snap()).sorted, '#');
      await call('input', 'Search research turns', 'Historical');
      state = await snap(); assert.equal(state.researchRows.length, 1); assert.match(state.researchRows[0].label, /turn 4/);
      await click('Copy filtered rows as TSV');
      state = await snap(); const rows = state.clipboard.split('\n').map((line) => line.split('\t'));
      assert.equal(rows.length, 2); assert.ok(rows.every((row) => row.length === 16)); assert.equal(rows[1][0], '4'); assert.equal(rows[1][5], ''); assert.equal(rows[1][6], '');
      await call('input', 'Search research turns', 'no-match-for-this-query'); assert.match((await snap()).text, /No matching turns/);
      await click('Clear filters');
      await call('focus', 'Expand turn 2 from Ada'); await key('Return');
      assert.deepEqual((await snap()).expanded, ['Collapse turn 2 from Ada']);
      await key('Space'); assert.deepEqual((await snap()).expanded, []);
      await capture('research-dark.png');

      await click('Code'); state = await snap();
      assert.equal(state.snippets.length, 4); assert.equal(state.codeCopyButtons, 1); assert.match(state.snippetCode, /    return tokenize/);
      await call('snippet', 0, true); await key('Down'); state = await snap(); assert.match(state.snippetCode, /export const parse/);
      await key('End'); state = await snap(); assert.match(state.snippetCode, /const cases/);
      await call('append', '\nconst count = cases.length;'); state = await snap(); assert.match(state.snippetCode, /const count/); assert.match(state.snippetHeading, /Turn 6/);
      await key('Home'); const oldSnippet = (await snap()).snippetCode;
      await call('append', '\nconsole.log(count);\n```\n\n```ny\nfn extra() {}\n```');
      state = await snap(); assert.equal(state.snippetCode, oldSnippet); assert.equal(state.snippets.length, 5);
      await call('select', 'Filter code by language', 'python'); state = await snap(); assert.equal(state.snippets.length, 1); assert.match(state.snippetCode, /imported example/);
      await call('select', 'Filter code by language', 'all'); assert.equal((await snap()).snippetCode, oldSnippet);
      await click('Copy code'); assert.equal((await snap()).clipboard, oldSnippet);
      await call('input', 'Search code snippets', 'workstation'); assert.equal((await snap()).snippets.length, 4);
      await call('input', 'Search code snippets', 'cannot-match-anything'); assert.match((await snap()).text, /No matching snippets/);
      await click('Clear filters'); await capture('code-dark.png');

      await click('Flow'); state = await snap();
      assert.equal(state.approvalGroups, 1); assert.equal(state.allowButtons, 1);
      assert.deepEqual(state.flowLanes.filter((item) => item.articles).map((item) => [item.label, item.articles]), [['Flow Needs you', 1], ['Flow In progress', 1], ['Flow Needs review', 1], ['Flow Completed', 1]]);
      assert.match(state.flowContent, /Ada/); assert.doesNotMatch(state.flowContent, /Allow|Approval needed/);
      await capture('flow-dark.png');
      await run(`document.querySelector('[aria-label="Filter flow actions"]').querySelectorAll('button')[1].click()`); await tick();
      assert.equal((await snap()).flowLanes.filter((item) => item.articles).length, 1);
      await run(`document.querySelector('[aria-label="Filter flow actions"]').querySelectorAll('button')[0].click()`); await tick();
      await call('select', 'Flow reply', 'a1');
      const historyContent = (await snap()).flowContent;
      await call('append', '\nLatest live progress.'); state = await snap();
      assert.equal(state.flowReply, 'a1'); assert.equal(state.flowContent, historyContent); assert.equal(state.approvalGroups, 0);
      assert.match(state.text, /live reply needs your attention/);
      await call('select', 'Flow reply', 'a2'); state = await snap();
      assert.equal(state.approvalGroups, 0); assert.equal(state.allowButtons, 0); assert.match(state.text, /Interrupted/);
      await call('select', 'Flow reply', '');
      await call('withAgent'); await call('openAgent', true); await key('Return');
      state = await snap(); assert.equal(state.mode, 'Flow'); assert.equal(state.conversationCard, false);
      assert.match(state.agentSheet.text, /Checking empty input/); assert.equal(state.approvalGroups, 1);
      await call('guidance', 'Also check unmatched brackets.'); await click('Send guidance to agent');
      assert.ok((await snap()).effects.some((effect) => effect[0] === 'guidance' && effect[1] === 'parser-check' && effect[2] === 'Also check unmatched brackets.'));
      assert.match((await snap()).agentSheet.text, /Guidance sent/); await capture('subagent-flow-dark.png');
      await click('Back to the conversation panel'); assert.equal((await snap()).agentSheet, null); assert.equal((await snap()).mode, 'Flow');
      await click('Research'); await click('Expand turn 6 from Ada'); await call('openAgent');
      assert.ok((await snap()).agentSheet); assert.equal((await snap()).mode, 'Research');
      await click('Back to the conversation panel');
      await click('Atlas'); await call('openAgent'); assert.ok((await snap()).agentSheet); assert.equal((await snap()).mode, 'Atlas');
      await click('Code'); assert.ok((await snap()).agentSheet); assert.equal((await snap()).mode, 'Code');
      await click('Back to the conversation panel'); assert.equal((await snap()).conversationCard, false);
      await click('Flow');
      await click('Allow'); state = await snap(); assert.deepEqual(state.effects.filter((effect) => effect[0] === 'approve'), [['approve', 'live-approval', true]]); assert.equal(state.allowButtons, 0);

      await call('appearance', { theme: 'light', accent: '#176f83', secondaryAccent: '#965fb5' });
      await click('Code'); state = await snap(); assert.ok(state.accents.selected.includes(state.accents.accent.split(/\s+/).join(', ')), 'selection uses the contrast-adjusted accent token');
      await capture('code-light.png');
      window.setContentSize(390, 844); await tick(); state = await snap(); assert.equal(state.snippetLayout, 'column'); assert.equal(state.bodyOverflow, false);
      await capture('code-narrow-light.png');
      await click('Research'); state = await snap(); assert.equal(state.bodyOverflow, false); assert.equal(state.headers.length, 6);
      await capture('research-narrow-light.png');
      await click('Flow'); assert.equal((await snap()).bodyOverflow, false); await capture('flow-narrow-light.png');
      await call('openAgent'); state = await snap();
      assert.equal(state.mode, 'Flow'); assert.equal(state.agentSheet.clipped, false); assert.ok(state.agentSheet.left >= 0 && state.agentSheet.right <= state.viewport[0]);
      assert.ok(state.agentSheet.top >= 0 && state.agentSheet.bottom <= state.viewport[1]);
      assert.equal(state.approvalGroups, 1); await capture('subagent-narrow-light.png');
      await click('Stop Boundary reviewer'); state = await snap(); assert.match(state.agentSheet.text, /Cancelled/);
      assert.equal(state.effects.filter((effect) => effect[0] === 'cancel-agent').length, 1);
      await call('focus', 'Back to the conversation panel'); await key('Return');
      assert.equal((await snap()).agentSheet, null); assert.equal((await snap()).mode, 'Flow');
      await call('empty'); assert.match((await snap()).text, /A place to follow the work/);
      await click('Code'); assert.match((await snap()).text, /No code yet/);
      await click('Research'); assert.match((await snap()).text, /No turns to compare yet/);
      assert.deepEqual(errors, []);
      console.log('Conversation views smoke passed: keyboard switcher; Research filtering, nulls, sorting, detail columns, expansion and complete TSV; Code filtering, copy, keyboard and stable streaming/history selection; Flow lanes, history and single approval controls; subagent open/guidance/cancel/close across views; light/dark accent, narrow panes and empty states.');
      window.destroy(); app.exit(0);
    } catch (error) {
      console.error(error, errors); console.error(await snap()); await capture('failure.png'); window.destroy(); app.exit(1);
    }
  }).catch((error) => { console.error(error); app.exit(1); });
}
