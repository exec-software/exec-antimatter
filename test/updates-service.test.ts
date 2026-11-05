import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { replaceAppImage } from '../src/main/updates/apply';
import { detectInstallation } from '../src/main/updates/installation';
import { RELAUNCH_SHELL, relaunchAfterExit, relaunchArguments } from '../src/main/updates/restart';
import { UpdateService, type UpdateState } from '../src/main/updates/service';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const uid = process.getuid!();

/**
 * Stands in for releases/linux-x86_64/install.sh: same arguments, same effects on the layout —
 * a release folder, the `current` link moved in one rename, and a receipt listing both releases.
 */
const fakeInstaller = (version: string, exitCode = 0) => `#!/usr/bin/env bash
# Managed by the Antimatter user-local installer.
set -Eeuo pipefail
readonly VERSION='${version}'
[[ $# -eq 5 && $1 == --skip-model && $2 == --package && -f $3 && $4 == --checksums && -f $5 ]] || { echo "unexpected arguments: $*"; exit 64; }
here=$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd -P)
for sibling in uninstall.sh beholdd.streaming.yaml co.antimatter.app.svg; do [[ -f $here/$sibling ]] || { echo "missing $sibling"; exit 65; }; done
echo "Antimatter: installing $VERSION from $3"
if (( ${exitCode} != 0 )); then echo "Antimatter: error: simulated failure"; exit ${exitCode}; fi
data="$XDG_DATA_HOME/antimatter"
mkdir -p "$data/releases/$VERSION"
: > "$data/releases/$VERSION/antimatter"
ln -s "$data/releases/$VERSION" "$data/.current.$$"
mv -Tf "$data/.current.$$" "$data/current"
python3 - "$XDG_STATE_HOME/antimatter/install.json" "$VERSION" "$data/releases/$VERSION" <<'PY'
import json, os, sys
path, version, release = sys.argv[1:]
with open(path) as handle:
    receipt = json.load(handle)
receipt["currentVersion"] = version
receipt["releases"] = [entry for entry in receipt["releases"] if entry["version"] != version] + [{"version": version, "path": release}]
temporary = path + ".tmp"
with open(temporary, "w") as handle:
    json.dump(receipt, handle)
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY
echo "Antimatter: Antimatter $VERSION is installed"
`;

interface Sandbox {
  root: string;
  env: NodeJS.ProcessEnv;
  feed: string;
  receipt: string;
  launcher: string;
  cache: string;
  userData: string;
  archive: Buffer;
}

