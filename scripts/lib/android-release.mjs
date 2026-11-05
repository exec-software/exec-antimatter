import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const same = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`Android ${label} mismatch: expected ${expected}, found ${actual}`);
};
const regularFile = (file) => {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing regular Android release file: ${file}`);
};

export function androidReleaseIdentity(root) {
  const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle.kts'), 'utf8');
  const policy = json(path.join(root, 'releases/android-signing.json'));
  const identity = {
    publicRelease: policy.publicRelease,
    applicationId: gradle.match(/^\s*applicationId = "([^"]+)"$/m)?.[1],
    versionName: gradle.match(/^\s*versionName = "([^"]+)"$/m)?.[1],
    versionCode: Number(gradle.match(/^\s*versionCode = (\d+)$/m)?.[1]),
  };
  same(policy.schemaVersion, 1, 'signing policy schema');
  same(identity.applicationId, policy.applicationId, 'application ID policy');
  same(identity.versionName, json(path.join(root, 'package.json')).version, 'desktop compatibility version');
  const strings = fs.readFileSync(path.join(root, 'android/app/src/main/res/values/strings.xml'), 'utf8');
  same(strings.match(/<string\s+name="android_public_version">([^<]+)<\/string>/)?.[1], identity.publicRelease, 'visible public version');
  if (!/^v[1-9]\d*$/.test(identity.publicRelease ?? '') || !identity.applicationId || !Number.isSafeInteger(identity.versionCode) || identity.versionCode < 1) {
    throw new Error('Invalid Android release identity');
  }
  return identity;
}

export function prepareAndroidReleaseInput(root, dist, commit) {
  const identity = androidReleaseIdentity(root);
  const source = path.join(root, 'android/app/build/outputs/apk/release/app-release-unsigned.apk');
  regularFile(source);
  const input = path.join(dist, '.android-input');
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  const apk = path.join(input, 'app-release-unsigned.apk');
  fs.copyFileSync(source, apk);
  fs.chmodSync(apk, 0o600);
  fs.copyFileSync(path.join(root, 'android/README.md'), path.join(input, 'ANDROID_README.md'));
  const receipt = { schemaVersion: 1, sourceCommit: commit, ...identity, unsignedApkSha256: digest(apk), readmeSha256: digest(path.join(input, 'ANDROID_README.md')) };
  writeJson(path.join(input, 'receipt.json'), receipt);
  return { required: true, status: 'pending-signature', ...receipt };
}

export function androidAssetNames(identity) {
  return {
    apk: `Antimatter-Android-${identity.publicRelease}-${identity.versionName}.apk`,
    provenance: 'android-release.json',
    readme: 'ANDROID_README.md',
  };
}

// Releases before the combined desktop/mobile contract remain valid historical inputs.
export function requiresAndroidRelease(manifest) {
  return Number(String(manifest.version).split('.')[0]) >= 11 || manifest.android?.required === true;
}

export function assertAndroidReleaseReady(root, dist, manifest) {
  if (!requiresAndroidRelease(manifest)) return;
  const android = manifest.android;
  if (android?.required !== true || android.status !== 'signed') {
    throw new Error('Android production signature is pending; import the verified signed APK before publishing or staging this release');
  }
  const identity = androidReleaseIdentity(root);
  const policy = json(path.join(root, 'releases/android-signing.json'));
  if (!/^[0-9a-f]{64}$/.test(policy.certificateSha256 ?? '')) throw new Error('Android production signing certificate is not pinned');
  const names = androidAssetNames(identity);
  for (const name of Object.values(names)) {
    if (!manifest.publishedAssets.includes(name)) throw new Error(`Android published assets missing ${name}`);
    regularFile(path.join(dist, name));
  }
  const provenance = json(path.join(dist, names.provenance));
  for (const [key, expected] of Object.entries({ schemaVersion: 1, ...identity, sourceCommit: manifest.commit, certificateSha256: policy.certificateSha256 })) {
    same(provenance[key], expected, key);
    same(android[key], expected, `manifest ${key}`);
  }
  same(android.apk, names.apk, 'APK filename');
  same(android.provenance, names.provenance, 'provenance filename');
  same(android.provenanceSha256, digest(path.join(dist, names.provenance)), 'provenance SHA-256');
  same(provenance.apkSha256, digest(path.join(dist, names.apk)), 'signed APK SHA-256');
  same(android.apkSha256, provenance.apkSha256, 'manifest APK SHA-256');
  same(android.unsignedApkSha256, provenance.unsignedApkSha256, 'manifest unsigned APK SHA-256');
  same(provenance.readmeSha256, digest(path.join(dist, names.readme)), 'mobile README SHA-256');
  same(android.readmeSha256, provenance.readmeSha256, 'manifest mobile README SHA-256');
  if (!/^[0-9a-f]{64}$/.test(provenance.unsignedApkSha256 ?? '') || provenance.verification?.identicalUnsignedPayload !== true) {
    throw new Error('Android provenance lacks verified unsigned build payload');
  }
  const artifact = manifest.artifacts?.find((entry) => entry.name === names.apk);
  same(artifact?.sha256, provenance.apkSha256, 'primary artifact SHA-256');
  same(artifact?.bytes, fs.statSync(path.join(dist, names.apk)).size, 'primary artifact size');
}

export function verifyReleaseChecksums(dist, manifest) {
  const expected = [...manifest.publishedAssets].sort();
  if (new Set(expected).size !== expected.length || expected.some((name) => typeof name !== 'string' || path.basename(name) !== name)) throw new Error('Invalid published asset allowlist');
  const present = fs.readdirSync(dist, { withFileTypes: true }).filter((entry) => !entry.isDirectory()).map((entry) => entry.name).sort();
  same(JSON.stringify(present), JSON.stringify(expected), 'release asset allowlist');
  const sums = new Map();
  for (const line of fs.readFileSync(path.join(dist, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
    if (!match || sums.has(match[2])) throw new Error('Invalid or duplicate Android import checksum entry');
    sums.set(match[2], match[1]);
  }
  same(JSON.stringify([...sums.keys()].sort()), JSON.stringify(expected.filter((name) => name !== 'SHA256SUMS')), 'release checksum coverage');
  for (const [name, sha] of sums) {
    regularFile(path.join(dist, name));
    same(digest(path.join(dist, name)), sha, `${name} SHA-256`);
  }
}

function androidTools(root) {
  const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle.kts'), 'utf8');
  const version = gradle.match(/^\s*buildToolsVersion = "([^"]+)"$/m)?.[1];
  const properties = path.join(root, 'android/local.properties');
  const localSdk = fs.existsSync(properties)
    ? fs.readFileSync(properties, 'utf8').match(/^sdk\.dir=(.+)$/m)?.[1].replace(/\\([\\: ])/g, '$1')
    : undefined;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || localSdk || path.join(os.homedir(), 'Android/Sdk');
  if (!version) throw new Error('Android build-tools version is not pinned');
  const directory = path.join(sdk, 'build-tools', version);
  const tools = { apksigner: path.join(directory, 'apksigner'), aapt2: path.join(directory, 'aapt2'), version };
  regularFile(tools.apksigner);
  regularFile(tools.aapt2);
  return tools;
}

function capture(command, args, label) {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim(); }
  catch { throw new Error(`Android ${label} failed; no release artifacts were changed`); }
}

// APK signing/alignment can change ZIP metadata and add signature entries, but must not change
// AndroidManifest.xml, resources, DEX, native libraries, or any other unsigned build payload.
const PAYLOAD_DIGESTS = `
import hashlib,json,re,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    result={}; total=0; seen=set()
    for entry in archive.infolist():
        name=entry.filename
        if name in seen or name.startswith('/') or '\\\\' in name or '..' in name.split('/'):
            raise ValueError('unsafe or duplicate APK entry')
        seen.add(name)
        if len(seen)>100000 or entry.flag_bits & 1: raise ValueError('unsupported APK entry')
        if entry.is_dir(): continue
        total+=entry.file_size
        if entry.file_size>134217728 or total>536870912: raise ValueError('APK payload too large')
        if re.fullmatch(r'META-INF/(?:MANIFEST\\.MF|[^/]+\\.(?:SF|RSA|DSA|EC))',name,re.I): continue
        result[name]=hashlib.sha256(archive.read(entry)).hexdigest()
    if 'AndroidManifest.xml' not in result or 'classes.dex' not in result: raise ValueError('incomplete APK')
    print(json.dumps(result,sort_keys=True))
`;

function completeAndroidRelease(root, dist, signedApk) {
  regularFile(signedApk);
  const manifest = json(path.join(dist, 'release-manifest.json'));
  verifyReleaseChecksums(dist, manifest);
  const commit = capture('git', ['-C', root, 'rev-parse', 'HEAD'], 'source revision lookup');
  if (capture('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], 'source cleanliness check')) throw new Error('Android import requires a clean release checkout');
  same(manifest.commit, commit, 'release source commit');
  const identity = androidReleaseIdentity(root);
  same(manifest.version, identity.versionName, 'release package version');
  const input = path.join(dist, '.android-input');
  const unsignedApk = path.join(input, 'app-release-unsigned.apk');
  regularFile(unsignedApk);
  const receipt = json(path.join(input, 'receipt.json'));
  for (const [key, expected] of Object.entries({ schemaVersion: 1, sourceCommit: commit, ...identity, unsignedApkSha256: digest(unsignedApk), readmeSha256: digest(path.join(input, 'ANDROID_README.md')) })) {
    same(receipt[key], expected, `build receipt ${key}`);
    same(manifest.android?.[key], expected, `pending manifest ${key}`);
  }
  const policy = json(path.join(root, 'releases/android-signing.json'));
  if (!/^[0-9a-f]{64}$/.test(policy.certificateSha256 ?? '')) throw new Error('Android production signing certificate is not pinned');
  const tools = androidTools(root);
  const signature = capture(tools.apksigner, ['verify', '--verbose', '--print-certs', signedApk], 'signature verification');
  const signers = [...signature.matchAll(/^Signer #(\d+) certificate SHA-256 digest: ([0-9a-f]{64})$/gmi)];
  if (signers.length !== 1 || signers[0][1] !== '1') throw new Error('Android APK must have exactly one pinned production signer');
  same(signers[0][2].toLowerCase(), policy.certificateSha256, 'production signer');
  if (/^Signer #\d+ certificate DN:.*(?:CN=Android Debug|CN=AndroidDebug)/mi.test(signature)) throw new Error('Android debug signing certificates cannot be released');
  if (!/^Verified using v[23](?:\.\d+)? scheme .*: true$/mi.test(signature)) throw new Error('Android APK requires a verified v2 or v3 signature');
  const badging = capture(tools.aapt2, ['dump', 'badging', signedApk], 'APK identity verification');
  const packageLine = badging.split('\n').find((line) => line.startsWith('package:')) ?? '';
  same(packageLine.match(/\bname='([^']+)'/)?.[1], identity.applicationId, 'APK application ID');
  same(packageLine.match(/\bversionName='([^']+)'/)?.[1], identity.versionName, 'APK version name');
  same(Number(packageLine.match(/\bversionCode='(\d+)'/)?.[1]), identity.versionCode, 'APK version code');
  if (/^application-debuggable(?:\s|$)/m.test(badging)) throw new Error('Android debuggable APK cannot be released');
  const unsignedPayload = capture('python3', ['-c', PAYLOAD_DIGESTS, unsignedApk], 'unsigned APK payload verification');
  const signedPayload = capture('python3', ['-c', PAYLOAD_DIGESTS, signedApk], 'signed APK payload verification');
  if (signedPayload !== unsignedPayload) throw new Error('Android signed/unsigned payload mismatch');
  const names = androidAssetNames(identity);
  const provenance = {
    ...receipt,
    apkSha256: digest(signedApk),
    certificateSha256: policy.certificateSha256,
    verifiedAt: new Date().toISOString(),
    verification: { apksigner: true, buildToolsVersion: tools.version, nonDebuggable: true, identicalUnsignedPayload: true },
  };

  fs.copyFileSync(signedApk, path.join(dist, names.apk));
  fs.chmodSync(path.join(dist, names.apk), 0o644);
  fs.copyFileSync(path.join(input, 'ANDROID_README.md'), path.join(dist, names.readme));
  writeJson(path.join(dist, names.provenance), provenance);
  const android = { required: true, status: 'signed', ...provenance, apk: names.apk, provenance: names.provenance, provenanceSha256: digest(path.join(dist, names.provenance)) };
  const updated = {
    ...manifest,
    android,
    artifacts: [...(manifest.artifacts ?? []).filter((entry) => entry.name !== names.apk), { name: names.apk, bytes: fs.statSync(signedApk).size, sha256: provenance.apkSha256 }],
    publishedAssets: [...new Set([...manifest.publishedAssets, ...Object.values(names)])].sort(),
  };
  writeJson(path.join(dist, 'release-manifest.json'), updated);
  const sums = updated.publishedAssets.filter((name) => name !== 'SHA256SUMS').map((name) => `${digest(path.join(dist, name))}  ${name}`).join('\n');
  fs.writeFileSync(path.join(dist, 'SHA256SUMS'), `${sums}\n`);
  verifyReleaseChecksums(dist, updated);
  assertAndroidReleaseReady(root, dist, updated);
  return updated.android;
}

export function importAndroidRelease(root, dist, signedApk) {
  regularFile(signedApk);
  // Snapshot all mutable handoff paths before validating any bytes. Neither a changed download
  // nor another process updating the original release can replace already-verified payloads.
  // These sibling names use the same ignored prefix as the isolated release wrapper.
  const candidate = path.join(path.dirname(dist), `.dist-android-${randomUUID()}`);
  const previous = path.join(path.dirname(dist), `.dist-previous-${randomUUID()}`);
  try {
    fs.cpSync(dist, candidate, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    fs.chmodSync(candidate, 0o700);
    const upload = path.join(candidate, '.android-input/.signed-upload.apk');
    fs.copyFileSync(signedApk, upload);
    fs.chmodSync(upload, 0o600);
    const android = completeAndroidRelease(root, candidate, upload);
    fs.rmSync(upload);
    fs.renameSync(dist, previous);
    try { fs.renameSync(candidate, dist); }
    catch (error) { fs.renameSync(previous, dist); throw error; }
    fs.rmSync(previous, { recursive: true, force: true });
    return android;
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}
