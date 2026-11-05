import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Official node:22.22.1-bullseye multi-platform index, selected explicitly as linux/amd64.
export const NATIVE_RELEASE_IMAGE = 'docker.io/library/node@sha256:d211dd3177ea688668005f5c83bac33534aa87f1b173d53d19082fbc5482ee15';
// Docker's daemon creates these cgroups outside the caller's user service. Each invocation
// therefore owns its resource envelope, including the short smoke and toolchain probes.
export const NATIVE_RELEASE_CONTAINER_LIMITS = Object.freeze({
  memoryBytes: 3 * 1024 ** 3, swapBytes: 0, cpus: 1, processes: 256, buildJobs: 1, runtimeSeconds: 600,
});

export function nativeReleaseContainerArgs(root, scratch, uid = process.getuid(), gid = process.getgid()) {
  return [
    'run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${uid}:${gid}`,
    '--memory', '3g', '--memory-swap', '3g', '--cpus', '1', '--pids-limit', '256',
    '--tmpfs', '/tmp:rw,nosuid,size=256m', '--env', 'HOME=/tmp', '--env', 'MAKEFLAGS=-j1',
    '--mount', `type=bind,src=${path.join(root, 'node_modules')},dst=/dependencies/node_modules,readonly`,
    '--mount', `type=bind,src=${scratch},dst=/work`, '--workdir', '/work/node-pty', NATIVE_RELEASE_IMAGE,
    'timeout', '--signal=TERM', '--kill-after=10s', `${NATIVE_RELEASE_CONTAINER_LIMITS.runtimeSeconds}s`,
  ];
}

const RECEIPT = 'antimatter-native-release.json';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileSha = (file) => sha(fs.readFileSync(file));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const capture = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const compareVersions = (a, b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
};

export function nativeAbiRequirements(binary) {
  const output = capture('readelf', ['--wide', '--version-info', binary]);
  const needs = output.split('Version needs section')[1];
  if (!needs) throw new Error('Native release binary has no readable ELF version requirements');
  const required = {};
  for (const namespace of ['GLIBC', 'GLIBCXX', 'CXXABI']) {
    const versions = [...needs.matchAll(new RegExp(`\\b${namespace}_([^\\s]+)`, 'g'))].map((match) => match[1]);
    if (versions.some((version) => !/^\d+(?:\.\d+)+$/.test(version))) throw new Error(`Unknown ${namespace} native ABI requirement`);
    required[namespace] = versions.sort(compareVersions).at(-1) ?? null;
  }
  if (!required.GLIBC || compareVersions(required.GLIBC, '2.34') > 0) throw new Error(`Native release requires GLIBC_${required.GLIBC}, above 2.34`);
  return required;
}

function treeSha(root) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) entries.push(`${path.relative(root, file).split(path.sep).join('/')}\0${fileSha(file)}`);
      else throw new Error(`Unexpected symlink/special file in native source snapshot: ${file}`);
    }
  };
  walk(root);
  return sha(entries.join('\n'));
}

function moduleInputs(root) {
  const require = createRequire(path.join(root, 'package.json'));
  const ptyPackage = require.resolve('node-pty/package.json');
  const ptyRequire = createRequire(ptyPackage);
  const addonPackage = ptyRequire.resolve('node-addon-api/package.json');
  const gyp = require.resolve('node-gyp/bin/node-gyp.js');
  const lock = readJson(path.join(root, 'package-lock.json'));
  const entries = {};
  for (const [name, file] of Object.entries({ 'node-pty': ptyPackage, 'node-addon-api': addonPackage, 'node-gyp': path.join(path.dirname(gyp), '../package.json') })) {
    const directory = path.dirname(file);
    const key = path.relative(root, directory).split(path.sep).join('/');
    const installed = readJson(file);
    const pinned = lock.packages?.[key];
    if (pinned?.version !== installed.version || !/^sha512-/.test(pinned?.integrity ?? '')) throw new Error(`Native release ${name} does not match its npm lockfile entry`);
    entries[name] = { version: installed.version, integrity: pinned.integrity };
  }
  return { require, ptyRoot: path.dirname(ptyPackage), addonRoot: path.dirname(addonPackage), gyp, entries, electron: require('electron/package.json').version };
}

