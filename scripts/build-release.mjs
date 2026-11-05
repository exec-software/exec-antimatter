#!/usr/bin/env node

/**
 * Assemble a Linux release from one clean, tested source revision.
 *
 * Generated binaries live under releases/dist and are intentionally not committed. The
 * source-controlled installer, model identity, defaults, and release notes live beside them.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { releaseChannel, rollingPackageVersion } from './lib/release-version.mjs';
import { createBackendInventory } from './lib/backend-inventory.mjs';
import { prepareAndroidReleaseInput } from './lib/android-release.mjs';
import { packageLinuxRelease } from './lib/native-release.mjs';
import { writeJavaScriptInventory } from './lib/javascript-inventory.mjs';
import { RELEASE_DEPENDENCY_INSTALL } from './lib/release-dependencies.mjs';
import { assertNoLocalBuildPaths, reviewedUpstreamFiles } from './lib/release-path-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASES = path.join(ROOT, 'releases');
const DIST = path.join(RELEASES, 'dist');
const LINUX_INPUTS = path.join(RELEASES, 'linux-x86_64');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const releaseVersion = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
if (rollingPackageVersion(releaseVersion) !== version || pkg.releaseVersion !== releaseVersion) {
  throw new Error('VERSION, package releaseVersion and compatibility version are out of sync');
}
const channel = releaseChannel(version);
const releaseTag = `v${version}`;
const platformName = 'linux-x86_64';
const appImageName = `Antimatter-${version}-${platformName}.AppImage`;
const appArchiveName = `Antimatter-${version}-${platformName}.tar.gz`;
const beholddArchiveName = `beholdd-${version}-${platformName}.tar.gz`;
const expectedPublishedAssets = [
  appImageName,
  appArchiveName,
  beholddArchiveName,
  'BEHOLDD_THIRD_PARTY_LICENSES.manifest.json',
  'BEHOLDD_THIRD_PARTY_LICENSES.txt',
  'BEHOLDD_HAG_THIRD_PARTY_LICENSES.manifest.json',
  'BEHOLDD_HAG_THIRD_PARTY_LICENSES.txt',
  'hag-model.json',
  'LICENSE-APACHE-2.0.txt',
  'LLAMA_CPP_LICENSE.txt',
  'JAVASCRIPT_SBOM.cdx.json',
  'JAVASCRIPT_LICENSES.manifest.json',
  'JAVASCRIPT_LICENSES.txt',
  'README.md',
  'RELEASE_NOTES.md',
  'SHA256SUMS',
  'THIRD_PARTY_NOTICES.md',
  'beholdd.streaming.yaml',
  'backend-inventory.json',
  'co.antimatter.app.svg',
  'install.sh',
  'model-manifest.json',
  'release-manifest.json',
  'uninstall.sh',
].sort();

const buildEnvironment = {
  ...process.env,
  // npm is commonly found elsewhere on PATH and starts with `#!/usr/bin/env node`. Keep every
  // npm lifecycle process on the runtime that passed the version check below instead of silently
  // falling back to an older system Node (Electron Builder's ESM dependencies require this).
  PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
  npm_config_devdir:
    process.env.npm_config_devdir ?? path.join(os.tmpdir(), 'antimatter-node-gyp'),
};
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: buildEnvironment,
    ...options,
  });
const capture = (command, args) =>
  execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', env: buildEnvironment }).trim();
const requireFile = (file, description = file) => {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Missing ${description}: ${file}`);
  }
};
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const copyFile = (from, to, mode) => {
  requireFile(from);
  fs.copyFileSync(from, to);
  if (mode) fs.chmodSync(to, mode);
};
const normalizeArchiveTree = (root) => {
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.chmodSync(current, 0o755);
      for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
      return;
    }
    if (!stat.isFile()) throw new Error(`archive staging contains a special file: ${current}`);
    fs.chmodSync(current, stat.mode & 0o111 ? 0o755 : 0o644);
  };
  visit(root);
};
const createNormalizedArchive = (sourceRoot, rootName, destination) => {
  normalizeArchiveTree(sourceRoot);
  const sourceDateEpoch = capture('git', ['show', '-s', '--format=%ct', 'HEAD']);
  run('tar', [
    '--sort=name',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    `--mtime=@${sourceDateEpoch}`,
    '--clamp-mtime',
    '-czf',
    destination,
    '-C',
    staging,
    rootName,
  ]);
  const listing = execFileSync('tar', ['--numeric-owner', '-tzvf', destination], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...buildEnvironment, LC_ALL: 'C' },
  });
  const entries = listing.trimEnd().split('\n').filter(Boolean);
  if (!entries.length) throw new Error(`normalized archive is empty: ${destination}`);
  for (const entry of entries) {
    const match = entry.match(/^([d-][rwx-]{9})\s+0\/0\s+/);
    if (!match) throw new Error(`archive entry lacks neutral ownership or has unsafe type: ${entry}`);
    if (!['drwxr-xr-x', '-rw-r--r--', '-rwxr-xr-x'].includes(match[1])) {
      throw new Error(`archive entry has a non-normalized mode: ${entry}`);
    }
  }
};
const walkFiles = (root) => {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(root);
  return files;
};
const versionParts = (value) => value.split('.').map(Number);
const compareVersions = (left, right) => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
};
const reserveLoopbackPort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
const stopChild = async (child) => {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
};

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(`Linux x86_64 release required; found ${process.platform}/${process.arch}`);
}
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const supportedNode =
  (nodeMajor === 22 && nodeMinor >= 20) ||
  (nodeMajor === 24 && nodeMinor >= 12) ||
  nodeMajor >= 25;
if (!supportedNode) {
  throw new Error(
    `Node.js 22.20+, 24.12+, or 25+ is required by the locked packaging toolchain; ` +
      `found ${process.versions.node}`
  );
}
if (!channel) {
  throw new Error(`Unsupported release version: ${version}`);
}
if (process.env.ANTIMATTER_ISOLATED_RELEASE !== '1') {
  throw new Error('Run npm run release:linux so assembly uses a clean, lockfile-installed worktree');
}

const dirty = capture('git', ['status', '--porcelain', '--untracked-files=all']);
if (dirty) {
  throw new Error(
    'Release builds require a clean worktree. Commit the release inputs first.\n' + dirty
  );
}

const commit = capture('git', ['rev-parse', 'HEAD']);
const builtAt = new Date().toISOString();

// Never mix assets from an earlier version into this release. DIST is a fixed child of the
// source-controlled releases directory; all durable release inputs live outside it.
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

console.log(`\n=== Antimatter ${releaseTag} (${commit.slice(0, 12)})`);
console.log('=== Verifying tracked release contract');
run(process.execPath, ['scripts/verify-release-inputs.mjs']);

console.log('=== Verifying vendored dependencies');
run(process.execPath, ['scripts/sync-deps.mjs', '--verify', 'beholdd', 'beholdd-hag', 'displacer']);
run(process.execPath, ['scripts/sync-llama-vulkan.mjs', '--verify']);

console.log('\n=== Running tests');
run('npm', ['test']);

console.log('\n=== Verifying Android package');
run('npm', ['run', 'android:verify']);

console.log('\n=== Building Linux package');
const nativeRelease = packageLinuxRelease(ROOT, run);
if (!['0', '1'].includes(process.env.ANTIMATTER_DESKTOP_ONLY ?? '0')) {
  throw new Error('Invalid Android distribution mode');
}
const androidRelease = prepareAndroidReleaseInput(ROOT, DIST, commit, {
  desktopOnly: process.env.ANTIMATTER_DESKTOP_ONLY === '1',
});

const appImage = path.join(DIST, appImageName);
const unpacked = path.join(DIST, 'linux-unpacked');
const appExecutable = path.join(unpacked, 'antimatter');
const embeddedBeholdd = path.join(unpacked, 'resources', 'vendor', 'beholdd', 'bin', 'beholdd');
const embeddedBeholddHag = path.join(unpacked, 'resources', 'vendor', 'beholdd-hag', 'bin', 'beholdd');
const embeddedLlamaVulkanRoot = path.join(unpacked, 'resources', 'vendor', 'llama-vulkan');
const embeddedLlamaVulkan = path.join(
  embeddedLlamaVulkanRoot,
  'runtime',
  'llama-server'
);
const embeddedLlamaVulkanLicense = path.join(
  embeddedLlamaVulkanRoot,
  'runtime',
  'LICENSE'
);
requireFile(appImage, 'AppImage');
requireFile(appExecutable, 'unpacked Antimatter executable');
requireFile(embeddedBeholdd, 'embedded Beholdd executable');
requireFile(embeddedBeholddHag, 'embedded experimental HAG executable');
requireFile(embeddedLlamaVulkan, 'embedded llama.cpp Vulkan server');
requireFile(embeddedLlamaVulkanLicense, 'embedded llama.cpp license');
const javaScriptInventory = writeJavaScriptInventory({ root: ROOT, payloadRoot: unpacked, outputDirectory: DIST });
if (
  !(fs.statSync(appExecutable).mode & 0o111) ||
  !(fs.statSync(embeddedBeholdd).mode & 0o111) ||
  !(fs.statSync(embeddedBeholddHag).mode & 0o111) ||
  !(fs.statSync(embeddedLlamaVulkan).mode & 0o111)
) {
  throw new Error('Packaged Antimatter, Beholdd, and llama.cpp executables must retain executable mode');
}

console.log('\n=== Smoke-testing packaged runtimes');
// Re-run the complete manifest, file inventory, tree hash, clean-environment version, and all-ELF
// dependency checks against what Electron Builder actually copied, not merely the source payload.
const backendInventory = createBackendInventory({
  repositoryRoot: ROOT,
  packagedVendorRoot: path.join(unpacked, 'resources', 'vendor'),
});
const backendInventoryPath = path.join(DIST, 'backend-inventory.json');
fs.writeFileSync(backendInventoryPath, `${JSON.stringify(backendInventory, null, 2)}\n`);
console.log(`  GPU device enumeration: ${backendInventory.buildHostDeviceProbe.status} (no model loaded)`);
const packagedEnvironment = { ...buildEnvironment, ELECTRON_RUN_AS_NODE: '1' };
const packagedMcp = path.join(
  unpacked,
  'resources',
  'app.asar.unpacked',
  'dist-electron',
  'mcp',
  'server.js'
);
requireFile(packagedMcp, 'packaged MCP server');
run(appExecutable, [packagedMcp], {
  env: packagedEnvironment,
  stdio: ['ignore', 'inherit', 'inherit'],
});
const beholddSmoke = spawnSync(embeddedBeholdd, [], { cwd: ROOT, encoding: 'utf8' });
if (
  beholddSmoke.status !== 1 ||
  !beholddSmoke.stderr.includes('missing command') ||
  !beholddSmoke.stderr.includes('serve')
) {
  throw new Error(
    `packaged Beholdd did not execute its command parser as expected: ${beholddSmoke.stderr || beholddSmoke.error}`
  );
}
const hagSmoke = spawnSync(embeddedBeholddHag, [], {
  cwd: ROOT, encoding: 'utf8', timeout: 30_000,
  env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), LANG: 'C', LC_ALL: 'C' },
});
if (hagSmoke.error || hagSmoke.status !== 1 || !hagSmoke.stderr?.includes('missing command') || !hagSmoke.stderr.includes('serve')) {
  throw new Error(`packaged experimental HAG command parser failed: ${hagSmoke.stderr || hagSmoke.error}`);
}
const llamaSmoke = spawnSync(embeddedLlamaVulkan, ['--version'], {
  cwd: path.dirname(embeddedLlamaVulkan),
  encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), LANG: 'C', LC_ALL: 'C' },
});
const llamaSmokeOutput = `${llamaSmoke.stdout ?? ''}${llamaSmoke.stderr ?? ''}`;
if (
  llamaSmoke.status !== 0 ||
  !llamaSmokeOutput.includes('version: 0.5.0-dev (build 11223, commit 4da633776)') ||
  !llamaSmokeOutput.includes('built with GNU 11.4.0 for Linux x86_64')
) {
  throw new Error(`packaged llama.cpp Vulkan server failed its clean-environment smoke test: ${llamaSmokeOutput}`);
}
const llamaDependencies = spawnSync('ldd', [embeddedLlamaVulkan], {
  cwd: path.dirname(embeddedLlamaVulkan),
  encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), LANG: 'C', LC_ALL: 'C' },
});
const llamaDependencyOutput = `${llamaDependencies.stdout ?? ''}${llamaDependencies.stderr ?? ''}`;
if (llamaDependencies.status !== 0 || /\bnot found\b/.test(llamaDependencyOutput)) {
  throw new Error(`packaged llama.cpp Vulkan server has unresolved shared libraries: ${llamaDependencyOutput}`);
}

const glibcCeiling = '2.34';
let maximumGlibc = '0.0';
let maximumGlibcFile = null;
let scannedElfCount = 0;
const packagedFiles = [appImage, ...walkFiles(unpacked)];
for (const file of packagedFiles) {
  const descriptor = fs.openSync(file, 'r');
  const magic = Buffer.alloc(4);
  try {
    fs.readSync(descriptor, magic, 0, magic.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
  scannedElfCount += 1;
  const versionInfo = execFileSync('readelf', ['--version-info', '--wide', file], {
    encoding: 'utf8',
    env: { ...buildEnvironment, LC_ALL: 'C' },
  });
  const neededSection = versionInfo.split('Version needs section')[1] ?? '';
  const unfamiliar = [...neededSection.matchAll(/\bGLIBC_([^\s]+)/g)]
    .map((match) => match[1].replace(/[),]+$/, ''))
    .filter((name) => !/^\d+(?:\.\d+)+$/.test(name));
  if (unfamiliar.length) {
    throw new Error(`packaged ELF uses unfamiliar GLIBC ABI tag(s) ${unfamiliar.join(', ')}: ${file}`);
  }
  const versions = neededSection.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/g);
  for (const match of versions) {
    if (compareVersions(match[1], maximumGlibc) > 0) {
      maximumGlibc = match[1];
      maximumGlibcFile = file;
    }
  }
}
if (compareVersions(maximumGlibc, glibcCeiling) > 0) {
  throw new Error(
    `packaged ELF requires GLIBC_${maximumGlibc} (${maximumGlibcFile}), above release ceiling ${glibcCeiling}`
  );
}
console.log(
  `  packaged ELF GLIBC ceiling: ${maximumGlibc} across ${scannedElfCount} files (declared maximum ${glibcCeiling})`
);

const upstreamFiles = reviewedUpstreamFiles(ROOT, unpacked);
let reviewedUpstreamOccurrences = 0;
for (const file of packagedFiles) {
  reviewedUpstreamOccurrences += assertNoLocalBuildPaths(file, {
    privatePaths: [ROOT, process.env.ANTIMATTER_RELEASE_SOURCE_ROOT],
    homePath: os.homedir(),
    upstreamFiles,
  });
}
console.log(`  build-path scan passed (${reviewedUpstreamOccurrences} byte-pinned public upstream diagnostic paths retained)`);

const staging = path.join(DIST, '.staging');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

console.log('\n=== Creating FUSE-free application archive');
const appRootName = `Antimatter-${version}-${platformName}`;
const appRoot = path.join(staging, appRootName);
fs.cpSync(unpacked, appRoot, { recursive: true, verbatimSymlinks: true });
copyFile(path.join(RELEASES, 'README.md'), path.join(appRoot, 'INSTALL.md'));
copyFile(path.join(RELEASES, 'RELEASE_NOTES.md'), path.join(appRoot, 'RELEASE_NOTES.md'));
copyFile(path.join(RELEASES, 'THIRD_PARTY_NOTICES.md'), path.join(appRoot, 'THIRD_PARTY_NOTICES.md'));
copyFile(path.join(RELEASES, 'licenses', 'Apache-2.0.txt'), path.join(appRoot, 'LICENSE-APACHE-2.0.txt'));
copyFile(backendInventoryPath, path.join(appRoot, 'backend-inventory.json'));
createNormalizedArchive(appRoot, appRootName, path.join(DIST, appArchiveName));

console.log('=== Creating standalone Beholdd archive');
const beholddRootName = `beholdd-${version}-${platformName}`;
const beholddRoot = path.join(staging, beholddRootName);
fs.cpSync(path.join(ROOT, 'vendor', 'beholdd'), beholddRoot, { recursive: true });
copyFile(path.join(RELEASES, 'THIRD_PARTY_NOTICES.md'), path.join(beholddRoot, 'THIRD_PARTY_NOTICES.md'));
copyFile(
  path.join(RELEASES, 'licenses', 'Apache-2.0.txt'),
  path.join(beholddRoot, 'LICENSE-APACHE-2.0.txt')
);
copyFile(
  path.join(RELEASES, 'licenses', 'beholdd', 'THIRD_PARTY_LICENSES.txt'),
  path.join(beholddRoot, 'BEHOLDD_THIRD_PARTY_LICENSES.txt')
);
copyFile(
  path.join(RELEASES, 'licenses', 'beholdd', 'manifest.json'),
  path.join(beholddRoot, 'BEHOLDD_THIRD_PARTY_LICENSES.manifest.json')
);
for (const name of ['beholdd-runtime', 'chat-templates']) {
  fs.cpSync(path.join(RELEASES, 'licenses', name), path.join(beholddRoot, 'licenses', name), { recursive: true });
}
createNormalizedArchive(beholddRoot, beholddRootName, path.join(DIST, beholddArchiveName));

for (const [source, name, mode] of [
  ['install.sh', 'install.sh', 0o755],
  ['uninstall.sh', 'uninstall.sh', 0o755],
  ['beholdd.streaming.yaml', 'beholdd.streaming.yaml', 0o644],
  ['co.antimatter.app.svg', 'co.antimatter.app.svg', 0o644],
]) {
  copyFile(path.join(LINUX_INPUTS, source), path.join(DIST, name), mode);
}
for (const name of ['README.md', 'RELEASE_NOTES.md', 'THIRD_PARTY_NOTICES.md', 'model-manifest.json', 'hag-model.json']) {
  copyFile(path.join(RELEASES, name), path.join(DIST, name));
}
copyFile(
  path.join(RELEASES, 'licenses', 'Apache-2.0.txt'),
  path.join(DIST, 'LICENSE-APACHE-2.0.txt'),
  0o644
);
copyFile(
  path.join(RELEASES, 'licenses', 'llama.cpp', 'LICENSE'),
  path.join(DIST, 'LLAMA_CPP_LICENSE.txt'),
  0o644
);
copyFile(
  path.join(RELEASES, 'licenses', 'beholdd', 'THIRD_PARTY_LICENSES.txt'),
  path.join(DIST, 'BEHOLDD_THIRD_PARTY_LICENSES.txt'),
  0o644
);
copyFile(
  path.join(RELEASES, 'licenses', 'beholdd', 'manifest.json'),
  path.join(DIST, 'BEHOLDD_THIRD_PARTY_LICENSES.manifest.json'),
  0o644
);

for (const [source, destination] of [
  ['THIRD_PARTY_LICENSES.txt', 'BEHOLDD_HAG_THIRD_PARTY_LICENSES.txt'],
  ['manifest.json', 'BEHOLDD_HAG_THIRD_PARTY_LICENSES.manifest.json'],
]) {
  copyFile(path.join(RELEASES, 'licenses', 'beholdd-hag', source), path.join(DIST, destination), 0o644);
}

const primaryArtifacts = [appImageName, appArchiveName, beholddArchiveName].map((name) => {
  const file = path.join(DIST, name);
  return { name, bytes: fs.statSync(file).size, sha256: sha256(file) };
});
const dependencyManifests = Object.fromEntries(
  ['beholdd', 'beholdd-hag', 'displacer', 'llama-vulkan'].map((name) => [
    name,
    JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', name, 'manifest.json'), 'utf8')),
  ])
);
const manifest = {
  schemaVersion: 1,
  name: 'Antimatter',
  version,
  releaseVersion,
  tag: releaseTag,
  channel,
  commit,
  builtAt,
  platform: { os: 'linux', architecture: 'x86_64', minimumGlibc: '2.34' },
  abiVerification: {
    maximumRequiredGlibc: maximumGlibc,
    allowedGlibcCeiling: glibcCeiling,
    elfFilesScanned: scannedElfCount,
  },
  buildRuntime: {
    node: process.versions.node,
    npm: capture('npm', ['--version']),
    dependencyInstall: RELEASE_DEPENDENCY_INSTALL,
    nativeModules: [nativeRelease],
  },
  model: JSON.parse(fs.readFileSync(path.join(RELEASES, 'model-manifest.json'), 'utf8')),
  experimentalHagModel: JSON.parse(fs.readFileSync(path.join(RELEASES, 'hag-model.json'), 'utf8')),
  dependencies: dependencyManifests,
  backendInventory: { name: 'backend-inventory.json', sha256: sha256(backendInventoryPath) },
  javaScriptInventory,
  android: androidRelease,
  artifacts: primaryArtifacts,
  publishedAssets: expectedPublishedAssets,
  packageLockSha256: sha256(path.join(ROOT, 'package-lock.json')),
};
fs.writeFileSync(path.join(DIST, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

for (const generated of ['builder-debug.yml', 'builder-effective-config.yaml', 'latest-linux.yml']) {
  fs.rmSync(path.join(DIST, generated), { force: true });
}
fs.rmSync(staging, { recursive: true, force: true });
if (process.env.ANTIMATTER_KEEP_UNPACKED !== '1') {
  fs.rmSync(unpacked, { recursive: true, force: true });
}

const releaseFiles = fs
  .readdirSync(DIST, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name !== 'SHA256SUMS')
  .map((entry) => entry.name)
  .sort();
const actualPublishedAssets = [...releaseFiles, 'SHA256SUMS'].sort();
if (JSON.stringify(actualPublishedAssets) !== JSON.stringify(expectedPublishedAssets)) {
  throw new Error(
    `release asset set drifted; expected ${expectedPublishedAssets.join(', ')}, found ${actualPublishedAssets.join(', ')}`
  );
}
const checksums = releaseFiles.map((name) => `${sha256(path.join(DIST, name))}  ${name}`).join('\n');
fs.writeFileSync(path.join(DIST, 'SHA256SUMS'), `${checksums}\n`);

console.log('\n=== Exercising the packaged installer lifecycle');
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antimatter-release-smoke-'));
try {
  const smokeData = path.join(smokeRoot, "data home with % and 'quote");
  const smokeConfig = path.join(smokeRoot, 'config home');
  const smokeState = path.join(smokeRoot, 'state home');
  const smokeBin = path.join(smokeRoot, 'bin home');
  const smokeEnvironment = {
    ...buildEnvironment,
    XDG_DATA_HOME: smokeData,
    XDG_CONFIG_HOME: smokeConfig,
    XDG_STATE_HOME: smokeState,
    XDG_BIN_HOME: smokeBin,
  };
  const installer = path.join(DIST, 'install.sh');
  const packagePath = path.join(DIST, appArchiveName);
  const checksumsPath = path.join(DIST, 'SHA256SUMS');
  const installArguments = ['--skip-model', '--package', packagePath, '--checksums', checksumsPath];
  const target = path.join(smokeData, 'antimatter', 'releases', version);
  const installedReadme = path.join(target, 'INSTALL.md');
  const current = path.join(smokeData, 'antimatter', 'current');
  const config = path.join(smokeConfig, 'antimatter', 'beholdd', 'config.yaml');
  const receipt = path.join(smokeState, 'antimatter', 'install.json');

  run(installer, installArguments, { env: smokeEnvironment });
  const installedApp = path.join(target, 'antimatter');
  requireFile(installedApp, 'smoke-test installed executable');
  requireFile(installedReadme, 'smoke-test installed documentation');
  requireFile(config, 'smoke-test Beholdd configuration');
  requireFile(receipt, 'smoke-test install receipt');
  if (!fs.lstatSync(current).isSymbolicLink() || fs.realpathSync(current) !== fs.realpathSync(target)) {
    throw new Error('installer smoke test did not activate the installed version');
  }

  run(
    installedApp,
    [
      '-e',
      [
        "const p=require(process.resourcesPath+'/app.asar/node_modules/node-pty');",
        "if(typeof p.spawn!=='function')throw new Error('node-pty spawn is unavailable');",
        "let output='';",
        "const terminal=p.spawn('/bin/sh',['-c','printf packaged-pty-ok'],{name:'xterm',cols:80,rows:24,cwd:process.cwd(),env:process.env});",
        "const timer=setTimeout(()=>{terminal.kill();console.error('packaged PTY timed out');process.exit(2)},5000);",
        "terminal.onData((data)=>{output+=data});",
        "terminal.onExit(({exitCode})=>{clearTimeout(timer);if(exitCode!==0||output!=='packaged-pty-ok'){console.error(JSON.stringify({exitCode,output}));process.exit(3)};console.log(output)});",
      ].join(''),
    ],
    { env: { ...smokeEnvironment, ELECTRON_RUN_AS_NODE: '1' } }
  );

  const installedBeholdd = path.join(target, 'resources', 'vendor', 'beholdd', 'bin', 'beholdd');
  const smokePort = await reserveLoopbackPort();
  if (!smokePort) throw new Error('could not reserve a loopback port for Beholdd smoke test');
  const beholddOutput = [];
  let beholddSpawnError = null;
  const beholddChild = spawn(
    installedBeholdd,
    ['serve', '--config', config, '--host', '127.0.0.1', '--port', String(smokePort)],
    { cwd: target, env: smokeEnvironment, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  for (const stream of [beholddChild.stdout, beholddChild.stderr]) {
    stream.on('data', (chunk) => {
      if (beholddOutput.join('').length < 65536) beholddOutput.push(String(chunk));
    });
  }
  beholddChild.once('error', (error) => {
    beholddSpawnError = error;
  });
  try {
    let health = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (beholddSpawnError) throw beholddSpawnError;
      if (beholddChild.exitCode !== null) {
        throw new Error(`installed Beholdd exited during startup: ${beholddOutput.join('')}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${smokePort}/health`);
        if (response.ok) health = await response.json();
      } catch {
        // Listener startup is asynchronous; retry within the bounded window below.
      }
      if (health?.status === 'ok') break;
      await delay(100);
    }
    if (health?.status !== 'ok') {
      throw new Error(`installed Beholdd did not become healthy: ${beholddOutput.join('')}`);
    }
    const modelsResponse = await fetch(`http://127.0.0.1:${smokePort}/v1/models`);
    const models = await modelsResponse.json();
    if (
      !modelsResponse.ok ||
      !Array.isArray(models?.data) ||
      !models.data.some((entry) => entry?.id === 'qwen3-coder-30b')
    ) {
      throw new Error(`installed Beholdd did not expose qwen3-coder-30b: ${JSON.stringify(models)}`);
    }
  } finally {
    await stopChild(beholddChild);
  }

  const pristineReadme = fs.readFileSync(installedReadme, 'utf8');
  const preservedConfig = `${fs.readFileSync(config, 'utf8')}# preserved-by-release-smoke\n`;
  fs.writeFileSync(config, preservedConfig, { mode: 0o600 });
  fs.appendFileSync(installedReadme, '\ncorrupted-by-release-smoke\n');

  run(installer, installArguments, { env: smokeEnvironment });
  if (fs.readFileSync(installedReadme, 'utf8') !== pristineReadme) {
    throw new Error('same-version reinstall did not repair a damaged managed payload');
  }
  if (fs.readFileSync(config, 'utf8') !== preservedConfig) {
    throw new Error('same-version reinstall replaced user Beholdd configuration');
  }

  const futureVersion = path.join(smokeData, 'antimatter', 'releases', 'future-version');
  fs.mkdirSync(futureVersion, { recursive: true });
  fs.writeFileSync(path.join(futureVersion, 'preserve-me'), 'not owned by this receipt\n');
  const uninstaller = path.join(smokeData, 'antimatter', 'uninstall.sh');
  run(uninstaller, [], { env: smokeEnvironment });
  if (fs.existsSync(target)) throw new Error('uninstaller smoke test left the receipted payload behind');
  requireFile(path.join(futureVersion, 'preserve-me'), 'uninstaller-preserved unrelated release');
  requireFile(config, 'uninstaller-preserved Beholdd configuration');
  if (fs.existsSync(receipt)) throw new Error('uninstaller smoke test left the install receipt behind');
} finally {
  fs.rmSync(smokeRoot, { recursive: true, force: true });
}

console.log('\n=== Release artifacts');
for (const name of [...releaseFiles, 'SHA256SUMS']) {
  const bytes = fs.statSync(path.join(DIST, name)).size;
  console.log(`${name.padEnd(60)} ${(bytes / 1024 / 1024).toFixed(2).padStart(9)} MiB`);
}
console.log(`\nReady in ${DIST}`);