function sandbox(t: { after(fn: () => unknown): void }, options: { exitCode?: number; corrupt?: boolean } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-updates-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_BIN_HOME: join(root, 'bin'),
    ELECTRON_RUN_AS_NODE: '1',
  };

  // Antimatter 0.1.0-alpha.1, installed.
  const release = join(env.XDG_DATA_HOME!, 'antimatter', 'releases', '0.1.0-alpha.1');
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, 'antimatter'), '');
  mkdirSync(env.XDG_BIN_HOME!, { recursive: true });
  const launcher = join(env.XDG_BIN_HOME!, 'antimatter');
  writeFileSync(launcher, '#!/usr/bin/env bash\n', { mode: 0o700 });
  mkdirSync(join(env.XDG_STATE_HOME!, 'antimatter'), { recursive: true });
  const receipt = join(env.XDG_STATE_HOME!, 'antimatter', 'install.json');
  writeFileSync(
    receipt,
    JSON.stringify({ schemaVersion: 2, appId: 'co.antimatter.app', uid, currentVersion: '0.1.0-alpha.1', launcher, releases: [{ version: '0.1.0-alpha.1', path: release }] })
  );
  chmodSync(receipt, 0o600);

  // buildd has published 0.1.0-alpha.2.
  const feed = join(root, 'share', 'managed', 'antimatter');
  const folder = '20260915T120000Z__0.1.0-alpha.2__BLD-11111111-2222-3333-4444-555555555555';
  const artifactsDir = join(feed, 'builds', folder, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  const archive = randomBytes(2 * 1024 * 1024);
  const files: Record<string, Buffer | string> = {
    'install.sh': fakeInstaller('0.1.0-alpha.2', options.exitCode),
    'uninstall.sh': '#!/usr/bin/env bash\n',
    'beholdd.streaming.yaml': 'models: []\n',
    'co.antimatter.app.svg': '<svg/>',
    'Antimatter-0.1.0-alpha.2-linux-x86_64.tar.gz': archive,
    'Antimatter-0.1.0-alpha.2-linux-x86_64.AppImage': randomBytes(4096),
    'RELEASE_NOTES.md': '# Antimatter 0.1.0-alpha.2\n\nUpdates from the configured feed.\n',
  };
  files.SHA256SUMS = `${sha(archive)}  Antimatter-0.1.0-alpha.2-linux-x86_64.tar.gz\n`;
  const artifacts = Object.entries(files).map(([name, content]) => {
    writeFileSync(join(artifactsDir, name), content);
    return {
      name,
      relative_path: `artifacts/${name}`,
      size: Buffer.byteLength(content),
      sha256: options.corrupt && name.endsWith('.tar.gz') ? sha('something else') : sha(content),
      executable: name.endsWith('.sh') || name.endsWith('.AppImage'),
    };
  });
  writeFileSync(
    join(feed, 'latest.json'),
    JSON.stringify({
      schema: 'execute.buildd/latest-v2',
      project: 'antimatter',
      latest: {
        build_id: 'BLD-11111111-2222-3333-4444-555555555555',
        version: '0.1.0-alpha.2',
        git_ref: 'v0.1.0-alpha.2',
        commit: 'c'.repeat(40),
        published_at: '2026-09-15T12:00:00.000Z',
        relative_path: `builds/${folder}`,
        pinned: false,
        artifacts,
      },
    })
  );

  return { root, env, feed, receipt, launcher, cache: join(root, 'cache', 'antimatter', 'updates'), userData: join(root, 'userData'), archive };
}

function service(box: Sandbox, patch: {
  running?: string;
  packaged?: boolean;
  reachable?: boolean | (() => Promise<boolean>);
  automatic?: boolean;
  configured?: boolean;
  onState?(state: UpdateState): void;
} = {}) {
  const states: UpdateState[] = [];
  const automaticReady: string[] = [];
  const running = patch.running ?? '0.1.0-alpha.1';
  if (!existsSync(join(box.userData, 'updates.json'))) {
    mkdirSync(box.userData, { recursive: true });
    writeFileSync(join(box.userData, 'updates.json'), JSON.stringify({
      version: 1, feedPath: patch.configured === false ? null : box.feed,
      automatic: patch.automatic !== false, lastCheckedAt: null,
    }));
  }
  const updates = new UpdateService({
    userData: box.userData,
    cacheRoot: box.cache,
    detect: () =>
      detectInstallation({
        isPackaged: patch.packaged ?? true,
        execPath: join(box.env.XDG_DATA_HOME!, 'antimatter', 'releases', running, 'antimatter'),
        version: running,
        env: box.env,
        uid,
        home: box.root,
      }),
    env: box.env,
    uid,
    send: (state) => { states.push(state); patch.onState?.(state); },
    onAutomaticReady: (state) => automaticReady.push(state.readyVersion!),
    candidates: () => [box.feed],
    reachable: async () => typeof patch.reachable === 'function' ? patch.reachable() : patch.reachable ?? true,
  });
  return { updates, states, automaticReady };
}