const PTY_SMOKE = `
const p=require(process.argv[1]); let text='';
const terminal=p.spawn('/bin/sh',['-c','printf release-native-pty-ok'],{name:'xterm',cols:80,rows:24,cwd:'/tmp',env:process.env});
const timer=setTimeout(()=>{terminal.kill();console.error('native PTY timeout');process.exit(2)},5000);
terminal.onData(data=>{text+=data});
terminal.onExit(({exitCode})=>{clearTimeout(timer);if(exitCode!==0||text!=='release-native-pty-ok'){console.error(JSON.stringify({exitCode,text}));process.exit(3)}console.log('native PTY smoke passed')});
`;

async function download(url, maximumBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Native header download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) throw new Error('Native header download exceeded expected size');
  return bytes;
}

export async function rebuildNativeForRelease(root) {
  if (process.env.ANTIMATTER_ISOLATED_RELEASE !== '1') throw new Error('Compatible native rebuilding is restricted to the isolated release checkout');
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Native release build requires Linux x86_64');
  const inputs = moduleInputs(root);
  if (!/^\d+\.\d+\.\d+$/.test(inputs.electron)) throw new Error('Unusable pinned Electron header version');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'antimatter-native-release-'));
  try {
    const source = path.join(scratch, 'node-pty');
    fs.cpSync(inputs.ptyRoot, source, {
      recursive: true,
      filter: (file) => !['build', 'prebuilds', 'node_modules', RECEIPT].includes(path.relative(inputs.ptyRoot, file).split(path.sep)[0]),
    });
    fs.cpSync(inputs.addonRoot, path.join(source, 'node_modules/node-addon-api'), { recursive: true });
    const sourceTreeSha256 = treeSha(source);
    const headerBase = `https://artifacts.electronjs.org/headers/dist/v${inputs.electron}`;
    const headerName = `node-v${inputs.electron}-headers.tar.gz`;
    const sums = (await download(`${headerBase}/SHASUMS256.txt`, 1024 * 1024)).toString('utf8');
    const headerSha256 = sums.split('\n').map((line) => line.trim().split(/\s+/)).find(([, name]) => name === headerName)?.[0];
    if (!/^[0-9a-f]{64}$/.test(headerSha256 ?? '')) throw new Error('Official Electron header checksum is missing');
    const archive = await download(`${headerBase}/${headerName}`, 64 * 1024 * 1024);
    if (sha(archive) !== headerSha256) throw new Error('Electron headers failed official SHA-256 verification');
    const tarball = path.join(scratch, 'headers.tar.gz');
    fs.writeFileSync(tarball, archive);
    const entries = capture('tar', ['-tzf', tarball]).split('\n');
    if (entries.some((name) => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))) throw new Error('Unsafe Electron headers archive');
    const headers = path.join(scratch, 'headers');
    fs.mkdirSync(headers);
    run('tar', ['-xzf', tarball, '--strip-components=1', '-C', headers]);
    if (!fs.existsSync(path.join(headers, 'include/node/node_api.h'))) throw new Error('Electron headers archive has an unexpected layout');

    // Only this explicit pull uses Docker networking. Compile and baseline smoke have none.
    run('docker', ['pull', '--platform', 'linux/amd64', NATIVE_RELEASE_IMAGE]);
    const container = nativeReleaseContainerArgs(root, scratch);
    const gypPath = `/dependencies/node_modules/${path.relative(path.join(root, 'node_modules'), inputs.gyp).split(path.sep).join('/')}`;
    run('docker', [...container, 'node', gypPath, 'rebuild', '--jobs=1', `--target=${inputs.electron}`, '--nodedir=/work/headers']);
    const binary = path.join(source, 'build/Release/pty.node');
    const abi = nativeAbiRequirements(binary);
    run('docker', [...container, 'node', '-e', PTY_SMOKE, '/work/node-pty']);
    run(inputs.require('electron'), ['-e', PTY_SMOKE, source], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const toolchain = JSON.parse(capture('docker', [...container, 'node', '-e', "const cp=require('child_process');console.log(JSON.stringify({node:process.versions.node,glibc:cp.execFileSync('getconf',['GNU_LIBC_VERSION'],{encoding:'utf8'}).trim(),compiler:cp.execFileSync('g++',['-dumpfullversion'],{encoding:'utf8'}).trim()}))"]));
    const receipt = {
      schemaVersion: 1, name: 'node-pty', electron: inputs.electron,
      image: NATIVE_RELEASE_IMAGE, platform: 'linux/amd64', toolchain,
      containerLimits: NATIVE_RELEASE_CONTAINER_LIMITS,
      packages: inputs.entries, sourceTreeSha256,
      electronHeaders: { url: `${headerBase}/${headerName}`, sha256: headerSha256 },
      binarySha256: fileSha(binary), abi,
      verification: { networkDisabledDuringCompile: true, baselinePty: true, electronPty: true },
    };
    // The loader prefers build/Release, then Debug/prebuilds. Remove all stale fallback binaries
    // in this disposable release checkout, including host-built outputs from npm postinstall.
    fs.rmSync(path.join(inputs.ptyRoot, 'build'), { recursive: true, force: true });
    fs.rmSync(path.join(inputs.ptyRoot, 'prebuilds'), { recursive: true, force: true });
    fs.mkdirSync(path.join(inputs.ptyRoot, 'build/Release'), { recursive: true });
    fs.copyFileSync(binary, path.join(inputs.ptyRoot, 'build/Release/pty.node'));
    fs.writeFileSync(path.join(inputs.ptyRoot, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`Compatible node-pty verified: GLIBC_${abi.GLIBC}, Electron ${inputs.electron}, ${receipt.binarySha256}`);
    return receipt;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function verifyNativeRelease(root, packagedBinary) {
  const inputs = moduleInputs(root);
  const receipt = readJson(path.join(inputs.ptyRoot, RECEIPT));
  if (receipt.schemaVersion !== 1 || receipt.image !== NATIVE_RELEASE_IMAGE || receipt.platform !== 'linux/amd64' || receipt.electron !== inputs.electron || JSON.stringify(receipt.packages) !== JSON.stringify(inputs.entries)) {
    throw new Error('Compatible native release receipt does not match the locked package/toolchain inputs');
  }
  if (JSON.stringify(receipt.containerLimits) !== JSON.stringify(NATIVE_RELEASE_CONTAINER_LIMITS)) {
    throw new Error('Compatible native release receipt lacks the required bounded container policy');
  }
  for (const file of [path.join(inputs.ptyRoot, 'build/Release/pty.node'), ...(packagedBinary ? [packagedBinary] : [])]) {
    if (fileSha(file) !== receipt.binarySha256) throw new Error('Compatible node-pty binary changed after verification or during packaging');
    const abi = nativeAbiRequirements(file);
    if (JSON.stringify(abi) !== JSON.stringify(receipt.abi)) throw new Error('Compatible node-pty ABI requirements changed after verification');
  }
  if (!receipt.verification?.networkDisabledDuringCompile || !receipt.verification?.baselinePty || !receipt.verification?.electronPty) throw new Error('Compatible native release receipt is missing successful PTY verification');
  return receipt;
}

export const LINUX_RELEASE_PACKAGE_ARGS = ['run', 'package:linux', '--', '--config.npmRebuild=false', '--config.nodeGypRebuild=false'];

export function packageLinuxRelease(root, packageRunner) {
  const receipt = verifyNativeRelease(root);
  packageRunner('npm', LINUX_RELEASE_PACKAGE_ARGS);
  verifyNativeRelease(root, path.join(root, 'releases/dist/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node'));
  return receipt;
}
