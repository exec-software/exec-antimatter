import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_FEED,
  LEGACY_FEED,
  feedCandidates,
  feedReachable,
  networkEndpoint,
  parseLatest,
  parseMounts,
  readLatest,
  readNotes,
  resolveFeed,
} from '../src/main/updates/feed';
import { detectInstallation } from '../src/main/updates/installation';
import { copyVerified } from '../src/main/updates/stage';
import { compareVersions, isNewer, parseVersion } from '../src/main/updates/version';

const scratch = (t: { after(fn: () => unknown): void }, prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

test('versions order by semver precedence, not by string', () => {
  const ordered = ['0.1.0-alpha.1', '0.1.0-alpha.2', '0.1.0-alpha.10', '0.1.0-alpha.beta', '0.1.0-beta', '0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0', '1.0.0'];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(compareVersions(ordered[index - 1], ordered[index]) < 0, `${ordered[index - 1]} < ${ordered[index]}`);
    assert.ok(compareVersions(ordered[index], ordered[index - 1]) > 0);
  }
  assert.equal(compareVersions('0.1.0-alpha.1', 'v0.1.0-alpha.1+build.7'), 0, 'build metadata and a v prefix do not count');
  assert.equal(isNewer('0.1.0-alpha.2', '0.1.0-alpha.1'), true);
  assert.equal(isNewer('0.1.0-alpha.1', '0.1.0-alpha.1'), false);
  assert.equal(parseVersion('0.1'), null);
  assert.throws(() => compareVersions('latest', '0.1.0'), /Cannot compare/);
});

