import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('desktop packages carry the first-party MIT license and the bundled font notices', () => {
  const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
  const resources = metadata.build.extraResources;
  assert.equal(metadata.license, 'MIT');
  const firstParty = resources.find((entry: { from: string }) => entry.from === 'LICENSE');
  assert.equal(firstParty?.to, 'ANTIMATTER_LICENSE.txt');
  const license = readFileSync('LICENSE', 'utf8');
  assert.match(license, /MIT License/);
  assert.match(license, /Execute Software/);
  assert.match(license, /The above copyright notice and this permission notice shall be included/);

  const fontNotices = resources.find((entry: { from: string }) => entry.from === 'renderer/src/assets/fonts');
  assert.equal(fontNotices?.to, 'licenses/fonts');
  assert.deepEqual([...fontNotices.filter].sort(), ['CC0-1.0.txt', 'OFL.txt', 'README.md']);
  for (const notice of fontNotices.filter) {
    assert.ok(readFileSync(join(fontNotices.from, notice)).length > 0);
  }
});

test('public packages exclude the unreviewed Pensieve runtime and curriculum bundle', () => {
  const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
  const vendor = metadata.build.extraResources.find((entry: { from: string }) => entry.from === 'vendor');
  assert.ok(vendor, 'the reviewed backend vendor payload remains packaged');
  assert.ok(vendor.filter.includes('!pensieve/**'), 'a developer corpus must not enter a public package');
  assert.ok(vendor.filter.includes('**/*'));
});

test('the vendored Displacer snapshot retains its MIT notice as a verified release input', () => {
  const notice = readFileSync('releases/licenses/displacer/LICENSE');
  assert.match(notice.toString(), /MIT License/);
  assert.match(notice.toString(), /Execute Software/);
  assert.deepEqual(readFileSync('vendor/displacer/LICENSE'), notice);
  const manifest = JSON.parse(readFileSync('vendor/displacer/manifest.json', 'utf8'));
  const artifact = manifest.artifacts.find((entry: { path: string }) => entry.path === 'LICENSE');
  assert.equal(artifact?.sha256, createHash('sha256').update(notice).digest('hex'));
  assert.equal(artifact?.bytes, notice.length);
  const dependency = JSON.parse(readFileSync('scripts/deps.json', 'utf8')).dependencies
    .find((entry: { name: string }) => entry.name === 'displacer');
  assert.ok(dependency.artifacts.some((entry: { from: string; to: string; fromProject?: boolean }) =>
    entry.from === 'releases/licenses/displacer/LICENSE' && entry.to === 'LICENSE' && entry.fromProject === true));
});

test('Pensieve public provenance records SDK identities without local paths or arbitrary metadata', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-public-provenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts');
  const source = join(root, 'source');
  mkdirSync(scripts);
  mkdirSync(join(source, 'pensieve'), { recursive: true });
  copyFileSync('scripts/sync-pensieve.mjs', join(scripts, 'sync-pensieve.mjs'));
  writeFileSync(join(source, 'VERSION'), 'v1\n');
  writeFileSync(join(source, 'pensieve', 'bridge.py'), '# Public fixture runtime.\n');
  const identities = { manifest_sha256: 'a'.repeat(64), source_revision: 'b'.repeat(40), compiler_sha256: 'c'.repeat(64) };
  const curriculum = join(root, 'curriculum.json');
  const bundle = { schema_version: 1, id: 'fixture', entries: [{ id: 'example' }],
    sdk: { ...identities, path: '/private/developer/sdk', unrelated: 'private metadata' } };
  writeFileSync(curriculum, JSON.stringify(bundle));
  const invoke = () => spawnSync(process.execPath, [join(scripts, 'sync-pensieve.mjs'), '--source', source,
    '--curriculum', curriculum], { encoding: 'utf8' });
  const result = invoke();
  assert.equal(result.status, 0, result.stderr);
  const manifestPath = join(root, 'vendor', 'pensieve', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(manifest.sdk, identities);
  assert.doesNotMatch(readFileSync(manifestPath, 'utf8'), /private\/developer|private metadata/);
  assert.match(manifest.files['curriculum.json'], /^[0-9a-f]{64}$/);
  // The local input stays unchanged; excluding the bundle from public packages is a separate gate.
  assert.deepEqual(JSON.parse(readFileSync(curriculum, 'utf8')), bundle);
  rmSync(join(root, 'vendor'), { recursive: true, force: true });
  writeFileSync(curriculum, JSON.stringify({ ...bundle, sdk: { ...bundle.sdk, source_revision: '/private/not-a-revision' } }));
  const rejected = invoke();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Invalid SDK identity/);
  assert.equal(existsSync(join(root, 'vendor')), false, 'invalid provenance fails before copying');
});
