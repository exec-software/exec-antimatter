#!/usr/bin/env node
/** Native PTY smoke using Electron's ABI. No app window, sudo, network, or real credentials. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const filename = fileURLToPath(import.meta.url);
if (!process.versions.electron) {
  const { build } = await import('esbuild');
  const { default: electron } = await import('electron');
  const require = createRequire(import.meta.url);
  const root = path.resolve(path.dirname(filename), '..');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-terminal-native-'));
  await build({
    entryPoints: [path.join(root, 'test/fixtures/terminal-backend.ts')], outfile: path.join(output, 'fixture.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
    plugins: [{ name: 'native-pty', setup(builder) {
      builder.onResolve({ filter: /^node-pty$/ }, () => ({ path: require.resolve('node-pty'), external: true }));
    } }],
  });
  console.log(`Terminal native smoke output: ${output}`);
  const child = spawn(electron, ['--ozone-platform=headless', filename, '--fixture', output], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const deadline = setTimeout(() => {
    console.error('Native terminal smoke timed out; stopping only the isolated fixture.');
    child.kill(); process.exitCode = 1;
  }, 30_000);
  child.on('error', (error) => { clearTimeout(deadline); console.error(error); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(deadline); process.exitCode = code ?? 1; });
} else {
  const { app } = await import('electron');
  const output = process.argv[process.argv.indexOf('--fixture') + 1];
  app.setPath('userData', path.join(output, 'user-data'));
  app.commandLine.appendSwitch('disable-gpu');
  app.whenReady().then(async () => {
    const { run } = await import(pathToFileURL(path.join(output, 'fixture.cjs')).href);
    await run(output);
    console.log('Native terminal smoke passed: real Electron node-pty output, exact-once command execution, direct synthetic stdin withheld from model result, cancellation of Bash and child process. No sudo or real secrets.');
    app.exit(0);
  }).catch((error) => { console.error(error); app.exit(1); });
}
