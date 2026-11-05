#!/usr/bin/env node
/** Review-panel UI and race tests in an isolated renderer with mock IPC only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '..');
const strictSmoke = process.argv.includes('--strict');
if (!process.versions.electron) {
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-code-review-'));
  await build({ absWorkingDir: root, entryPoints: ['test/fixtures/code-review-panel.tsx'], outfile: path.join(output, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': JSON.stringify(strictSmoke ? 'development' : 'production') }, loader: { '.woff2': 'file', '.ttf': 'file' } });
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\'; img-src data:; connect-src \'none\'"><link rel="stylesheet" href="fixture.css"><style>body{margin:0}button,input,textarea,select{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>');
  console.log(`Code Review smoke output: ${output}`);
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--ozone-override-screen-size=1440,1000', filename, '--fixture', output, ...(strictSmoke ? ['--strict'] : [])], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; console.error('Code Review smoke timed out.'); child.kill(); process.exitCode = 1; }, 45000);
  child.on('error', (error) => { console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = timedOut ? 1 : code ?? 1; });
} else {
  const { app, BrowserWindow, session } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data'));
  app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
  const isolated = session.fromPartition(`code-review-${process.pid}`);
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
  const window = new BrowserWindow({ show: false, width: 1000, height: 760, enableLargerThanScreen: true, webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true } });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const run = (code) => window.webContents.executeJavaScript(code);
  const tick = () => run('new Promise(resolve => setTimeout(resolve, 100))');
  const click = async (label) => { await run(`(() => { const label = ${JSON.stringify(label)}; const button = [...document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label || item.textContent.trim() === label); if (!button || button.disabled) throw Error('Missing control: ' + label); button.click(); })()`); await tick(); };
  const change = async (label, value) => { await run(`(() => { const field = document.querySelector('[aria-label=${JSON.stringify(label)}]'); if (!field) throw Error('Missing field: ' + ${JSON.stringify(label)}); const proto = field.tagName === 'SELECT' ? HTMLSelectElement.prototype : field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, ${JSON.stringify(value)}); field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`); await tick(); };
  const text = () => run('document.body.innerText');
  const shot = async (name) => fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
  const replyLabel = 'Reply to A stale reconnect can replace the active transport';
  try {
    await window.loadFile(path.join(output, 'index.html'), strictSmoke ? { query: { strict: 'true' } } : {}); await tick();
    if (strictSmoke) {
      assert.match(await text(), /What are we reviewing/, 'selection queued before mount survives StrictMode development rendering');
      assert.deepEqual(await run('[...document.querySelectorAll(".cr-new input")].map(input => input.value)'), ['', 'src/initial-selection.ts', '8', '12']);
      await click('Back to reviews');
    }
    await change('Saved reviews', 'review-one');
    assert.match(await text(), /Reconnect without losing the conversation/);
    assert.equal(await run('document.querySelectorAll(".cr-code-line").length'), 200, 'bounded source rendering');
    await shot('review-dark-wide.png');
    await click('Ask agent to review');
    assert.equal(await run('reviewSmoke.metrics.prompts.length'), 1);
    assert.equal(await run('reviewSmoke.metrics.mutations.length'), 0, 'asking drafts only; no review writes or inference');
    assert.match(await run('reviewSmoke.metrics.prompts[0].prompt'), /read_code_review/);

    await change(replyLabel, 'Keep this unsent reply while the agent updates.');
    await run('reviewSmoke.update()'); await tick();
    assert.match(await text(), /new activity/);
    await click('Refresh');
    assert.equal(await run(`document.querySelector('[aria-label=${JSON.stringify(replyLabel)}]').value`), 'Keep this unsent reply while the agent updates.');
    await click('Closed1'); await click('Active2');
    assert.equal(await run(`document.querySelector('[aria-label=${JSON.stringify(replyLabel)}]').value`), 'Keep this unsent reply while the agent updates.', 'filter preserves reply');
    await change('Saved reviews', 'review-two'); await change('Saved reviews', 'review-one');
    assert.equal(await run(`document.querySelector('[aria-label=${JSON.stringify(replyLabel)}]').value`), 'Keep this unsent reply while the agent updates.', 'review switch preserves reply');
    await run('reviewSmoke.conflict()'); await click('Reply');
    assert.match(await text(), /revision conflict/);
    assert.equal(await run(`document.querySelector('[aria-label=${JSON.stringify(replyLabel)}]').value`), 'Keep this unsent reply while the agent updates.');
    await click('Refresh'); await click('Reply');
    assert.equal(await run(`document.querySelector('[aria-label=${JSON.stringify(replyLabel)}]').value`), '');

    await click('src/connection.ts:231–232 · after');
    assert.ok(await run(`document.querySelector('[aria-label="Select line 231"]')?.getAttribute('aria-pressed') === 'true'`), 'far anchor navigates to the correct page');
    await click('Finding');
    await change('Finding title', 'Retain the selected range'); await change('Finding details', 'This finding should keep its original two-line anchor.');
    await click('Select line 233');
    await run('reviewSmoke.update()'); await tick(); await click('Refresh');
    assert.equal(await run(`document.querySelector('[aria-label="Finding title"]').value`), 'Retain the selected range');
    await run('document.querySelector(".cr-finding-composer").requestSubmit()'); await tick();
    assert.deepEqual(await run('reviewSmoke.metrics.mutations.at(-1).mutation.finding.anchor'), { path: 'src/connection.ts', side: 'after', startLine: 231, endLine: 232 });

    await click('Rename review'); await change('Review title', 'Reconnect review · ready to verify'); await click('Save review title');
    await change('Review decision', 'changes-requested'); await click('Record decision');
    assert.match(await text(), /Changes requested/);
    await change('Status of A stale reconnect can replace the active transport', 'resolved');
    await click('All4');
    assert.match(await text(), /Resolved/);
    await run('reviewSmoke.freshness()'); await click('Refresh reviews and freshness');
    assert.match(await text(), /changed or cannot be checked/);
    await shot('review-dark-freshness.png');
    await window.setSize(400, 780); await run('reviewSmoke.theme(true)'); await tick();
    assert.ok(await run('document.documentElement.scrollWidth <= innerWidth'), 'narrow panel fits horizontally');
    await shot('review-light-narrow.png');
    await click('Snapshot'); await shot('review-light-narrow-source.png');
    await click('Review updated code');
    assert.equal(await run('reviewSmoke.metrics.creates.length'), 1);
    assert.equal(await run('reviewSmoke.data().find(r => r.id === "review-one").findings.length'), 4, 'recapture retains original discussion');

    await run('reviewSmoke.select({workspace:"/fixture/other",path:"src/selected.ts",startLine:8,endLine:12})'); await tick();
    assert.match(await text(), /editor’s workspace/);
    await click('Capture review');
    assert.equal(await run('reviewSmoke.metrics.creates.at(-1).workspace'), '/fixture/other');
    assert.equal(await run('reviewSmoke.metrics.creates.at(-1).input.conversationId'), undefined, 'editor workspace does not inherit unrelated chat');
    await click('Ask agent to review');
    assert.equal(await run('reviewSmoke.metrics.prompts.at(-1).workspace'), '/fixture/other');
    await run('reviewSmoke.conversation("chat-two")'); await tick();
    assert.doesNotMatch(await text(), /What are we reviewing/, 'selection is consumed once');
    await click('Use chat workspace'); await change('Saved reviews', 'review-one');
    await run('reviewSmoke.holdRead()');
    await change('Saved reviews', 'review-two');
    await change('Saved reviews', 'review-one');
    await run('reviewSmoke.releaseRead()'); await tick();
    assert.match(await text(), /Reconnect review · ready to verify/);
    assert.doesNotMatch(await run('document.querySelector(".cr-title-row")?.textContent'), /Connection cleanup/, 'late read cannot overwrite selection');
    await run('reviewSmoke.holdMutation()'); await click('Rename review'); await change('Review title', 'Late write');
    await run('document.querySelector(".cr-rename").requestSubmit()'); await tick();
    await run('reviewSmoke.workspace("/fixture/new-session"); reviewSmoke.releaseMutation()'); await tick();
    assert.doesNotMatch(await text(), /Late write/, 'late write cannot enter a different workspace');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks: ['draft-only agent prompt', '200-line source pages', 'anchor pagination', 'frozen finding anchors', 'revision conflict', 'draft retention on remote update/filter/review switch', 'rename and decisions', 'freshness and recapture', 'editor workspace binding', 'single-use selections', 'late reads and writes', 'narrow/light/accent rendering'] }, null, 2));
    console.log('Code Review smoke passed: actual panel interactions, conflicts/drafts, anchors, workspace races, and dark/light/narrow visuals. Mock IPC only.');
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error, errors); await shot('failure.png'); window.destroy(); app.exit(1); }
  }).catch((error) => { console.error(error); app.exit(1); });
}
