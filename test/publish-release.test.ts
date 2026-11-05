import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const sha = (content: string) => createHash('sha256').update(content).digest('hex');
const write = (file: string, content: string, mode?: number) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, mode === undefined ? undefined : { mode });
};

function fixture(t: { after(fn: () => void): void }, version = '1.0.0', releaseVersion?: string) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-publish-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const dist = join(project, 'releases', 'dist');
  mkdirSync(join(project, 'scripts', 'lib'), { recursive: true });
  for (const relative of ['publish-release.mjs', 'lib/release-version.mjs', 'lib/android-release.mjs']) {
    copyFileSync(join(process.cwd(), 'scripts', relative), join(project, 'scripts', relative));
  }
  write(join(project, 'package.json'), JSON.stringify({ version, releaseVersion, repository: { url: 'https://github.com/example/fixture.git' } }));
  if (releaseVersion) write(join(project, 'VERSION'), `${releaseVersion}\n`);
  write(join(project, '.gitignore'), 'releases/dist/\n');
  write(join(project, 'releases', 'RELEASE_NOTES.md'), `# Antimatter ${version}\n`);
  const git = (args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Release test']);
  git(['config', 'user.email', 'release-test@example.invalid']);
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'fixture']);
  const commit = git(['rev-parse', 'HEAD']);
  git(['tag', `v${version}`]);
  if (releaseVersion) git(['tag', releaseVersion]);

  const files: Record<string, string> = {
    [`Antimatter-${version}-linux-x86_64.tar.gz`]: 'synthetic archive, not executable',
    'install.sh': '#!/bin/sh\nexit 0\n',
    'model-manifest.json': '{}\n',
    'backend-inventory.json': '{"backends":["synthetic"]}\n',
  };
  const assets = [...Object.keys(files), 'release-manifest.json', 'SHA256SUMS'].sort();
  files['release-manifest.json'] = JSON.stringify({
    schemaVersion: 1, name: 'Antimatter', version, releaseVersion, tag: `v${version}`, commit,
    channel: version.includes('-alpha.') ? 'alpha' : 'stable',
    platform: { os: 'linux', architecture: 'x86_64' }, publishedAssets: assets,
  });
  for (const [name, content] of Object.entries(files)) write(join(dist, name), content);
  const sums = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => `${sha(content)}  ${name}`).join('\n') + '\n';
  write(join(dist, 'SHA256SUMS'), sums);

  const log = join(root, 'gh-calls.jsonl');
  const mockData = join(root, 'gh-data.json');
  const uploaded = assets.map((name) => {
    const content = name === 'SHA256SUMS' ? sums : files[name];
    return { name, size: Buffer.byteLength(content), digest: `sha256:${sha(content)}` };
  });
  write(mockData, JSON.stringify({ assets: uploaded, tagName: `v${version}`, isPrerelease: version.includes('-alpha.') }));
  // No real gh or network operation is possible: every invocation is intercepted and recorded.
  const bin = join(root, 'bin');
  write(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PUBLISH_TEST_LOG, JSON.stringify(args) + '\\n');
const data = JSON.parse(fs.readFileSync(process.env.PUBLISH_TEST_DATA, 'utf8'));
if (args[0] !== 'release') process.exit(2);
if (args[1] === 'create' || args[1] === 'edit') process.exit(0);
if (args[1] !== 'view') process.exit(2);
if (args.includes('assets,isDraft,tagName')) console.log(JSON.stringify({ ...data, isDraft: true }));
else console.log(JSON.stringify({ isDraft: false, isPrerelease: data.isPrerelease, url: 'https://example.invalid/release' }));
`, 0o755);
  const run = () => spawnSync(process.execPath, [join(project, 'scripts', 'publish-release.mjs')], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`, PUBLISH_TEST_LOG: log, PUBLISH_TEST_DATA: mockData },
  });
  const calls = (): string[][] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  return { root, project, dist, sums, files, run, calls, mockData, git };
}

test('public v2 publishes under its compatibility tag while displaying its rolling release name', (t) => {
  const release = fixture(t, '2.0.0', 'v2');
  const result = release.run();
  assert.equal(result.status, 0, result.stderr);
  const create = release.calls()[0];
  assert.deepEqual(create.slice(0, 3), ['release', 'create', 'v2.0.0']);
  assert.equal(create[create.indexOf('--title') + 1], 'Antimatter v2');
  assert.ok(create.includes(join(release.dist, 'Antimatter-2.0.0-linux-x86_64.tar.gz')));
});

