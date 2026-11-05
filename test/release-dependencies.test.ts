import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { installReleaseDependencies, RELEASE_DEPENDENCY_INSTALL } from '../scripts/lib/release-dependencies.mjs';

const write = (file: string, value: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
};
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-release-dependencies-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trace = join(root, 'setup-trace.jsonl');
  const packages: Record<string, any> = { '': { hasInstallScript: true } };
  const hook = (name: string) => `require('node:fs').appendFileSync(${JSON.stringify(trace)}, ${JSON.stringify(JSON.stringify(name) + '\n')});`;
  const add = (relative: string, name: string, version: string, hasInstallScript = false) => {
    packages[relative] = { version, hasInstallScript, integrity: 'sha512-fixture-integrity' };
    write(join(root, relative, 'package.json'), JSON.stringify({ name, version }));
  };
  add('node_modules/electron', 'electron', '44.10.2');
  write(join(root, 'node_modules/electron/install.js'), hook('electron'));
  for (const [prefix, version] of [['node_modules', '0.28.2'], ['node_modules/vite/node_modules', '0.25.12']]) {
    add(`${prefix}/esbuild`, 'esbuild', version, true);
    add(`${prefix}/@esbuild/linux-x64`, '@esbuild/linux-x64', version);
    write(join(root, prefix, '@esbuild/linux-x64/bin/esbuild'), 'fixture prebuilt binary; never executed');
    write(join(root, prefix, 'esbuild/install.js'), hook(`${prefix}/esbuild`));
  }
  for (const name of ['node-pty', 'electron-winstaller', 'fsevents']) {
    add(`node_modules/${name}`, name, '1.0.0', true);
    write(join(root, `node_modules/${name}/install.js`), 'throw new Error("unreviewed native compiler was invoked");');
  }
  write(join(root, 'package.json'), JSON.stringify({ scripts: { postinstall: 'node forbidden-compiler.js' } }));
  write(join(root, 'forbidden-compiler.js'), 'throw new Error("root native compiler was invoked");');
  write(join(root, 'scripts/patch-vite-commonjs.mjs'), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(trace)}, ${JSON.stringify('"vite-patch"\n')});`);
  const save = () => write(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  save();
  const calls: { command: string; args: string[] }[] = [];
  const runCommand = (command: string, args: string[], options: any) => {
    calls.push({ command, args });
    if (command === 'npm') {
      assert.deepEqual(args, ['ci', '--include=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund']);
      return;
    }
    assert.equal(command, process.execPath);
    assert.equal(options.env.ESBUILD_BINARY_PATH, undefined);
    assert.equal(options.env.ELECTRON_OVERRIDE_DIST_PATH, undefined);
    execFileSync(command, args, options);
  };
  const env = { ...process.env, ANTIMATTER_ISOLATED_RELEASE: '1', ESBUILD_BINARY_PATH: '/unreviewed/esbuild', ELECTRON_OVERRIDE_DIST_PATH: '/unreviewed/electron' };
  return { root, trace, packages, save, calls, runCommand, env };
}

test('release installation disables every lifecycle compiler and runs only reviewed setup hooks', (t) => {
  const box = fixture(t);
  installReleaseDependencies(box.root, box);
  assert.deepEqual(readFileSync(box.trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
    ['electron', 'node_modules/esbuild', 'node_modules/vite/node_modules/esbuild', 'vite-patch']);
  assert.equal(box.calls.length, 5);
  assert.match(RELEASE_DEPENDENCY_INSTALL, /--ignore-scripts/);
});

test('unreviewed lockfile lifecycle packages fail before npm or setup runs', (t) => {
  const box = fixture(t);
  box.packages['node_modules/new-native-addon'] = { hasInstallScript: true };
  box.save();
  assert.throws(() => installReleaseDependencies(box.root, box), /Unreviewed dependency lifecycle/);
  assert.equal(box.calls.length, 0);
});

test('both esbuild platform binaries must be locked and present before any setup can download a fallback', (t) => {
  const box = fixture(t);
  rmSync(join(box.root, 'node_modules/vite/node_modules/@esbuild/linux-x64/bin/esbuild'));
  assert.throws(() => installReleaseDependencies(box.root, box), /Cannot find module|Missing regular/);
  assert.equal(box.calls.length, 1);
});

test('setup rejects installed package version drift and never continues after npm failure', (t) => {
  const box = fixture(t);
  box.packages['node_modules/electron'].version = '44.10.1';
  box.save();
  assert.throws(() => installReleaseDependencies(box.root, box), /does not match its npm lockfile/);
  assert.equal(box.calls.length, 1);
  assert.throws(() => installReleaseDependencies(box.root, { env: box.env, runCommand: () => { throw new Error('npm install failed'); } }), /npm install failed/);
});

test('the explicit setup path cannot be used outside the isolated release checkout', (t) => {
  const box = fixture(t);
  assert.throws(() => installReleaseDependencies(box.root, { ...box, env: {} }), /isolated Linux/);
  assert.equal(box.calls.length, 0);
});