for (const kind of ['installer', 'appimage'] as const) {
  test(`${kind} discovery cannot install automatically or manually until its feed is explicitly selected`, async (t) => {
    const box = sandbox(t);
    const image = join(box.root, 'Antimatter.AppImage');
    if (kind === 'appimage') {
      writeFileSync(image, 'old image');
      box.env.APPIMAGE = image;
      box.env.APPDIR = join(box.env.XDG_DATA_HOME!, 'antimatter', 'releases', '0.1.0-alpha.1');
    }
    const { updates, states, automaticReady } = service(box, { configured: false });
    const offered = await updates.check();
    assert.equal(offered.install.kind, kind);
    assert.equal(offered.status, 'available');
    assert.equal(offered.feed.configured, false);
    assert.equal(offered.automatic, true);
    updates.setAutomatic(true);
    const refused = await updates.apply();
    assert.equal(refused.status, 'failed');
    assert.match(refused.error ?? '', /Choose a trusted release folder/);
    assert.equal(existsSync(box.cache), false);
    assert.equal(JSON.parse(readFileSync(box.receipt, 'utf8')).currentVersion, '0.1.0-alpha.1');
    if (kind === 'appimage') assert.equal(readFileSync(image, 'utf8'), 'old image');
    assert.equal(states.some((state) => ['downloading', 'installing', 'ready'].includes(state.status)), false);
    assert.deepEqual(automaticReady, []);

    updates.setFeed(box.feed);
    assert.equal(JSON.parse(readFileSync(join(box.userData, 'updates.json'), 'utf8')).feedPath, box.feed);
    const installed = await updates.check();
    assert.equal(installed.status, 'ready', installed.error ?? undefined);
    assert.equal(installed.readyVersion, '0.1.0-alpha.2');
    if (kind === 'appimage') assert.notEqual(readFileSync(image, 'utf8'), 'old image');
    else assert.equal(JSON.parse(readFileSync(box.receipt, 'utf8')).currentVersion, '0.1.0-alpha.2');
  });
}

test('clearing a trusted selection does not transfer trust to the same discovered feed', async (t) => {
  const box = sandbox(t);
  const { updates } = service(box, { automatic: false });
  assert.equal((await updates.check()).feed.configured, true);
  updates.setFeed(null);
  updates.setAutomatic(true);
  const state = await updates.apply();
  assert.equal(state.feed.path, box.feed);
  assert.equal(state.feed.configured, false);
  assert.equal(state.status, 'failed');
  assert.match(state.error ?? '', /Choose a trusted release folder/);
  assert.equal(existsSync(box.cache), false);
  assert.equal(JSON.parse(readFileSync(box.receipt, 'utf8')).currentVersion, '0.1.0-alpha.1');
});

for (const reselect of [false, true]) {
  test(`changing the selected feed discards an in-flight check${reselect ? ' even when the original path is reselected' : ''}`, async (t) => {
    const box = sandbox(t);
    let reached!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { updates, states } = service(box, { reachable: async () => { reached(); await held; return true; } });
    const pending = updates.check();
    await entered;
    updates.setFeed(null);
    if (reselect) updates.setFeed(box.feed);
    release();
    const stale = await pending;
    assert.equal(stale.status, 'idle');
    assert.equal(stale.available, null);
    assert.equal(existsSync(box.cache), false);
    assert.equal(states.some((state) => ['downloading', 'installing', 'ready'].includes(state.status)), false);
    if (!reselect) {
      assert.equal((await updates.check()).status, 'available');
      assert.equal(existsSync(box.cache), false);
    }
  });
}

test('revoking feed trust immediately before installer launch cancels the old operation', async (t) => {
  const box = sandbox(t);
  const { updates } = service(box, { onState: (state) => {
    if (state.status === 'installing') updates.setFeed(null);
  } });
  const state = await updates.check();
  assert.equal(state.feed.configured, false);
  assert.equal(state.status, 'idle');
  assert.equal(JSON.parse(readFileSync(box.receipt, 'utf8')).currentVersion, '0.1.0-alpha.1');
  assert.equal(existsSync(join(box.env.XDG_DATA_HOME!, 'antimatter', 'releases', '0.1.0-alpha.2')), false);
});

