#!/usr/bin/env node
/**
 * Real previous release -> current release installer/update smoke. All writes use a new private home/XDG
 * tree; the managed share and releases/dist are read-only inputs. No UI, models, services or real
 * relaunch helpers are started. Usage: node scripts/smoke-release-update.mjs [--dist DIR]
 *   [--previous-feed DIR] [--previous-version 1.0.0] [--keep]
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compareReleaseVersions, parseReleaseVersion } from './lib/release-version.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dist = path.join(repository, 'releases', 'dist');
let previousFeed = '/mnt/builds/managed/antimatter';
let previousVersion = '1.0.0';
let keep = false;
const seenOptions = new Set();
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (seenOptions.has(flag)) throw new Error(`${flag} may be specified only once`);
  seenOptions.add(flag);
  if (flag === '--keep') keep = true;
  else if (flag === '--previous-version') {
    const value = process.argv[++index];
    if (!value || value.startsWith('--')) throw new Error('--previous-version requires a compatibility version');
    if (value.length > 80 || !parseReleaseVersion(value)) throw new Error('--previous-version must be a bounded stable or numbered-alpha compatibility version');
    previousVersion = value;
  }
  else if (flag === '--dist' || flag === '--previous-feed') {
    const value = process.argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a directory`);
    if (flag === '--dist') dist = path.resolve(value);
    else previousFeed = path.resolve(value);
  } else throw new Error(`Unknown option: ${flag}`);
}
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const digest = async (file) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const manifest = await readJson(path.join(dist, 'release-manifest.json'));
const packageJson = await readJson(path.join(repository, 'package.json'));
assert.equal(manifest.name, 'Antimatter');
assert.equal(manifest.version, packageJson.version, 'build the current release before running this smoke');
assert.equal(parseReleaseVersion(manifest.version)?.channel, 'stable', 'the target must be a stable release');
assert.ok(compareReleaseVersions(previousVersion, manifest.version) < 0, 'the previous version must be older than the target release');
const index = await readJson(path.join(previousFeed, 'index.json'));
assert.equal(index.schema, 'execute.buildd/index-v2');
assert.equal(index.project, 'antimatter');
const previousRecord = index.builds.find((entry) => entry.version === previousVersion);
assert.ok(previousRecord, `The read-only managed feed has no ${previousVersion} build`);

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'antimatter-release-update-'));
const services = [];
let coordinator;
let passed = false;
const run = (command, args, env, logFile) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: scratch, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk.toString()).slice(-128 * 1024); });
  const timeout = setTimeout(() => {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, 120_000);
  child.once('error', (error) => { clearTimeout(timeout); reject(error); });
  child.once('close', async (code, signal) => {
    clearTimeout(timeout);
    try {
      if (logFile) await fs.writeFile(logFile, output, { mode: 0o600 });
      if (code !== 0) throw new Error(`${path.basename(command)} failed (${signal ?? code}): ${output}`);
      resolve(output.trim());
    } catch (error) { reject(error); }
  });
});

try {
  console.log(`Release update smoke: ${previousVersion} -> ${manifest.version}; isolated tree ${scratch}`);
  const runtime = path.join(scratch, 'update-runtime.cjs');
  await build({
    stdin: {
      contents: [
        'export { UpdateService } from "./src/main/updates/service";',
        'export { detectInstallation } from "./src/main/updates/installation";',
        'export { AutomaticRestartCoordinator } from "./src/main/updates/coordinator";',
        'export { parseLatest } from "./src/main/updates/feed";',
        'export { installerAssets } from "./src/main/updates/apply";',
        'export { copyVerified } from "./src/main/updates/stage";',
      ].join('\n'),
      resolveDir: repository, sourcefile: 'release-update-smoke.ts', loader: 'ts',
    },
    outfile: runtime, bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning',
  });
  const { UpdateService, detectInstallation, AutomaticRestartCoordinator, parseLatest, installerAssets, copyVerified } = await import(pathToFileURL(runtime).href);
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
  const previous = parseLatest({ schema: 'execute.buildd/latest-v2', project: 'antimatter', latest: previousRecord }, previousFeed);
  const initial = path.join(scratch, 'initial-artifacts');
  await fs.mkdir(initial);
  for (const name of installerAssets(previousVersion)) {
    const artifact = previous.artifacts.get(name);
    assert.ok(artifact, `The ${previousVersion} release lacks ${name}`);
    await copyVerified(artifact, path.join(initial, name));
  }
  console.log(`Installing the real, hash-verified ${previousVersion} archive without downloading a model.`);
  await run('bash', [
    path.join(initial, 'install.sh'), '--skip-model', '--package',
    path.join(initial, `Antimatter-${previousVersion}-linux-x86_64.tar.gz`),
    '--checksums', path.join(initial, 'SHA256SUMS'),
  ], env, path.join(scratch, 'initial-install.log'));

  const userData = path.join(env.XDG_CONFIG_HOME, 'antimatter');
  const config = path.join(userData, 'beholdd', 'config.yaml');
  const preservedConfig = `${await fs.readFile(config, 'utf8')}\n# release-update-smoke: preserve this user configuration\n`;
  const conversations = path.join(userData, 'conversations.json');
  const conversationBytes = '{"smokeConversation":"must survive the release upgrade"}\n';
  const modelSentinel = path.join(env.XDG_DATA_HOME, 'antimatter', 'models', 'smoke-preserve.bin');
  const modelBytes = 'synthetic user model data; not a runnable checkpoint\n';
  await fs.writeFile(config, preservedConfig, { mode: 0o600 });
  await fs.writeFile(conversations, conversationBytes, { mode: 0o600 });
  await fs.mkdir(path.dirname(modelSentinel), { recursive: true });
  await fs.writeFile(modelSentinel, modelBytes, { mode: 0o600 });

  const feed = path.join(scratch, 'feed');
  const relativeBuild = `builds/smoke__${manifest.version}__BLD-update-smoke`;
  const artifactsDir = path.join(feed, relativeBuild, 'artifacts');
  await fs.mkdir(artifactsDir, { recursive: true });
  const sums = new Map((await fs.readFile(path.join(dist, 'SHA256SUMS'), 'utf8')).trim().split('\n').map((line) => {
    const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
    assert.ok(match, 'malformed release SHA256SUMS');
    return [match[2], match[1]];
  }));
  assert.equal(await digest(path.join(dist, 'release-manifest.json')), sums.get('release-manifest.json'));
  const artifacts = [];
  for (const name of [...installerAssets(manifest.version), 'RELEASE_NOTES.md']) {
    assert.ok(manifest.publishedAssets.includes(name), `release does not publish ${name}`);
    const file = path.join(dist, name);
    const sha256 = await digest(file);
    if (name !== 'SHA256SUMS') assert.equal(sha256, sums.get(name), `${name} does not match release SHA256SUMS`);
    const size = (await fs.stat(file)).size;
    const artifact = { name, path: file, size, sha256, executable: name.endsWith('.sh') };
    await copyVerified(artifact, path.join(artifactsDir, name));
    artifacts.push({ name, relative_path: `artifacts/${name}`, size, sha256, executable: artifact.executable });
  }
  await fs.writeFile(path.join(feed, 'latest.json'), JSON.stringify({
    schema: 'execute.buildd/latest-v2', project: 'antimatter', latest: {
      build_id: 'BLD-update-smoke', version: manifest.version, git_ref: manifest.tag,
      commit: manifest.commit, published_at: manifest.builtAt, relative_path: relativeBuild, pinned: false, artifacts,
    },
  }));
  const states = [];
  const automaticReady = [];
  const release = (version) => path.join(env.XDG_DATA_HOME, 'antimatter', 'releases', version);
  const service = (version) => {
    const updates = new UpdateService({
      userData, cacheRoot: path.join(env.XDG_CACHE_HOME, 'antimatter', 'updates'), env, uid: process.getuid(),
      detect: () => detectInstallation({ isPackaged: true, execPath: path.join(release(version), 'antimatter'), version, env, uid: process.getuid(), home: env.HOME }),
      send: (state) => states.push(state), onAutomaticReady: (state) => automaticReady.push(state.readyVersion),
      candidates: () => [feed], reachable: async () => true, installerTimeoutMs: 120_000,
    });
    services.push(updates);
    return updates;
  };
  const updates = service(previousVersion);
  assert.equal(updates.state().install.kind, 'installer');
  console.log(`Running the real UpdateService and ${manifest.version} installer to upgrade ${previousVersion} against the isolated feed.`);
  const ready = await updates.check();
  assert.equal(ready.status, 'ready', ready.error ?? undefined);
  assert.equal(ready.readyVersion, manifest.version);
  assert.deepEqual(automaticReady, [manifest.version]);
  assert.deepEqual([...new Set(states.map((state) => state.status))], ['checking', 'available', 'downloading', 'installing', 'ready']);
  assert.equal(await fs.readFile(config, 'utf8'), preservedConfig);
  assert.equal(await fs.readFile(conversations, 'utf8'), conversationBytes);
  assert.equal(await fs.readFile(modelSentinel, 'utf8'), modelBytes);
  assert.equal(await fs.realpath(path.join(env.XDG_DATA_HOME, 'antimatter', 'current')), await fs.realpath(release(manifest.version)));
  await fs.stat(path.join(release(previousVersion), 'antimatter'));

  const targets = [];
  let busy = true;
  let quits = 0;
  let commits = 0;
  coordinator = new AutomaticRestartCoordinator({
    state: () => updates.state(), blockers: () => busy ? ['Synthetic chat is still running.'] : [],
    prepareRenderer: async () => ({ blockers: [], release() {} }), target: () => updates.restartTarget(['--class=Antimatter']),
    claim: (version) => updates.claimAutomaticRestart(version), beginCommit: () => { commits += 1; }, endCommit() {},
    relaunch: async (target) => { targets.push(target); }, quit: () => { quits += 1; },
    report: (state) => updates.setAutomaticRestartState(state), retryMs: 60_000,
  });
  coordinator.offer();
  await coordinator.checkNow();
  assert.equal(targets.length, 0, 'busy work must prevent an automatic restart');
  assert.equal(updates.state().restart.pending, true);
  busy = false;
  await coordinator.checkNow();
  coordinator.offer();
  await coordinator.checkNow();
  assert.deepEqual(targets, [{ execPath: path.join(env.XDG_BIN_HOME, 'antimatter'), args: [] }]);
  assert.equal(quits, 1);
  assert.equal(commits, 1);
  assert.equal(updates.claimAutomaticRestart(manifest.version), false);
  const oldAgain = service(previousVersion);
  assert.equal(oldAgain.state().status, 'ready');
  assert.match(oldAgain.state().restart.error ?? '', /already attempted/);
  const restarted = service(manifest.version);
  assert.equal((await restarted.check()).status, 'current');
  assert.equal(restarted.restartTarget(), null);
  const packagedVersion = await run(path.join(release(manifest.version), 'antimatter'), ['-e',
    'console.log(require(require("node:path").join(require("node:path").dirname(process.execPath),"resources","app.asar","package.json")).version)',
  ], { ...env, ELECTRON_RUN_AS_NODE: '1' }, path.join(scratch, 'packaged-version.log'));
  assert.equal(packagedVersion, manifest.version);
  const report = {
    from: previousVersion, to: manifest.version, commit: manifest.commit, passed: true,
    realInstallers: true, realUpdateService: true, preserved: ['Beholdd configuration', 'conversation data', 'model sentinel', 'previous release'],
    busyRestartBlocked: true, oneShotIdleRestartTarget: true, packagedVersion,
    mainUiLaunched: false, realUserProfileTouched: false, modelDownloaded: false,
  };
  await fs.writeFile(path.join(scratch, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  passed = true;
} finally {
  coordinator?.stop();
  for (const service of services) service.stop();
  if (passed && !keep) await fs.rm(scratch, { recursive: true, force: true });
  else console.log(`Isolated updater smoke files retained: ${scratch}`);
}