test('combined releases cannot publish without a verified Android production signature', (t) => {
  const release = fixture(t, '11.0.0', 'v11');
  const result = release.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Android production signature is pending/);
  assert.deepEqual(release.calls(), []);
});

test('rolling publication requires a public tag at the built commit before contacting GitHub', (t) => {
  const release = fixture(t, '2.0.0', 'v2');
  release.git(['tag', '-d', 'v2']);
  const missing = release.run();
  assert.notEqual(missing.status, 0);
  assert.deepEqual(release.calls(), []);
  // Build an unrelated commit solely inside this disposable fixture and tag it as v2.
  release.git(['commit', '--allow-empty', '--quiet', '-m', 'unrelated']);
  const unrelated = release.git(['rev-parse', 'HEAD']);
  release.git(['checkout', '--quiet', 'HEAD~1']);
  release.git(['tag', 'v2', unrelated]);
  const mismatch = release.run();
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /v2 does not identify the assembled commit/);
  assert.deepEqual(release.calls(), []);
});

test('rolling publication rejects inconsistent public and transport versions before GitHub', (t) => {
  const release = fixture(t, '2.0.0', 'v3');
  const result = release.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release manifest version, tag and stable\/alpha channel do not agree/);
  assert.deepEqual(release.calls(), []);
});

test('GitHub publishing refuses missing or duplicate checksums before contacting gh', (t) => {
  const release = fixture(t);
  const sumsPath = join(release.dist, 'SHA256SUMS');
  writeFileSync(sumsPath, release.sums.split('\n').filter((line) => !line.endsWith('  backend-inventory.json')).join('\n'));
  let result = release.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA256SUMS does not cover exactly the other assets/);
  assert.deepEqual(release.calls(), []);

  writeFileSync(sumsPath, release.sums + release.sums.split('\n')[0] + '\n');
  result = release.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA256SUMS has an unusable or repeated line/);
  assert.deepEqual(release.calls(), []);
});

test('GitHub publishing rejects unexpected checksum names, malformed lines, and changed payloads before gh', (t) => {
  const release = fixture(t);
  const sumsPath = join(release.dist, 'SHA256SUMS');
  for (const [sums, expected] of [
    [release.sums + `${sha('stray')}  stray.txt\n`, /does not cover exactly/],
    [release.sums + `${sha('escape')}  ..\/outside.txt\n`, /unusable or repeated line/],
  ] as const) {
    writeFileSync(sumsPath, sums);
    const result = release.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
    assert.deepEqual(release.calls(), []);
  }
  writeFileSync(sumsPath, release.sums);
  writeFileSync(join(release.dist, 'backend-inventory.json'), '{"changed":true}');
  const result = release.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /backend-inventory\.json does not match SHA256SUMS/);
  assert.deepEqual(release.calls(), []);
});

for (const version of ['1.0.0', '0.1.0-alpha.2']) {
  test(`GitHub publishing ${version} preserves exact assets and channel flags`, (t) => {
    const release = fixture(t, version);
    const result = release.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = release.calls();
    assert.deepEqual(calls.map((call) => call.slice(0, 2)), [
      ['release', 'create'], ['release', 'view'], ['release', 'edit'], ['release', 'view'],
    ]);
    assert.ok(calls[0].includes('--draft'));
    assert.ok(calls[0].includes(join(release.dist, 'backend-inventory.json')));
    assert.ok(calls[2].includes('--draft=false'));
    const alpha = version.includes('-alpha.');
    assert.ok(calls[2].includes(`--prerelease=${alpha}`));
    assert.equal(calls[2].includes('--latest'), !alpha);
  });
}

test('GitHub publishing leaves the draft unpublished when a remote digest differs', (t) => {
  const release = fixture(t);
  const data = JSON.parse(readFileSync(release.mockData, 'utf8'));
  data.assets.find((asset: { name: string }) => asset.name === 'backend-inventory.json').digest = `sha256:${'0'.repeat(64)}`;
  writeFileSync(release.mockData, JSON.stringify(data));
  const result = release.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GitHub asset digest mismatch for backend-inventory\.json/);
  assert.deepEqual(release.calls().map((call) => call.slice(0, 2)), [['release', 'create'], ['release', 'view']]);
});