test('relative or empty saved feed paths confer no trust and invalid selections are rejected', async (t) => {
  for (const invalid of ['relative/feed', '']) {
    const box = sandbox(t);
    mkdirSync(box.userData, { recursive: true });
    writeFileSync(join(box.userData, 'updates.json'), JSON.stringify({ version: 1, feedPath: invalid, automatic: true }));
    const { updates } = service(box);
    assert.equal((await updates.check()).feed.configured, false);
    assert.throws(() => updates.setFeed(invalid), /absolute path/);
    assert.equal((await updates.apply()).status, 'failed');
    assert.equal(existsSync(box.cache), false);
  }
});

test('a feed selection must be saved successfully before it can authorize installation', async (t) => {
  const box = sandbox(t);
  const { updates } = service(box, { configured: false });
  t.mock.method(console, 'error', () => {});
  rmSync(box.userData, { recursive: true });
  writeFileSync(box.userData, 'prevents settings directory creation');
  assert.throws(() => updates.setFeed(box.feed), /could not be saved/);
  assert.equal(updates.state().feed.configured, false);
  assert.equal((await updates.check()).status, 'available');
  assert.equal((await updates.apply()).status, 'failed');
  assert.equal(existsSync(box.cache), false);
});

test('an installed copy finds the newer build, installs it, and offers one safe automatic restart', async (t) => {
  const box = sandbox(t);
  const { updates, states, automaticReady } = service(box);

  const state = await updates.check();
  assert.equal(state.status, 'ready', state.error ?? undefined);
  assert.equal(state.readyVersion, '0.1.0-alpha.2');
  assert.equal(state.feed.path, box.feed);
  assert.equal(state.available, null);
  assert.deepEqual(automaticReady, ['0.1.0-alpha.2']);

  const seen = [...new Set(states.map((entry) => entry.status))];
  assert.deepEqual(seen, ['checking', 'available', 'downloading', 'installing', 'ready']);
  const offered = states.find((entry) => entry.status === 'available')!;
  assert.equal(offered.available?.version, '0.1.0-alpha.2');
  assert.match(offered.available?.notes ?? '', /Updates from the configured feed/);

  const receipt = JSON.parse(readFileSync(box.receipt, 'utf8'));
  assert.equal(receipt.currentVersion, '0.1.0-alpha.2');
  const current = join(box.env.XDG_DATA_HOME!, 'antimatter', 'current');
  assert.ok(lstatSync(current).isSymbolicLink());
  assert.equal(realpathSync(current), realpathSync(join(box.env.XDG_DATA_HOME!, 'antimatter', 'releases', '0.1.0-alpha.2')));

  assert.deepEqual(updates.restartTarget(['--class=Antimatter', '--ozone-platform=wayland']), { execPath: box.launcher, args: ['--ozone-platform=wayland'] });
  assert.deepEqual(readdirSync(box.cache), ['last-install.log'], 'the staged copy is removed once installed');
  assert.match(readFileSync(join(box.cache, 'last-install.log'), 'utf8'), /0\.1\.0-alpha\.2 is installed/);

  // Repeated starts do not duplicate the offer. Claiming it records the old/new pair before the
  // desktop launches a helper, so coming back up in the old binary cannot form a restart loop.
  updates.start();
  updates.start();
  updates.stop();
  assert.deepEqual(automaticReady, ['0.1.0-alpha.2']);
  assert.equal(updates.claimAutomaticRestart('0.1.0-alpha.2'), true);
  assert.equal(updates.claimAutomaticRestart('0.1.0-alpha.2'), false);
  const attempted = JSON.parse(readFileSync(join(box.userData, 'updates.json'), 'utf8'));
  assert.deepEqual(attempted.automaticRestartAttempt, {
    fromVersion: '0.1.0-alpha.1',
    toVersion: '0.1.0-alpha.2',
  });

  const againService = service(box);
  const again = againService.updates;
  assert.equal(again.state().status, 'ready');
  again.start();
  again.stop();
  assert.deepEqual(againService.automaticReady, [], 'the attempted pair is not offered by the old binary again');
  assert.match(again.state().restart.error ?? '', /already attempted/);
  assert.equal(again.state().readyVersion, '0.1.0-alpha.2');
  assert.equal((await again.check()).status, 'ready', 'nothing newer than what is waiting to restart');

  // After the restart, the running version is the new one, the latch is cleared, and there is
  // nothing to do.
  const restarted = service(box, { running: '0.1.0-alpha.2' }).updates;
  assert.equal(JSON.parse(readFileSync(join(box.userData, 'updates.json'), 'utf8')).automaticRestartAttempt, null);
  assert.equal((await restarted.check()).status, 'current');
  assert.equal(restarted.restartTarget(), null);
});

