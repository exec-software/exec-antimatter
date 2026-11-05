#!/usr/bin/env node

/** Publish exactly the verified asset set recorded by the release assembler. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseChannel, isReleaseIdentity } from './lib/release-version.mjs';
import { assertAndroidReleaseReady } from './lib/android-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'releases', 'dist');
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
const capture = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options }).trim();
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const manifestPath = path.join(DIST, 'release-manifest.json');
if (!fs.statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) {
  throw new Error('No assembled release manifest; run npm run release:linux first');
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const channel = releaseChannel(manifest.version);
if (!isReleaseIdentity(manifest)) {
  throw new Error('release manifest version, tag and stable/alpha channel do not agree');
}
if (!Array.isArray(manifest.publishedAssets) || !manifest.publishedAssets.length) {
  throw new Error('release manifest has no authoritative published asset list');
}
const assets = [...manifest.publishedAssets].sort(compareText);
if (new Set(assets).size !== assets.length || assets.some((name) => path.basename(name) !== name)) {
  throw new Error('release manifest contains duplicate or unsafe asset names');
}
const actual = fs
  .readdirSync(DIST, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort(compareText);
if (JSON.stringify(actual) !== JSON.stringify(assets)) {
  throw new Error(`release assets drifted; expected ${assets.join(', ')}, found ${actual.join(', ')}`);
}

// sha256sum --check validates only the lines it receives. Require exact coverage first so an
// omitted backend inventory, archive, or installer cannot reach GitHub without verification.
for (const required of ['release-manifest.json', 'model-manifest.json', 'SHA256SUMS']) {
  if (!assets.includes(required)) throw new Error(`publishedAssets is missing ${required}`);
}
const sums = new Map();
for (const line of fs.readFileSync(path.join(DIST, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)) {
  const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
  if (!match || sums.has(match[2])) throw new Error(`SHA256SUMS has an unusable or repeated line: ${line}`);
  sums.set(match[2], match[1]);
}
const covered = assets.filter((name) => name !== 'SHA256SUMS');
if (JSON.stringify([...sums.keys()].sort(compareText)) !== JSON.stringify(covered)) {
  throw new Error('SHA256SUMS does not cover exactly the other assets');
}
for (const name of covered) {
  if (sha256(path.join(DIST, name)) !== sums.get(name)) throw new Error(`${name} does not match SHA256SUMS`);
}
assertAndroidReleaseReady(ROOT, DIST, manifest);

const dirty = capture('git', ['status', '--porcelain', '--untracked-files=all']);
if (dirty) throw new Error('refusing to publish from a dirty worktree');
const head = capture('git', ['rev-parse', 'HEAD']);
if (manifest.commit !== head) throw new Error(`release was built from ${manifest.commit}, but HEAD is ${head}`);
const tagCommit = capture('git', ['rev-list', '-n', '1', manifest.tag]);
if (tagCommit !== head) throw new Error(`${manifest.tag} does not identify the assembled commit`);

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.releaseVersion !== undefined) {
  const rolling = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  if (rolling !== manifest.releaseVersion || packageJson.releaseVersion !== rolling || packageJson.version !== manifest.version) {
    throw new Error('public VERSION and package pins do not match the assembled release');
  }
  if (capture('git', ['rev-list', '-n', '1', manifest.releaseVersion]) !== head) {
    throw new Error(`${manifest.releaseVersion} does not identify the assembled commit`);
  }
}
const repository = new URL(packageJson.repository.url).pathname.replace(/^\//, '').replace(/\.git$/, '');
run('gh', [
  'release',
  'create',
  manifest.tag,
  ...assets.map((name) => path.join(DIST, name)),
  '--repo',
  repository,
  '--verify-tag',
  '--draft',
  '--title',
  `Antimatter ${manifest.releaseVersion ?? manifest.version}${channel === 'alpha' ? ' (alpha)' : ''}`,
  '--notes-file',
  path.join(ROOT, 'releases', 'RELEASE_NOTES.md'),
]);

const uploaded = JSON.parse(
  capture('gh', [
    'release',
    'view',
    manifest.tag,
    '--repo',
    repository,
    '--json',
    'assets,isDraft,tagName',
  ])
);
if (uploaded.tagName !== manifest.tag || uploaded.isDraft !== true) {
  throw new Error('uploaded release is not the expected draft');
}
const remoteAssets = [...uploaded.assets].sort((left, right) => compareText(left.name, right.name));
if (JSON.stringify(remoteAssets.map((asset) => asset.name)) !== JSON.stringify(assets)) {
  throw new Error('GitHub draft asset names do not match the assembled allowlist; draft was left unpublished');
}
for (const asset of remoteAssets) {
  const local = path.join(DIST, asset.name);
  if (asset.size !== fs.statSync(local).size) {
    throw new Error(`GitHub asset size mismatch for ${asset.name}; draft was left unpublished`);
  }
  if (asset.digest && asset.digest !== `sha256:${sha256(local)}`) {
    throw new Error(`GitHub asset digest mismatch for ${asset.name}; draft was left unpublished`);
  }
}

run('gh', [
  'release',
  'edit',
  manifest.tag,
  '--repo',
  repository,
  '--verify-tag',
  '--draft=false',
  `--prerelease=${channel === 'alpha'}`,
  ...(channel === 'stable' ? ['--latest'] : []),
]);
const published = JSON.parse(
  capture('gh', [
    'release',
    'view',
    manifest.tag,
    '--repo',
    repository,
    '--json',
    'isDraft,isPrerelease,url',
  ])
);
if (published.isDraft || published.isPrerelease !== (channel === 'alpha')) {
  throw new Error('GitHub release did not enter the expected published stable/prerelease state');
}
console.log(`Published ${published.url}`);
