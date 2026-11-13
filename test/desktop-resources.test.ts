import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildFeatureSdk, copyDoomResources, readDoomLock, verifyDoomResources, verifyFeatureSdk } from '../scripts/lib/desktop-resources.mjs';

function fixture(t: { after(fn: () => void): void }) {
  const scratch = mkdtempSync(join(tmpdir(), 'desktop-resource-'));
  t.after(() => { rmSync(scratch, { recursive: true, force: true }); });
  const root = join(scratch, 'source');
  const runtime = join(scratch, 'runtime');
  mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(runtime);
  const lock = readDoomLock(process.cwd());
  for (const asset of lock.assets) {
    const bytes = Buffer.from(`fixture ${asset.name}`);
    asset.bytes = bytes.length; asset.sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(runtime, asset.name), bytes);
  }
  writeFileSync(join(root, 'scripts/doom-runtime.lock.json'), JSON.stringify(lock));
  writeFileSync(join(runtime, 'runtime-manifest.json'), JSON.stringify(lock));
  return { scratch, root, runtime, lock };
}

test('Doom packaging copies the complete verified source and notice inventory', (t) => {
  const { scratch, root, runtime, lock } = fixture(t);
  const destination = join(scratch, 'packaged/doom');
  assert.equal(copyDoomResources(root, runtime, destination).revision, lock.revision);
  assert.ok(readFileSync(join(destination, 'corresponding-source.tar.gz')).length);
  assert.deepEqual(verifyDoomResources(root, destination), lock);
  writeFileSync(join(destination, 'CHOCOLATE-DOOM-GPL-2.0.md'), 'changed');
  assert.throws(() => verifyDoomResources(root, destination), /checksum mismatch/);
});

test('Doom packaging refuses missing notices, extra files, symlinks and mutable manifests', (t) => {
  const { root, runtime, lock } = fixture(t);
  const notice = join(runtime, 'CREDITS-MUSIC.txt');
  const bytes = readFileSync(notice); rmSync(notice);
  assert.throws(() => verifyDoomResources(root, runtime), /inventory differs/);
  writeFileSync(notice, bytes); writeFileSync(join(runtime, 'unexpected'), 'x');
  assert.throws(() => verifyDoomResources(root, runtime), /inventory differs/);
  rmSync(join(runtime, 'unexpected')); rmSync(notice); symlinkSync(join(runtime, 'CREDITS.txt'), notice);
  assert.throws(() => verifyDoomResources(root, runtime), /regular file/);
  rmSync(notice); writeFileSync(notice, bytes);
  writeFileSync(join(runtime, 'runtime-manifest.json'), JSON.stringify({ ...lock, revision: '0'.repeat(40) }));
  assert.throws(() => verifyDoomResources(root, runtime), /manifest differs/);
});

test('Feature SDK distribution compiles, links and preserves exact released source plus Matrix bindings', { skip: process.platform !== 'linux' && process.platform !== 'darwin' }, (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'feature-sdk-release-'));
  t.after(() => { rmSync(scratch, { recursive: true, force: true }); });
  const destination = join(scratch, 'sdk');
  const result = buildFeatureSdk(process.cwd(), destination);
  assert.ok(result.files.some((file: { name: string }) => file.name === 'antimatter_features.matrix'));
  const client = join(scratch, 'client.c');
  writeFileSync(client, '#include "antimatter_features.h"\nint main(void) { return antimatter_feature_get("/nonexistent/feature.sock", "Example", "Flag") == -1 ? 0 : 1; }\n');
  execFileSync('cc', [client, '-I', destination, '-L', destination, '-lantimatter_features', `-Wl,-rpath,${destination}`, '-o', join(scratch, 'client')], { timeout: 30000 });
  execFileSync(join(scratch, 'client'), [], { timeout: 5000 });
  assert.deepEqual(verifyFeatureSdk(process.cwd(), destination), result);
  const original = readFileSync(join(destination, 'antimatter_features.matrix'));
  writeFileSync(join(destination, 'antimatter_features.matrix'), '// wrong source');
  assert.throws(() => verifyFeatureSdk(process.cwd(), destination), /checksum mismatch/);
  writeFileSync(join(destination, 'antimatter_features.matrix'), original);
  copyFileSync(join(destination, result.library), join(destination, 'extra-library.so'));
  assert.throws(() => verifyFeatureSdk(process.cwd(), destination), /inventory differs/);
});
