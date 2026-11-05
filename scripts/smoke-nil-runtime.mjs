#!/usr/bin/env node
/** Real Electron/node-pty smoke for NIL project run and Stop. No window, network, or model. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '..');
const require = createRequire(path.join(root, 'package.json'));
const argument = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const sdkPath = process.env.ANTIMATTER_NY_TEST_SDK;
if (!sdkPath) throw new Error('Set ANTIMATTER_NY_TEST_SDK to a current NIL Framework SDK.');
if (process.platform !== 'linux') throw new Error('This NIL project PTY smoke is qualified on Linux.');

if (!process.versions.electron) {
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  const output = argument('--output') ? path.resolve(argument('--output')) : await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-nil-runtime-'));
  await fs.mkdir(output, { recursive: true });
  const bundle = path.join(output, 'runtime.cjs');
  await build({
    absWorkingDir: root,
    stdin: { contents: [
      'export * as envExec from "./src/main/environment/exec";',
      'export { createNilProject, describeNilProject, nilProjectInvocation } from "./src/main/environment/nilProjects";',
      'export { resolveNyToolchain } from "./src/main/environment/ny";',
    ].join('\n'), resolveDir: root, sourcefile: 'nil-runtime-smoke-entry.ts', loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
    plugins: [{ name: 'actual-native-pty', setup(builder) {
      builder.onResolve({ filter: /^node-pty$/ }, () => ({ path: require.resolve('node-pty'), external: true }));
    } }],
  });
  console.log(`NIL runtime smoke output: ${output}`);
  const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', '--disable-gpu', filename,
    '--runtime', bundle, '--output', output, '--node', process.execPath],
  { cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  let timedOut = false; let forceKill;
  const deadline = setTimeout(() => {
    timedOut = true; console.error('NIL runtime smoke exceeded its 26-second process deadline.');
    child.kill('SIGTERM'); forceKill = setTimeout(() => child.kill('SIGKILL'), 3000);
  }, 26_000);
  try {
    const [code] = await once(child, 'close');
    process.exitCode = timedOut ? 1 : code ?? 1;
  } finally {
    clearTimeout(deadline); clearTimeout(forceKill);
    // Retire tracked fixture processes even if Electron failed before its finally block.
    const owned = new Set();
    try { for (const pid of JSON.parse(await fs.readFile(path.join(output, 'owned-pids.json'), 'utf8'))) owned.add(pid); } catch {}
    try { owned.add(Number(await fs.readFile(path.join(output, 'projects', 'Cancel PTY project', 'compiler-started'), 'utf8'))); } catch {}
    for (const pid of owned) if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
} else {
  const { app } = await import('electron');
  const output = argument('--output'); const node = argument('--node');
  assert.ok(output && node && argument('--runtime'), 'Launch this script through Node so it can bundle the real runtime.');
  app.setPath('userData', path.join(output, 'user-data'));
  app.disableHardwareAcceleration();
  const { envExec, createNilProject, describeNilProject, nilProjectInvocation, resolveNyToolchain } = require(argument('--runtime'));
  const deadline = Date.now() + 20_000;
  const waitFor = async (label, predicate, limit = 8000) => {
    const until = Math.min(deadline, Date.now() + limit);
    while (Date.now() < until) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${label}.`);
  };
  const alive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const records = new Map(); const timeline = []; const owned = new Set();
  const own = async pid => {
    assert.ok(Number.isSafeInteger(pid) && pid > 0); owned.add(pid);
    await fs.writeFile(path.join(output, 'owned-pids.json'), JSON.stringify([...owned]));
  };
  let compilerPid; let result = 1; let failure;
  envExec.connect({
    onData(id, data) { records.set(id, (records.get(id) ?? '') + data); timeline.push({ id, type: 'data', data }); },
    onExit(id, exit) { timeline.push({ id, type: 'exit', ...exit }); },
  });
  // Register the callback without blocking Electron's ESM bootstrap on readiness.
  app.whenReady().then(async () => {
  try {
    const projects = path.join(output, 'projects'); await fs.mkdir(projects);
    const project = createNilProject(projects, 'Matrix PTY project', 'matrix');
    const tools = resolveNyToolchain(project.root, { sdkPath }); assert.equal(tools.family, 'nil');
    const description = await describeNilProject(project.root, project.entry, { sdkPath }); assert.ok(description);
    const running = await envExec.start(nilProjectInvocation(description, tools, 'run')); await own(running.pid);
    await waitFor('Matrix greeting and exit', () => running.exit !== null);
    assert.equal(running.exit.code, 0, records.get(running.id));
    assert.match(records.get(running.id) ?? '', /Hello from Matrix/);
    let streamed = '';
    const greetingIndex = timeline.findIndex(item => {
      if (item.id !== running.id || item.type !== 'data') return false;
      streamed += item.data; return streamed.includes('Hello from Matrix');
    });
    const exitIndex = timeline.findIndex(item => item.id === running.id && item.type === 'exit');
    assert.ok(greetingIndex >= 0 && exitIndex > greetingIndex, 'PTY output reaches the run console before its exit event');
    await waitFor('completed runtime retirement', () => !alive(running.pid), 1000);

    // Keep the real nilbuild, but replace only its compiler with a bounded owned
    // idle fixture. The driver creates its separate child process group itself.
    const cancel = createNilProject(projects, 'Cancel PTY project', 'matrix');
    const fixture = path.join(output, 'cancel-sdk'); await fs.mkdir(fixture);
    for (const [name, executable] of [['nilbuild', tools.builder], ['nilinterpreter', tools.interpreter], ['nillsp', tools.lsp], ['nildebugger', tools.debugger]]) {
      assert.ok(executable); await fs.symlink(executable, path.join(fixture, name));
    }
    const compiler = path.join(fixture, 'nilcompiler'); const marker = path.join(cancel.root, 'compiler-started');
    await fs.writeFile(compiler, `#!${node}\nconst fs=require('node:fs');const path=require('node:path');\nprocess.on('SIGTERM',()=>{});\nfs.writeFileSync(path.join(process.cwd(),'compiler-started'),String(process.pid));\nsetInterval(()=>{},1000);\n`, { mode: 0o755 });
    const cancelTools = resolveNyToolchain(cancel.root, { sdkPath: fixture });
    const cancelDescription = await describeNilProject(cancel.root, cancel.entry, { sdkPath: fixture }); assert.ok(cancelDescription);
    const cancelled = await envExec.start(nilProjectInvocation(cancelDescription, cancelTools, 'run')); await own(cancelled.pid);
    await waitFor('real nilbuild compiler child', async () => {
      try { compilerPid = Number(await fs.readFile(marker, 'utf8')); return Number.isSafeInteger(compilerPid) && compilerPid > 0; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    await own(compilerPid); assert.equal(alive(compilerPid), true);
    const stoppedAt = Date.now(); envExec.stop();
    await waitFor('TERM-driven nilbuild cancellation', () => cancelled.exit !== null);
    assert.notEqual(cancelled.exit.code, 0, 'stopped checking must not become a successful run');
    assert.equal(alive(compilerPid), false, 'nilbuild must reap the separately grouped compiler before exiting');
    await waitFor('stopped driver retirement', () => !alive(cancelled.pid), 1000);
    const report = { passed: true, electron: process.versions.electron, sdkPath: tools.sdkPath,
      checks: ['actual Electron node-pty', 'Matrix nilbuild run output before exit', 'program exit 0', 'Stop forwards TERM', 'driver reaps compiler that ignores TERM'],
      stopDurationMs: Date.now() - stoppedAt, retiredPids: [...owned] };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('NIL runtime smoke passed: actual Electron PTY streams Matrix output and Stop retires the real driver and compiler child.');
    result = 0;
  } catch (error) {
    failure = error; console.error(error);
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error?.stack ?? error), timeline }, null, 2) + '\n');
  } finally {
    envExec.stop();
    // Emergency cleanup touches only PIDs created by this smoke, never ambient jobs.
    for (const pid of owned) {
      if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already retired */ } }
    }
    envExec.shutdown();
    await fs.writeFile(path.join(output, 'processes.json'), JSON.stringify({ ownedPids: [...owned], aliveAfterCleanup: [...owned].filter(pid => pid && alive(pid)), passed: !failure }, null, 2) + '\n');
    app.exit(result);
  }
  }).catch(error => { console.error(error); app.exit(1); });
}