/** A buildd latest-v2 document for one build, with real files behind it. */
function publish(feedRoot: string, version: string, files: Record<string, Buffer | string>, patch: Record<string, unknown> = {}) {
  const folder = `20260914T004743Z__${version}__BLD-505C8FD6-B317-4775-8137-DE58A697F329`;
  const artifactsDir = join(feedRoot, 'builds', folder, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  const artifacts = Object.entries(files).map(([name, content]) => {
    writeFileSync(join(artifactsDir, name), content);
    return { name, relative_path: `artifacts/${name}`, size: Buffer.byteLength(content), sha256: sha(content), executable: name.endsWith('.sh') };
  });
  const document = {
    schema: 'execute.buildd/latest-v2',
    project: 'antimatter',
    generated_at: '2026-09-14T01:04:50.809Z',
    latest: {
      build_id: 'BLD-505C8FD6-B317-4775-8137-DE58A697F329',
      version,
      git_ref: `v${version}`,
      commit: '64d91acc7599a61fc04ceac8d8d9b7fcfd21f955',
      published_at: '2026-09-14T00:47:43.800Z',
      relative_path: `builds/${folder}`,
      pinned: false,
      artifacts,
      ...patch,
    },
  };
  writeFileSync(join(feedRoot, 'latest.json'), JSON.stringify(document));
  return document;
}

test('the feed reads buildd latest.json, verifies release notes, and refuses paths that leave the build', async (t) => {
  const feed = scratch(t, 'antimatter-feed-');
  const notes = '# Antimatter 0.1.0-alpha.2\n\nA model hub.\n';
  const document = publish(feed, '0.1.0-alpha.2', { 'install.sh': "readonly VERSION='0.1.0-alpha.2'\n", 'RELEASE_NOTES.md': notes });

  const build = await readLatest(feed);
  assert.equal(build.version, '0.1.0-alpha.2');
  assert.equal(build.gitRef, 'v0.1.0-alpha.2');
  assert.equal(build.artifacts.get('install.sh')?.executable, true);
  assert.equal(build.artifacts.get('install.sh')?.path, join(build.directory, 'artifacts', 'install.sh'));
  assert.equal(await readNotes(build), notes);

  // Notes that no longer hash to what buildd recorded are not shown.
  writeFileSync(join(build.directory, 'artifacts', 'RELEASE_NOTES.md'), `${notes}tampered\n`);
  assert.equal(await readNotes(build), null);

  const variant = (patch: Record<string, unknown>) => ({ ...document, latest: { ...document.latest, ...patch } });
  assert.throws(() => parseLatest({ ...document, schema: 'execute.buildd/latest-v1' }, feed), /schema/);
  assert.throws(() => parseLatest({ ...document, project: 'snitch' }, feed), /not antimatter/);
  assert.throws(() => parseLatest(variant({ relative_path: '../elsewhere' }), feed), /relative path inside the feed/);
  assert.throws(() => parseLatest(variant({ relative_path: '/etc' }), feed), /relative path inside the feed/);
  assert.throws(() => parseLatest(variant({ relative_path: 'latest' }), feed), /not a published build folder/);
  assert.throws(() => parseLatest(variant({ version: 'nightly' }), feed), /not a semantic version/);
  assert.throws(
    () => parseLatest(variant({ artifacts: [{ name: 'install.sh', relative_path: '../../../install.sh', size: 1, sha256: 'a'.repeat(64) }] }), feed),
    /relative path inside the feed/
  );
  assert.throws(() => parseLatest(variant({ artifacts: [{ name: 'x', relative_path: 'artifacts/x', size: 1, sha256: 'nope' }] }), feed), /SHA-256/);
});

test('a network mount is probed by its server before its path is touched', async () => {
  const table = [
    '/dev/nvme0n1p2 / ext4 rw,relatime 0 0',
    '//releases.example.invalid/builds /mnt/builds cifs rw,soft,vers=3.1.1,addr=192.0.2.85,file_mode=0755 0 0',
    'files.example.invalid:/export /mnt/nfs\\040share nfs4 rw,addr=192.0.2.9 0 0',
    'gvfsd-fuse /run/user/1000/gvfs fuse.gvfsd-fuse rw 0 0',
  ].join('\n');
  const mounts = parseMounts(table);
  assert.equal(mounts[2].target, '/mnt/nfs share', 'octal escapes are decoded');
  assert.deepEqual(networkEndpoint('/mnt/builds/managed/antimatter', mounts), { host: '192.0.2.85', port: 445 });
  assert.deepEqual(networkEndpoint('/mnt/nfs share/antimatter', mounts), { host: '192.0.2.9', port: 2049 });
  assert.equal(networkEndpoint('/run/user/1000/gvfs/smb-share:server=files.example.invalid,share=builds/managed/antimatter', mounts), null);
  assert.equal(networkEndpoint('/home/example/builds', mounts), null);
  assert.equal(networkEndpoint('/mnt/builds-other', mounts), null, 'a sibling with a shared prefix is not inside the mount');

  const probed: string[] = [];
  const probe = async (host: string, port: number) => {
    probed.push(`${host}:${port}`);
    return false;
  };
  assert.equal(await feedReachable('/mnt/builds/managed/antimatter', { mounts: table, probe }), false);
  assert.equal(await feedReachable('/home/example/feed', { mounts: table, probe }), true);
  assert.deepEqual(probed, ['192.0.2.85:445']);
});

test('feed discovery understands the read-only releases share and preserves legacy builds mounts', async (t) => {
  const runtime = scratch(t, 'antimatter-gvfs-');
  const gvfs = join(runtime, 'gvfs');
  const releases = 'smb-share:server=releases.example.invalid,share=releases';
  const builds = 'smb-share:server=releases.example.invalid,share=builds';
  mkdirSync(join(gvfs, releases), { recursive: true });
  mkdirSync(join(gvfs, builds), { recursive: true });
  mkdirSync(join(gvfs, 'smb-share:server=releases.example.invalid,share=weights'), { recursive: true });

  const candidates = await feedCandidates({ XDG_RUNTIME_DIR: runtime }, 4242);
  assert.deepEqual(candidates.slice(0, 2), [DEFAULT_FEED, LEGACY_FEED]);
  assert.deepEqual(
    new Set(candidates.slice(2)),
    new Set([join(gvfs, builds, 'managed', 'antimatter'), join(gvfs, releases, 'antimatter')])
  );
});

test('a configured feed wins; otherwise the first reachable candidate with a latest.json', async (t) => {
  const root = scratch(t, 'antimatter-feeds-');
  const empty = join(root, 'empty');
  const unreachable = join(root, 'unreachable');
  const good = join(root, 'good');
  for (const directory of [empty, unreachable, good]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(unreachable, 'latest.json'), '{}');
  writeFileSync(join(good, 'latest.json'), '{}');
  const reachable = async (path: string) => path !== unreachable;

  assert.deepEqual(await resolveFeed(null, [empty, unreachable, good], reachable), { path: good, configured: false, reachable: true });
  assert.deepEqual(await resolveFeed('/somewhere/chosen', [good], reachable), { path: '/somewhere/chosen', configured: true, reachable: true });
  assert.deepEqual(await resolveFeed(unreachable, [good], reachable), { path: unreachable, configured: true, reachable: false });
  assert.deepEqual(await resolveFeed(null, [empty, unreachable], reachable), { path: unreachable, configured: false, reachable: false }, 'a silent server is named, not "not mounted"');
  assert.deepEqual(await resolveFeed(null, [empty], reachable), { path: null, configured: false, reachable: false });
});

function installedLayout(root: string, version = '0.1.0-alpha.1') {
  const env = {
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_BIN_HOME: join(root, 'bin'),
    PATH: process.env.PATH,
  };
  const release = join(env.XDG_DATA_HOME, 'antimatter', 'releases', version);
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, 'antimatter'), '');
  mkdirSync(env.XDG_BIN_HOME, { recursive: true });
  const launcher = join(env.XDG_BIN_HOME, 'antimatter');
  writeFileSync(launcher, '#!/usr/bin/env bash\n', { mode: 0o700 });
  const receipt = join(env.XDG_STATE_HOME, 'antimatter', 'install.json');
  mkdirSync(join(env.XDG_STATE_HOME, 'antimatter'), { recursive: true });
  writeFileSync(
    receipt,
    JSON.stringify({
      schemaVersion: 2,
      appId: 'co.antimatter.app',
      uid: process.getuid!(),
      currentVersion: version,
      launcher,
      releases: [{ version, path: release, packageSha256: 'a'.repeat(64), payloadManifestSha256: 'b'.repeat(64) }],
    }),
    { mode: 0o600 }
  );
  chmodSync(receipt, 0o600);
  return { env, release, launcher, receipt };
}