test('with automatic updates off it neither installs nor requests a restart until explicitly enabled', async (t) => {
  const box = sandbox(t, { exitCode: 3 });
  const { updates, automaticReady } = service(box, { automatic: false });

  const offered = await updates.check();
  assert.equal(offered.status, 'available');
  assert.equal(offered.automatic, false);
  assert.equal(existsSync(box.cache), false, 'nothing is copied until asked');

  const failed = await updates.apply();
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /install\.sh exited with 3[\s\S]*simulated failure/);
  assert.ok(failed.logPath && existsSync(failed.logPath));
  assert.equal(JSON.parse(readFileSync(box.receipt, 'utf8')).currentVersion, '0.1.0-alpha.1', 'a failed install changes nothing');
  const staged = readdirSync(box.cache).find((entry) => entry.includes('__'))!;
  assert.ok(existsSync(join(box.cache, staged, 'Antimatter-0.1.0-alpha.2-linux-x86_64.tar.gz')), 'the verified copy is kept for the retry');

  // Fix the installer on the share (a new build would do this) and retry from the staged copy.
  const installer = join(box.feed, 'builds', readdirSync(join(box.feed, 'builds'))[0], 'artifacts', 'install.sh');
  const fixed = fakeInstaller('0.1.0-alpha.2');
  writeFileSync(installer, fixed);
  const latest = JSON.parse(readFileSync(join(box.feed, 'latest.json'), 'utf8'));
  for (const artifact of latest.latest.artifacts) {
    if (artifact.name === 'install.sh') Object.assign(artifact, { size: Buffer.byteLength(fixed), sha256: sha(fixed) });
  }
  writeFileSync(join(box.feed, 'latest.json'), JSON.stringify(latest));
  await updates.check();
  const retried = await updates.apply();
  assert.equal(retried.status, 'ready', retried.error ?? undefined);
  assert.deepEqual(automaticReady, []);
  updates.setAutomatic(true);
  assert.deepEqual(automaticReady, ['0.1.0-alpha.2']);
});

test('from source it reports what is published but installs nothing; unreachable shares are offline, not failures', async (t) => {
  const box = sandbox(t);
  const development = service(box, { packaged: false }).updates;
  const state = await development.check();
  assert.equal(state.status, 'available');
  assert.equal(state.install.kind, 'development');
  assert.equal(existsSync(box.cache), false);
  assert.equal((await development.apply()).status, 'failed');

  const offline = await service(box, { reachable: false }).updates.check();
  assert.equal(offline.status, 'offline');
  assert.match(offline.error ?? '', /not reachable/);
});

test('an artifact that does not match its published SHA-256 is never installed', async (t) => {
  const box = sandbox(t, { corrupt: true });
  const state = await service(box).updates.check();
  assert.equal(state.status, 'failed');
  assert.match(state.error ?? '', /did not match the SHA-256/);
  assert.equal(JSON.parse(readFileSync(box.receipt, 'utf8')).currentVersion, '0.1.0-alpha.1');
});

