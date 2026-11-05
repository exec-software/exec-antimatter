import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertAndroidReleaseReady, importAndroidRelease, prepareAndroidReleaseInput, verifyReleaseChecksums } from '../scripts/lib/android-release.mjs';

const certificate = 'a'.repeat(64);
const write = (file: string, value: string, mode?: number) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value, { mode });
};
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const makeApk = (file: string, changed = false, signed = false, duplicate = false) => {
  mkdirSync(dirname(file), { recursive: true });
  execFileSync('python3', ['-c', `
import sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 z.writestr('AndroidManifest.xml',b'fixture binary manifest')
 z.writestr('classes.dex',b'changed' if sys.argv[2]=='true' else b'fixture dex')
 z.writestr('res/raw/payload.txt',b'fixture resource')
 if sys.argv[3]=='true':
  z.writestr('META-INF/MANIFEST.MF',b'signature manifest')
  z.writestr('META-INF/RELEASE.SF',b'signature metadata')
  z.writestr('META-INF/RELEASE.RSA',b'signature record')
 if sys.argv[4]=='true': z.writestr('classes.dex',b'duplicate')
`, file, String(changed), String(signed), String(duplicate)], { stdio: ['ignore', 'pipe', 'pipe'] });
};

function fixture(t: { after(fn: () => void): void }) {
  const scratch = mkdtempSync(join(tmpdir(), 'antimatter-android-release-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'project');
  const dist = join(root, 'releases/dist');
  write(join(root, 'package.json'), JSON.stringify({ version: '11.0.0', releaseVersion: 'v11' }));
  write(join(root, 'VERSION'), 'v11\n');
  write(join(root, '.gitignore'), 'releases/dist/\nreleases/.dist-*/\nandroid/app/build/\n');
  write(join(root, 'android/app/build.gradle.kts'), 'applicationId = "co.antimatter.app"\nversionName = "11.0.0"\nversionCode = 10008\nbuildToolsVersion = "36.1.0"\n');
  write(join(root, 'android/README.md'), 'Android public v1, package 11.0.0\n');
  write(join(root, 'android/app/src/main/res/values/strings.xml'), '<resources><string name="android_public_version">v1</string></resources>\n');
  write(join(root, 'releases/android-signing.json'), JSON.stringify({ schemaVersion: 1, applicationId: 'co.antimatter.app', publicRelease: 'v1', certificateSha256: certificate }));
  for (const name of ['stage-lich-release.mjs', 'lib/android-release.mjs', 'lib/release-version.mjs']) {
    const destination = join(root, 'scripts', name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(process.cwd(), 'scripts', name), destination);
  }
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Android Release Test']);
  git(['config', 'user.email', 'android-release@example.invalid']);
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'release fixture']);
  git(['tag', 'v11']);
  git(['tag', 'v11.0.0']);
  const commit = git(['rev-parse', 'HEAD']);
  const unsigned = join(root, 'android/app/build/outputs/apk/release/app-release-unsigned.apk');
  makeApk(unsigned);
  const android = prepareAndroidReleaseInput(root, dist, commit);
  write(join(dist, 'model-manifest.json'), '{}\n');
  write(join(dist, 'desktop.tar.gz'), 'existing desktop payload');
  const manifest = {
    schemaVersion: 1, name: 'Antimatter', version: '11.0.0', releaseVersion: 'v11', tag: 'v11.0.0', channel: 'stable', commit,
    platform: { os: 'linux', architecture: 'x86_64' }, android,
    artifacts: [{ name: 'desktop.tar.gz', bytes: 24, sha256: sha(join(dist, 'desktop.tar.gz')) }],
    publishedAssets: ['SHA256SUMS', 'desktop.tar.gz', 'model-manifest.json', 'release-manifest.json'],
  };
  write(join(dist, 'release-manifest.json'), JSON.stringify(manifest));
  write(join(dist, 'SHA256SUMS'), manifest.publishedAssets.filter((name) => name !== 'SHA256SUMS').map((name) => `${sha(join(dist, name))}  ${name}\n`).join(''));
  const signed = join(scratch, 'signed.apk');
  makeApk(signed, false, true);
  const sdk = join(scratch, 'sdk');
  const signer = join(sdk, 'build-tools/36.1.0/apksigner');
  const aapt = join(sdk, 'build-tools/36.1.0/aapt2');
  const signature = `Verified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate DN: CN=Antimatter Android Release\nSigner #1 certificate SHA-256 digest: ${certificate}\n`;
  const badging = "package: name='co.antimatter.app' versionCode='10008' versionName='11.0.0'\napplication: label='Antimatter' icon='res/icon.png'\n";
  const tool = (file: string, output: string, exit = 0) => write(file, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});process.exit(${exit});\n`, 0o755);
  // Tool boundaries are mocked; APK payload comparison uses real ZIPs and Python's ZIP decoder.
  tool(signer, signature);
  tool(aapt, badging);
  const previousSdk = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = sdk;
  t.after(() => { if (previousSdk === undefined) delete process.env.ANDROID_HOME; else process.env.ANDROID_HOME = previousSdk; });
  return { scratch, root, dist, signed, signer, aapt, signature, badging, tool, manifest, commit, git };
}

test('signed Android import binds the exact tested APK to source, signer and publishable checksums', (t) => {
  const box = fixture(t);
  const desktop = sha(join(box.dist, 'desktop.tar.gz'));
  assert.throws(() => assertAndroidReleaseReady(box.root, box.dist, box.manifest), /signature is pending/);
  const android = importAndroidRelease(box.root, box.dist, box.signed);
  assert.equal(android.publicRelease, 'v1');
  assert.equal(android.versionName, '11.0.0');
  assert.equal(android.versionCode, 10008);
  assert.equal(android.sourceCommit, box.commit);
  assert.equal(android.certificateSha256, certificate);
  assert.equal(android.apkSha256, sha(box.signed));
  assert.equal(sha(join(box.dist, 'desktop.tar.gz')), desktop);
  const manifest = read(join(box.dist, 'release-manifest.json'));
  verifyReleaseChecksums(box.dist, manifest);
  assertAndroidReleaseReady(box.root, box.dist, manifest);
  const incoming = join(box.scratch, 'incoming');
  const staged = spawnSync(process.execPath, [join(box.root, 'scripts/stage-lich-release.mjs'), '--incoming', incoming, '--managed', join(box.scratch, 'managed')], { encoding: 'utf8' });
  assert.equal(staged.status, 0, staged.stderr);
  const published = join(incoming, `11.0.0-${box.commit.slice(0, 8)}`);
  assert.equal(existsSync(join(published, android.apk)), true);
  assert.equal(existsSync(join(published, '.android-input')), false, 'unsigned handoff must never be published');
  assert.equal(sha(join(published, android.apk)), android.apkSha256);
});

test('APK signature, signer, package identity and debug checks fail before changing release files', (t) => {
  const box = fixture(t);
  const before = sha(join(box.dist, 'SHA256SUMS'));
  const refuses = (pattern: RegExp) => {
    assert.throws(() => importAndroidRelease(box.root, box.dist, box.signed), pattern);
    assert.equal(sha(join(box.dist, 'SHA256SUMS')), before);
    assert.equal(read(join(box.dist, 'release-manifest.json')).android.status, 'pending-signature');
  };
  box.tool(box.signer, '', 1);
  refuses(/signature verification failed/);
  box.tool(box.signer, box.signature.replace(certificate, 'b'.repeat(64)));
  refuses(/production signer mismatch/);
  box.tool(box.signer, box.signature.replace('CN=Antimatter Android Release', 'CN=Android Debug'));
  refuses(/debug signing certificates/);
  box.tool(box.signer, box.signature.replace(': true', ': false'));
  refuses(/verified v2 or v3 signature/);
  box.tool(box.signer, box.signature);
  for (const [badging, pattern] of [
    [box.badging.replace('co.antimatter.app', 'co.wrong.app'), /APK application ID mismatch/],
    [box.badging.replace('10008', '10007'), /APK version code mismatch/],
    [box.badging.replace('11.0.0', '10.0.0'), /APK version name mismatch/],
    [box.badging + 'application-debuggable\n', /debuggable APK/],
  ] as const) {
    box.tool(box.aapt, badging);
    refuses(pattern);
  }
});

test('a validly signed APK cannot substitute payloads or use duplicate ZIP entries', (t) => {
  const box = fixture(t);
  makeApk(box.signed, true, true);
  assert.throws(() => importAndroidRelease(box.root, box.dist, box.signed), /signed\/unsigned payload mismatch/);
  makeApk(box.signed, false, true, true);
  assert.throws(() => importAndroidRelease(box.root, box.dist, box.signed), /signed APK payload verification failed/);
  assert.equal(read(join(box.dist, 'release-manifest.json')).android.status, 'pending-signature');
});

test('unsigned input tampering, stale source and dirty source cannot be signed into the release', (t) => {
  const box = fixture(t);
  write(join(box.root, 'untracked.txt'), 'unexpected source');
  assert.throws(() => importAndroidRelease(box.root, box.dist, box.signed), /clean release checkout/);
  rmSync(join(box.root, 'untracked.txt'));
  box.git(['commit', '--allow-empty', '--quiet', '-m', 'new revision']);
  assert.throws(() => importAndroidRelease(box.root, box.dist, box.signed), /release source commit mismatch/);
  box.git(['checkout', '--quiet', box.commit]);
  makeApk(join(box.dist, '.android-input/app-release-unsigned.apk'), true);
  assert.throws(() => importAndroidRelease(box.root, box.dist, box.signed), /build receipt unsignedApkSha256 mismatch/);
});

test('publication rejects signed APK or provenance mutation after import', (t) => {
  const box = fixture(t);
  const android = importAndroidRelease(box.root, box.dist, box.signed);
  const manifest = read(join(box.dist, 'release-manifest.json'));
  write(join(box.dist, android.provenance), '{}');
  assert.throws(() => assertAndroidReleaseReady(box.root, box.dist, manifest), /schemaVersion mismatch/);
  assert.throws(() => verifyReleaseChecksums(box.dist, manifest), /SHA-256 mismatch/);
});

test('changing the original APK or release during verification cannot replace snapshotted bytes', (t) => {
  const box = fixture(t);
  const signedHash = sha(box.signed);
  const desktopHash = sha(join(box.dist, 'desktop.tar.gz'));
  write(box.aapt, `#!${process.execPath}\nconst fs=require('node:fs');\nfs.writeFileSync(${JSON.stringify(box.signed)},'replaced download');\nfs.writeFileSync(${JSON.stringify(join(box.dist, 'desktop.tar.gz'))},'replaced desktop');\nfs.writeFileSync(${JSON.stringify(join(box.dist, '.android-input/app-release-unsigned.apk'))},'replaced unsigned');\nprocess.stdout.write(${JSON.stringify(box.badging)});\n`, 0o755);
  const android = importAndroidRelease(box.root, box.dist, box.signed);
  assert.equal(sha(join(box.dist, android.apk)), signedHash);
  assert.equal(sha(join(box.dist, 'desktop.tar.gz')), desktopHash);
  verifyReleaseChecksums(box.dist, read(join(box.dist, 'release-manifest.json')));
});
