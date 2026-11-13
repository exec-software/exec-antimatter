import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SDK_SOURCES = ['README.md', 'CMakeLists.txt', 'antimatter_features.c', 'antimatter_features.h', 'antimatter_features.matrix'];
const SDK_EXPORTS = ['antimatter_feature_get', 'antimatter_feature_declare', 'antimatter_feature_set', 'antimatter_features_list'];
const DOOM_REQUIRED = ['chocolate-doom.js', 'chocolate-doom.wasm', 'chocolate-doom.data', 'corresponding-source.tar.gz', 'CHOCOLATE-DOOM-GPL-2.0.md', 'EMSCRIPTEN-LICENSE.txt', 'SDL2-LICENSE.txt', 'FREEDOOM-COPYING.txt', 'CREDITS.txt', 'CREDITS-MUSIC.txt', 'THIRD_PARTY_NOTICES.md'];

function readRegular(file, maximum = 64 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > maximum) {
    throw new Error(`Resource must be a bounded regular file: ${file}`);
  }
  return fs.readFileSync(file);
}
function directory(file) {
  if (!fs.lstatSync(file).isDirectory()) {
    throw new Error(`Resource directory must not be a symlink: ${file}`);
  }
}
function exactFiles(directoryPath, expected) {
  directory(directoryPath);
  const actual = fs.readdirSync(directoryPath).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Resource inventory differs from the release contract: ${directoryPath}`);
  }
}
function writeRegular(file, bytes) {
  fs.writeFileSync(file, bytes, { mode: 0o644, flag: 'wx' });
}

export function readDoomLock(root) {
  const lock = JSON.parse(readRegular(path.join(root, 'scripts/doom-runtime.lock.json'), 32768).toString());
  if (lock.version !== 1 || !/^[a-f0-9]{40}$/.test(lock.revision) || !Array.isArray(lock.assets) ||
      JSON.stringify(lock.assets.map((asset) => asset.name).sort()) !== JSON.stringify([...DOOM_REQUIRED].sort())) {
    throw new Error('Doom lock must include the complete engine, game data, corresponding source and notices.');
  }
  for (const asset of lock.assets) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 64 * 1024 * 1024 ||
        typeof asset.url !== 'string' || !asset.url.startsWith('https://') || !asset.url.includes(lock.revision)) {
      throw new Error(`Invalid pinned Doom artifact: ${asset.name}`);
    }
  }
  return lock;
}

export function verifyDoomResources(root, runtime) {
  const lock = readDoomLock(root);
  exactFiles(runtime, [...lock.assets.map((asset) => asset.name), 'runtime-manifest.json']);
  const manifest = JSON.parse(readRegular(path.join(runtime, 'runtime-manifest.json'), 32768).toString());
  if (JSON.stringify(manifest) !== JSON.stringify(lock)) {
    throw new Error('Doom runtime manifest differs from the tracked lock.');
  }
  for (const asset of lock.assets) {
    const bytes = readRegular(path.join(runtime, asset.name));
    if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256) {
      throw new Error(`Doom runtime checksum mismatch: ${asset.name}`);
    }
  }
  return lock;
}

export function copyDoomResources(root, runtime, destination) {
  const lock = verifyDoomResources(root, runtime);
  fs.mkdirSync(destination, { recursive: true });
  for (const name of [...lock.assets.map((asset) => asset.name), 'runtime-manifest.json']) {
    writeRegular(path.join(destination, name), readRegular(path.join(runtime, name)));
  }
  verifyDoomResources(root, destination);
  return lock;
}

function sdkInputs(root) {
  return [...SDK_SOURCES.map((name) => [name, readRegular(path.join(root, 'sdk/features', name), 1024 * 1024)]), ['LICENSE', readRegular(path.join(root, 'LICENSE'), 32768)]];
}
function libraryName(platform) {
  return platform === 'linux' ? 'libantimatter_features.so' : platform === 'darwin' ? 'libantimatter_features.dylib' : null;
}

/** Build the tiny C transport for the target host; sources remain usable on every platform. */
export function buildFeatureSdk(root, destination, { platform = process.platform, arch = process.arch, compiler = process.env.CC || 'cc' } = {}) {
  const library = libraryName(platform);
  if (library && (platform !== process.platform || arch !== process.arch)) {
    throw new Error('Feature SDK native packaging requires a matching target host; cross-compilation is not silently substituted.');
  }
  fs.mkdirSync(destination, { recursive: true });
  const inputs = sdkInputs(root);
  for (const [name, bytes] of inputs) {
    writeRegular(path.join(destination, name), bytes);
  }
  let compilerVersion = null;
  if (library) {
    const flags = platform === 'darwin' ? ['-dynamiclib', '-Wl,-install_name,@rpath/libantimatter_features.dylib'] : ['-shared', '-Wl,-soname,libantimatter_features.so'];
    execFileSync(compiler, ['-std=c11', '-O2', '-fPIC', '-Wall', '-Wextra', '-Werror', ...flags, '-o', path.join(destination, library), 'antimatter_features.c'], {
      cwd: path.join(root, 'sdk/features'), stdio: 'pipe', timeout: 60000, maxBuffer: 1024 * 1024,
    });
    compilerVersion = execFileSync(compiler, ['--version'], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 }).split('\n')[0];
    const symbols = execFileSync('nm', platform === 'darwin' ? ['-gU', path.join(destination, library)] : ['-D', '--defined-only', path.join(destination, library)], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    for (const symbol of SDK_EXPORTS) {
      if (!new RegExp(`\\b_?${symbol}\\s*$`, 'm').test(symbols)) {
        throw new Error(`Feature SDK library is missing ABI symbol ${symbol}`);
      }
    }
    fs.chmodSync(path.join(destination, library), 0o644);
  }
  const names = [...inputs.map(([name]) => name), ...(library ? [library] : [])].sort();
  const manifest = {
    schemaVersion: 1, abiVersion: 1, platform, arch, library, compiler: compilerVersion,
    files: names.map((name) => { const bytes = readRegular(path.join(destination, name)); return { name, bytes: bytes.length, sha256: hash(bytes) }; }),
  };
  writeRegular(path.join(destination, 'sdk-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return verifyFeatureSdk(root, destination, { platform, arch });
}

export function verifyFeatureSdk(root, directoryPath, { platform = process.platform, arch = process.arch } = {}) {
  const manifest = JSON.parse(readRegular(path.join(directoryPath, 'sdk-manifest.json'), 32768).toString());
  const inputs = sdkInputs(root);
  const library = libraryName(platform);
  const names = [...inputs.map(([name]) => name), ...(library ? [library] : [])].sort();
  if (manifest.schemaVersion !== 1 || manifest.abiVersion !== 1 || manifest.platform !== platform || manifest.arch !== arch || manifest.library !== library ||
      !Array.isArray(manifest.files) || JSON.stringify(manifest.files.map((file) => file.name).sort()) !== JSON.stringify(names)) {
    throw new Error('Feature SDK manifest does not describe this target and ABI.');
  }
  exactFiles(directoryPath, [...names, 'sdk-manifest.json']);
  for (const file of manifest.files) {
    const bytes = readRegular(path.join(directoryPath, file.name));
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) {
      throw new Error(`Feature SDK checksum mismatch: ${file.name}`);
    }
  }
  for (const [name, bytes] of inputs) {
    if (!readRegular(path.join(directoryPath, name)).equals(bytes)) {
      throw new Error(`Feature SDK differs from the released source: ${name}`);
    }
  }
  return manifest;
}
