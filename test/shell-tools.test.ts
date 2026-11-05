import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cleanChildEnv } from '../mcp/child-env';
import { desktopTools, openerCommand } from '../mcp/tools/desktop';
import { shellTools } from '../mcp/tools/shell';

test('child environment removes Electron node-mode markers but preserves desktop state', () => {
  assert.deepEqual(
    cleanChildEnv({
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_OVERRIDE_DIST_PATH: '/wrong',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      PATH: '/bin',
    }),
    { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', PATH: '/bin' }
  );
});

test('run_command uses Bash rather than a generic sh', async (t) => {
  if (process.platform === 'win32') return t.skip('Bash contract is specific to Unix builds.');
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-shell-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const result = await shellTools[0].run(
    { command: '[[ "antimatter" == a* ]] && echo bash-ok' },
    { workspace }
  );
  assert.match(result, /\[exit\] 0/);
  assert.match(result, /bash-ok/);
});

test('desktop opener keeps paths with spaces as one argument', () => {
  assert.deepEqual(openerCommand('/tmp/a document.txt', 'linux'), {
    command: 'xdg-open',
    args: ['/tmp/a document.txt'],
  });
});

test('Windows desktop opener never reparses filename metacharacters through cmd.exe', () => {
  assert.deepEqual(openerCommand('C:\\work\\report & notes.txt', 'win32'), {
    command: 'explorer.exe',
    args: ['C:\\work\\report & notes.txt'],
  });
});

const launchProgram = shellTools.find((tool) => tool.name === 'launch_program')!;

const pidOf = (report: string): number => Number(/\[running\] pid (\d+)/.exec(report)?.[1]);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a program that stays up is reported running, keeps running, and says how to stop it', async (t) => {
  if (process.platform === 'win32') return t.skip('Process groups are specific to Unix builds.');
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-launch-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const started = Date.now();
  const report = await launchProgram.run({ command: 'echo window is up; exec sleep 30', watch_ms: 400 }, { workspace });
  const pid = pidOf(report);
  t.after(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already stopped by the test.
    }
  });

  // It returns after watching, not after the program ends: the point of the tool.
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
  assert.match(report, /\[running\] pid \d+, still running after 0\.\d s/);
  assert.match(report, new RegExp(`\\[stop\\] kill -- -${pid}`));
  assert.match(report, /--- output \(\d+ bytes\) ---\nwindow is up/);
  assert.ok(alive(pid), 'the program must outlive the call');

  process.kill(-pid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(alive(pid), false, 'the printed stop command must stop it');
});

test('a program that dies on start is reported with its exit code and what it printed', async (t) => {
  if (process.platform === 'win32') return t.skip('Bash contract is specific to Unix builds.');
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-launch-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const started = Date.now();
  const report = await launchProgram.run(
    { command: 'echo "ImportError: cannot import name ImageTk" >&2; exit 3', watch_ms: 10_000 },
    { workspace }
  );
  // An early exit ends the watch at once rather than waiting out the full ten seconds.
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
  assert.match(report, /\[exited\] it exited with code 3 after \d+\.\d s, so it is not running\./);
  assert.match(report, /ImportError: cannot import name ImageTk/);
  assert.doesNotMatch(report, /\[stop\]/);
});

test('a long log is cut to its end, where the failure usually is', async (t) => {
  if (process.platform === 'win32') return t.skip('Bash contract is specific to Unix builds.');
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-launch-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const report = await launchProgram.run(
    { command: 'for i in $(seq 1 5000); do echo "line $i"; done; echo "the last line"; exit 1', watch_ms: 5_000 },
    { workspace }
  );
  assert.match(report, /earlier bytes are in the log/);
  assert.match(report, /the last line/);
  assert.doesNotMatch(report, /line 1\n/);
});

test('cancelling a launch stops the program it started', async (t) => {
  if (process.platform === 'win32') return t.skip('Process groups are specific to Unix builds.');
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-launch-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const pidFile = join(workspace, 'pid');
  const controller = new AbortController();
  const running = launchProgram.run(
    { command: `echo $$ > ${pidFile}; exec sleep 30`, watch_ms: 10_000 },
    { workspace, signal: controller.signal }
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();
  const report = await running;

  assert.match(report, /\[not running\] the call was cancelled, so the program was stopped/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(alive(pid), false);
});

test('launch_program stays inside the workspace', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-launch-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  await assert.rejects(launchProgram.run({ command: 'true', cwd: '../..' }, { workspace }));
});

test('run_command adds the way out to a refused install', async (t) => {
  if (process.platform === 'win32') return t.skip('Bash contract is specific to Unix builds.');
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-shell-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const run = shellTools.find((tool) => tool.name === 'run_command')!;
  const result = await run.run({ command: 'echo "error: externally-managed-environment" >&2; exit 1' }, { workspace });
  assert.match(result, /\[exit\] 1/);
  assert.match(result, /\n\[note\] pip will not install into this Python: it belongs to the operating system\./);
});

test('run_command says a command ran out of time, and what to use instead', async (t) => {
  if (process.platform === 'win32') return t.skip('Bash contract is specific to Unix builds.');
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-shell-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const run = shellTools.find((tool) => tool.name === 'run_command')!;
  const result = await run.run({ command: 'echo started; sleep 5', timeout_ms: 300 }, { workspace });
  assert.match(result, /\[exit\] killed by SIGKILL/);
  assert.match(result, /started/);
  assert.match(result, /\[timeout\] It was still running after 0\.3 s, so it was killed\. .*launch_program/);
  assert.doesNotMatch(result, /output truncated/);
});

const openPath = desktopTools.find((tool) => tool.name === 'open_path')!;

test('open_path refuses a web page and names the tool that shows it in the app', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'antimatter-openpath-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'index.html'), '<h1>built</h1>');
  writeFileSync(join(workspace, 'notes.txt'), 'plain');

  // The system default for a page is a browser, so this used to put the user's own work in a
  // window outside the app, which the model then could not screenshot or reason about.
  await assert.rejects(
    () => openPath.run({ path: 'index.html' }, { workspace }),
    /preview_url/,
    'refusing is not enough; it has to say which tool does show a page'
  );
  for (const name of ['page.HTML', 'page.htm', 'page.xhtml']) {
    writeFileSync(join(workspace, name), '<p>x</p>');
    await assert.rejects(() => openPath.run({ path: name }, { workspace }), /web page/);
  }

  // A missing file still reports that, rather than the web-page advice.
  await assert.rejects(() => openPath.run({ path: 'nope.html' }, { workspace }), /No file or directory exists/);
  // And the description steers before the guard ever has to fire.
  assert.match(openPath.description, /preview_url/);
});