test('installation detection: install.sh receipts, AppImages, source checkouts, and anything else', (t) => {
  const root = scratch(t, 'antimatter-install-');
  const { env, release, launcher, receipt } = installedLayout(root);
  const uid = process.getuid!();
  const detect = (patch: Partial<Parameters<typeof detectInstallation>[0]>) =>
    detectInstallation({ isPackaged: true, execPath: join(release, 'antimatter'), version: '0.1.0-alpha.1', env, uid, home: root, ...patch });

  const installed = detect({});
  assert.equal(installed.kind, 'installer');
  assert.equal(installed.canApply, true);
  assert.equal(installed.launcher, launcher);
  assert.equal(installed.installedVersion, '0.1.0-alpha.1');
  assert.equal(installed.receiptPath, receipt);

  assert.equal(detect({ isPackaged: false }).kind, 'development');
  assert.equal(detect({ isPackaged: false }).canApply, false);

  const elsewhere = detect({ execPath: join(root, 'unpacked', 'antimatter') });
  assert.equal(elsewhere.kind, 'unmanaged');
  assert.match(elsewhere.reason!, /not installed by install\.sh/);

  chmodSync(receipt, 0o644);
  assert.equal(detect({}).kind, 'unmanaged', 'a receipt anyone could have written is not trusted');
  chmodSync(receipt, 0o600);

  const appImage = join(root, 'apps', 'Antimatter.AppImage');
  mkdirSync(join(root, 'apps'));
  writeFileSync(appImage, 'ELF');
  const mount = join(root, 'run', '.mount_AntimaXYZ');
  mkdirSync(mount, { recursive: true });
  writeFileSync(join(mount, 'antimatter'), '');
  const portable = detect({ env: { ...env, APPIMAGE: appImage, APPDIR: mount }, execPath: join(mount, 'antimatter') });
  assert.equal(portable.kind, 'appimage');
  assert.equal(portable.appImage, appImage);
  assert.equal(portable.canApply, true);

  // Opened from the terminal of some other AppImage, the installed copy inherits that image's variables.
  const editor = join(root, 'run', '.mount_CursorABC');
  mkdirSync(editor);
  writeFileSync(join(root, 'apps', 'Cursor.AppImage'), 'ELF');
  const inherited = detect({ env: { ...env, APPIMAGE: join(root, 'apps', 'Cursor.AppImage'), APPDIR: editor } });
  assert.equal(inherited.kind, 'installer', 'another program’s AppImage is never the one to replace');
  assert.equal(detect({ env: { ...env, APPIMAGE: appImage }, execPath: join(mount, 'antimatter') }).kind, 'unmanaged', 'APPIMAGE without its APPDIR proves nothing');
});

test('copies from the share resume from a partial file and are verified whole before they exist', async (t) => {
  const root = scratch(t, 'antimatter-stage-');
  const content = randomBytes(3 * 1024 * 1024 + 17);
  const source = join(root, 'share', 'Antimatter.tar.gz');
  mkdirSync(join(root, 'share'));
  writeFileSync(source, content);
  const artifact = { name: 'Antimatter.tar.gz', path: source, size: content.length, sha256: sha(content), executable: false };
  const destination = join(root, 'stage', 'Antimatter.tar.gz');

  mkdirSync(join(root, 'stage'));
  writeFileSync(`${destination}.part`, content.subarray(0, 1024 * 1024));
  let last = 0;
  assert.deepEqual(await copyVerified(artifact, destination, { onBytes: (bytes) => (last = bytes) }), { reused: false });
  assert.deepEqual(readFileSync(destination), content);
  assert.equal(last, content.length);
  assert.equal(existsSync(`${destination}.part`), false);
  assert.equal(statSync(destination).mode & 0o777, 0o644);

  assert.deepEqual(await copyVerified(artifact, destination), { reused: true }, 'an already verified copy is kept');

  const wrong = { ...artifact, sha256: 'f'.repeat(64) };
  rmSync(destination);
  await assert.rejects(copyVerified(wrong, destination), /did not match the SHA-256/);
  assert.equal(existsSync(destination) || existsSync(`${destination}.part`), false, 'a copy that fails verification is discarded');

  await assert.rejects(copyVerified({ ...artifact, size: content.length + 1 }, destination), /buildd published/);
  await assert.rejects(copyVerified({ ...artifact, path: join(root, 'share', 'missing') }, destination), /missing from the releases share/);
});
