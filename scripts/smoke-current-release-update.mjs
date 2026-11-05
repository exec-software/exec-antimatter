#!/usr/bin/env node
/**
 * Same-payload updater transport/lifecycle smoke in a private HOME/XDG tree.
 *
 * Install the current verified package, give only its private installation metadata
 * a synthetic older version, and update it through the real UpdateService and
 * installer. This is NOT qualification of a previous binary's cross-version update.
 * No old/private builds, UI, model downloads, or real relaunch are involved.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compareReleaseVersions, isReleaseIdentity } from './lib/release-version.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dist = path.join(repository, 'releases/dist');
let reportPath = null;
const seen = new Set();
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  assert.ok(['--dist', '--report'].includes(flag) && !seen.has(flag), `Unknown or repeated option: ${flag}`);
  seen.add(flag);
  const value = process.argv[++index];
  assert.ok(value && !value.startsWith('--'), `${flag} requires a path`);
  if (flag === '--dist') dist = path.resolve(value);
  else reportPath = path.resolve(value);
}
if (reportPath) {
  assert.ok(!reportPath.startsWith(repository + path.sep), 'write the verification report outside the source repository');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  assert.equal(await fs.lstat(reportPath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; }), null,
    'the verification report must be a new file');
}
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const digest = async (file) => {
  assert.equal((await fs.lstat(file)).isFile(), true, `expected a regular release asset: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const manifest = await json(path.join(dist, 'release-manifest.json'));
const packageJson = await json(path.join(repository, 'package.json'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
assert.equal(manifest.name, 'Antimatter');
assert.equal(manifest.version, packageJson.version);
assert.equal(manifest.commit, commit, 'smoke source must match the built release');
assert.ok(isReleaseIdentity(manifest));
assert.equal(manifest.channel, 'stable');
const older = '0.0.0';
assert.ok(compareReleaseVersions(older, manifest.version) < 0);
const sums = new Map();
for (const line of (await fs.readFile(path.join(dist, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
  const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
  assert.ok(match && !sums.has(match[2]), 'malformed or duplicate release checksum');
  sums.set(match[2], match[1]);
}
assert.ok(Array.isArray(manifest.publishedAssets) && manifest.publishedAssets.includes('SHA256SUMS'));
assert.equal(new Set(manifest.publishedAssets).size, manifest.publishedAssets.length);
assert.deepEqual([...sums.keys()].sort(), manifest.publishedAssets.filter((name) => name !== 'SHA256SUMS').sort(),
  'published asset inventory must match checksums');
for (const [name, expected] of sums) {
  assert.ok(name !== '.' && name !== '..' && !/[\x00-\x1f]/.test(name), 'unsafe release asset name');
  assert.equal(await digest(path.join(dist, name)), expected, `${name} failed its published checksum`);
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-current-update-'));
const services = [];
let coordinator;
const scope = 'Same-payload transport/lifecycle with synthetic older metadata; not a cross-version binary upgrade.';
console.log(scope);
const run = (command, args, env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: scratch, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-64 * 1024); });
  const timer = setTimeout(() => {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, 180_000);
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (code !== 0) reject(new Error(`${path.basename(command)} failed (${signal ?? code}): ${output}`));
    else resolve(output.trim());
  });
});

try {
  const runtime = path.join(scratch, 'update-runtime.cjs');
  await build({
    stdin: { contents: [
      'export { UpdateService } from "./src/main/updates/service";',
      'export { detectInstallation, receiptPathFor } from "./src/main/updates/installation";',
      'export { AutomaticRestartCoordinator } from "./src/main/updates/coordinator";',
      'export { installerAssets } from "./src/main/updates/apply";',
      'export { copyVerified } from "./src/main/updates/stage";',
    ].join('\n'), resolveDir: repository, sourcefile: 'same-payload-update-smoke.ts', loader: 'ts' },
    outfile: runtime, bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning',
  });
  const { UpdateService, detectInstallation, receiptPathFor, AutomaticRestartCoordinator, installerAssets, copyVerified } =
    await import(pathToFileURL(runtime).href);
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: path.join(scratch, 'home'),
    XDG_DATA_HOME: path.join(scratch, "data home with % and 'quote"),
    XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_STATE_HOME: path.join(scratch, 'state'),
    XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_BIN_HOME: path.join(scratch, 'bin'),
    XDG_RUNTIME_DIR: path.join(scratch, 'run'), TMPDIR: path.join(scratch, 'tmp'),
  };
  for (const [key, value] of Object.entries(env)) {
    if (key === 'HOME' || key === 'TMPDIR' || key.startsWith('XDG_')) {
      assert.ok(value.startsWith(scratch + path.sep));
      await fs.mkdir(value, { recursive: true, mode: 0o700 });
    }
  }
  const feed = path.join(scratch, 'feed');
  const relativeBuild = `builds/same-payload__${manifest.version}__BLD-update-smoke`;
  const artifactsDir = path.join(feed, relativeBuild, 'artifacts');
  await fs.mkdir(artifactsDir, { recursive: true });
  const artifacts = [];
  for (const name of [...installerAssets(manifest.version), 'RELEASE_NOTES.md']) {
    assert.ok(manifest.publishedAssets.includes(name), `release does not publish ${name}`);
    const file = path.join(dist, name);
    const artifact = { name, path: file, size: (await fs.stat(file)).size, sha256: await digest(file), executable: name.endsWith('.sh') };
    await copyVerified(artifact, path.join(artifactsDir, name));
    artifacts.push({ name, relative_path: `artifacts/${name}`, size: artifact.size, sha256: artifact.sha256, executable: artifact.executable });
  }
  await fs.writeFile(path.join(feed, 'latest.json'), JSON.stringify({
    schema: 'execute.buildd/latest-v2', project: 'antimatter', latest: {
      build_id: 'BLD-update-smoke', version: manifest.version, git_ref: manifest.tag, commit,
      published_at: manifest.builtAt, relative_path: relativeBuild, pinned: false, artifacts,
    },
  }));
  await run('bash', [path.join(artifactsDir, 'install.sh'), '--skip-model', '--package',
    path.join(artifactsDir, `Antimatter-${manifest.version}-linux-x86_64.tar.gz`),
    '--checksums', path.join(artifactsDir, 'SHA256SUMS')], env);

  const dataRoot = path.join(env.XDG_DATA_HOME, 'antimatter');
  const release = (version) => path.join(dataRoot, 'releases', version);
  const receiptPath = receiptPathFor(env, env.HOME);
  const receipt = await json(receiptPath);
  assert.equal(receipt.currentVersion, manifest.version);
  assert.equal(receipt.releases.length, 1);
  // The payload stays byte-identical. Only this disposable installation's version/path
  // metadata changes, so UpdateService follows its ordinary older-installation path.
  await fs.rename(release(manifest.version), release(older));
  receipt.currentVersion = older;
  receipt.releases[0].version = older;
  receipt.releases[0].path = release(older);
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await fs.unlink(path.join(dataRoot, 'current'));
  await fs.symlink(release(older), path.join(dataRoot, 'current'));

  const userData = path.join(env.XDG_CONFIG_HOME, 'antimatter');
  const config = path.join(userData, 'beholdd/config.yaml');
  const sentinels = new Map([
    [config, `${await fs.readFile(config, 'utf8')}\n# synthetic update preservation check\n`],
    [path.join(userData, 'conversations.json'), '{"syntheticConversation":"must survive"}\n'],
    [path.join(dataRoot, 'models/smoke-preserve.bin'), 'Synthetic model sentinel; not a checkpoint.\n'],
  ]);
  for (const [file, value] of sentinels) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value, { mode: 0o600 });
  }
  const states = [], automaticReady = [];
  const service = (version) => {
    const updates = new UpdateService({
      userData, cacheRoot: path.join(env.XDG_CACHE_HOME, 'antimatter/updates'), env, uid: process.getuid(),
      detect: () => detectInstallation({ isPackaged: true, execPath: path.join(release(version), 'antimatter'),
        version, env, uid: process.getuid(), home: env.HOME }),
      send: (state) => states.push(state.status), onAutomaticReady: (state) => automaticReady.push(state.readyVersion),
      candidates: () => [feed], reachable: async () => true, installerTimeoutMs: 180_000,
    });
    services.push(updates);
    return updates;
  };
  const updates = service(older);
  assert.equal(updates.state().install.kind, 'installer');
  updates.setFeed(feed);
  states.length = 0;
  const ready = await updates.check();
  assert.equal(ready.status, 'ready', ready.error ?? undefined);
  assert.equal(ready.readyVersion, manifest.version);
  assert.deepEqual(automaticReady, [manifest.version]);
  assert.deepEqual([...new Set(states)], ['checking', 'available', 'downloading', 'installing', 'ready']);
  for (const [file, value] of sentinels) assert.equal(await fs.readFile(file, 'utf8'), value);
  assert.equal(await fs.realpath(path.join(dataRoot, 'current')), await fs.realpath(release(manifest.version)));
  assert.equal((await json(receiptPath)).currentVersion, manifest.version);
  await fs.stat(path.join(release(older), 'antimatter'));

  const targets = [];
  let busy = true, quits = 0;
  coordinator = new AutomaticRestartCoordinator({
    state: () => updates.state(), blockers: () => busy ? ['Synthetic chat is running.'] : [],
    prepareRenderer: async () => ({ blockers: [], release() {} }), target: () => updates.restartTarget(),
    claim: (version) => updates.claimAutomaticRestart(version), beginCommit() {}, endCommit() {},
    relaunch: async (target) => { targets.push(target); }, quit: () => { quits += 1; },
    report: (state) => updates.setAutomaticRestartState(state), retryMs: 60_000,
  });
  coordinator.offer();
  await coordinator.checkNow();
  assert.equal(targets.length, 0);
  assert.equal(updates.state().restart.pending, true);
  busy = false;
  await coordinator.checkNow();
  coordinator.offer();
  await coordinator.checkNow();
  assert.deepEqual(targets, [{ execPath: path.join(env.XDG_BIN_HOME, 'antimatter'), args: [] }]);
  assert.equal(quits, 1);
  assert.equal(updates.claimAutomaticRestart(manifest.version), false);
  const current = service(manifest.version);
  assert.equal((await current.check()).status, 'current');
  const report = {
    schemaVersion: 1, passed: true, scope, commit, version: manifest.version,
    syntheticPreviousMetadataVersion: older, installerArchiveSha256: sums.get(`Antimatter-${manifest.version}-linux-x86_64.tar.gz`),
    realInstallers: true, realUpdateService: true, explicitlyTrustedFeed: true,
    preserved: ['Beholdd configuration', 'conversations', 'model sentinel', 'previous installation directory'],
    busyRestartBlocked: true, oneShotIdleRestartTarget: true,
    previousReleaseBinaryTested: false, mainUiLaunched: false, realRelaunch: false,
    realUserProfileTouched: false, modelDownloaded: false,
  };
  if (reportPath) await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  coordinator?.stop();
  for (const service of services) service.stop();
  await fs.rm(scratch, { recursive: true, force: true });
}
