import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

export const RELEASE_DEPENDENCY_INSTALL_ARGS = Object.freeze([
  'ci', '--include=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund',
]);
export const RELEASE_DEPENDENCY_INSTALL = `npm ${RELEASE_DEPENDENCY_INSTALL_ARGS.join(' ')}; explicit Electron/esbuild setup and Vite patch; native compilation only in the bounded release container`;

// Review additions before allowing a changed lockfile into the release path. These
// hooks stay disabled: the root compiles node-pty, node-pty may call node-gyp,
// fsevents is macOS-only, and electron-winstaller selects Windows packaging tools.
const REVIEWED_LIFECYCLE_PACKAGES = new Set([
  '', 'node_modules/node-pty', 'node_modules/fsevents', 'node_modules/electron-winstaller',
  'node_modules/esbuild', 'node_modules/vite/node_modules/esbuild',
]);
const ESBUILD_PACKAGES = ['node_modules/esbuild', 'node_modules/vite/node_modules/esbuild'];
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const regular = (file) => {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing regular release setup input: ${file}`);
};

function lockedPackage(root, lock, directory, name) {
  const relative = path.relative(root, directory).split(path.sep).join('/');
  const pin = lock.packages?.[relative];
  regular(path.join(directory, 'package.json'));
  const installed = readJson(path.join(directory, 'package.json'));
  if (installed.name !== name || installed.version !== pin?.version || !/^sha512-/.test(pin?.integrity ?? '')) {
    throw new Error(`Release setup package does not match its npm lockfile: ${relative}`);
  }
  return installed;
}

/** Install pinned sources without lifecycle compilers, then run only reviewed setup scripts. */
export function installReleaseDependencies(root, { env = process.env, runCommand = execFileSync } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || env.ANTIMATTER_ISOLATED_RELEASE !== '1') {
    throw new Error('Release dependency setup requires the isolated Linux x86_64 release checkout');
  }
  const lock = readJson(path.join(root, 'package-lock.json'));
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (entry.hasInstallScript && !REVIEWED_LIFECYCLE_PACKAGES.has(name)) {
      throw new Error(`Unreviewed dependency lifecycle script in release lockfile: ${name}`);
    }
  }
  const environment = { ...env };
  // Always use the locked platform packages and Electron's own checksum inventory.
  for (const key of ['ESBUILD_BINARY_PATH', 'ELECTRON_OVERRIDE_DIST_PATH', 'ELECTRON_INSTALL_PLATFORM',
    'ELECTRON_INSTALL_ARCH', 'electron_use_remote_checksums', 'npm_config_electron_use_remote_checksums',
    'npm_config_platform', 'npm_config_arch']) delete environment[key];
  const run = (command, args) => runCommand(command, args, { cwd: root, env: environment, stdio: 'inherit' });
  run('npm', [...RELEASE_DEPENDENCY_INSTALL_ARGS]);

  const electron = path.join(root, 'node_modules/electron');
  lockedPackage(root, lock, electron, 'electron');
  regular(path.join(electron, 'install.js'));
  const scripts = [path.join(electron, 'install.js')];
  for (const relative of ESBUILD_PACKAGES) {
    const directory = path.join(root, relative);
    const installed = lockedPackage(root, lock, directory, 'esbuild');
    const require = createRequire(path.join(directory, 'package.json'));
    const binaryPackage = require.resolve('@esbuild/linux-x64/package.json');
    const binary = lockedPackage(root, lock, path.dirname(binaryPackage), '@esbuild/linux-x64');
    if (binary.version !== installed.version) throw new Error(`Release esbuild platform binary version differs: ${relative}`);
    // An existing locked platform binary prevents esbuild's installer from falling
    // back to a separate npm install/download outside this lockfile.
    regular(path.join(path.dirname(binaryPackage), 'bin/esbuild'));
    regular(path.join(directory, 'install.js'));
    scripts.push(path.join(directory, 'install.js'));
  }
  scripts.push(path.join(root, 'scripts/patch-vite-commonjs.mjs'));
  for (const script of scripts) regular(script);
  for (const script of scripts) run(process.execPath, [script]);
}