test('an AppImage is replaced in one rename, only once the new one verifies', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-appimage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'Antimatter.AppImage');
  writeFileSync(target, 'old image');
  const next = randomBytes(100_000);
  const source = join(root, 'share.AppImage');
  writeFileSync(source, next);

  await assert.rejects(
    replaceAppImage({ name: 'Antimatter.AppImage', path: source, size: next.length, sha256: 'e'.repeat(64), executable: true }, target),
    /did not match/
  );
  assert.equal(readFileSync(target, 'utf8'), 'old image');

  await replaceAppImage({ name: 'Antimatter.AppImage', path: source, size: next.length, sha256: sha(next), executable: true }, target);
  assert.deepEqual(readFileSync(target), next);
  assert.equal(lstatSync(target).mode & 0o777, 0o755);
  assert.equal(existsSync(`${target}.update`), false);
});

test('an AppImage stays untouched when copying is cancelled after the last verified byte', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-appimage-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'Antimatter.AppImage');
  writeFileSync(target, 'old image');
  const next = randomBytes(4096);
  writeFileSync(`${target}.update`, next);
  const controller = new AbortController();
  await assert.rejects(replaceAppImage({
    name: 'Antimatter.AppImage', path: join(root, 'unused-source'),
    size: next.length, sha256: sha(next), executable: true,
  }, target, { signal: controller.signal, onBytes: () => controller.abort() }), /aborted/i);
  assert.equal(readFileSync(target, 'utf8'), 'old image');
});

test('a restart opens the new version only after this process has exited, with its arguments', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-restart-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const started = join(root, 'started');
  const target = join(root, 'Antimatter.AppImage');
  writeFileSync(
    target,
    `#!/bin/sh\nfor arg in "$@"; do printf '[%s]' "$arg"; done > "${started}.args"\nenv > "${started}.env"\nmv "${started}.args" "${started}"\n`,
    { mode: 0o755 }
  );
  const running = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => running.kill('SIGKILL'));
  await once(running, 'spawn');

  const env = { PATH: process.env.PATH, KEPT: 'yes', APPIMAGE: '/apps/Old.AppImage', APPDIR: '/tmp/.mount_Old', ELECTRON_RUN_AS_NODE: '1' };
  await relaunchAfterExit({ execPath: target, args: ['--remote-debugging-port=9225', 'two words'] }, env, running.pid);
  await delay(700);
  assert.equal(existsSync(started), false, 'nothing opens beside the copy that is still running');

  running.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (!existsSync(started) && Date.now() < deadline) await delay(50);
  assert.equal(readFileSync(started, 'utf8'), '[--remote-debugging-port=9225][two words]');
  const seen = readFileSync(`${started}.env`, 'utf8');
  assert.match(seen, /^KEPT=yes$/m);
  assert.doesNotMatch(seen, /^(APPIMAGE|APPDIR|ELECTRON_RUN_AS_NODE)=/m, 'the old mount and launch mode are not handed on');
});

test('a restart helper spawn failure is acknowledged before the caller exits', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-restart-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    relaunchAfterExit({ execPath: join(root, 'antimatter'), args: [] }, process.env, process.pid, join(root, 'missing-shell')),
    /ENOENT/
  );
});

test('the relaunching shell holds on to nothing the old copy had open', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-restart-fds-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = join(root, 'descriptors');
  const target = join(root, 'antimatter');
  writeFileSync(target, `#!/bin/bash\n[ -e /proc/$$/fd/7 ] && echo "7 open" > "${report}" || echo "7 closed" > "${report}"\n`, { mode: 0o755 });
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(exited, 'close');

  // A descriptor without close-on-exec, as Chromium leaves its DevTools listener, held by the process that asks to restart.
  const holder = spawn('/bin/bash', ['-c', 'exec 7<>"$1"; shift; exec "$@"', 'holder', join(root, 'held'), RELAUNCH_SHELL, ...relaunchArguments({ execPath: target, args: [] }, exited.pid!)], {
    stdio: 'ignore',
  });
  await once(holder, 'close');
  assert.equal(readFileSync(report, 'utf8'), '7 closed\n');
});
