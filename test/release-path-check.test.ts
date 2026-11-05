import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertNoLocalBuildPaths, reviewedUpstreamFiles } from '../scripts/lib/release-path-check.mjs';

const prefix = '/home/runner/work/llama.cpp/llama.cpp/';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function fixture(t: { after(fn: () => unknown): void }, contents: string | Buffer) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-build-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'payload/resources/vendor/llama-vulkan/runtime/libggml-base.so');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  const options = {
    privatePaths: ['/tmp/current-isolated-checkout', '/home/runner/work/exec-antimatter/exec-antimatter'],
    homePath: '/home/runner',
    upstreamFiles: new Map([[file, { bytes: Buffer.byteLength(contents), sha256: sha(contents) }]]),
  };
  return { root, file, options };
}

test('only complete upstream prefixes in exact pinned files pass, including a split chunk boundary', (t) => {
  const contents = `first\0${prefix}ggml/src/ggml.c\0${'x'.repeat(1024 * 1024 - 80)}${prefix}src/model.cpp\0`;
  const box = fixture(t, contents);
  assert.equal(assertNoLocalBuildPaths(box.file, box.options), 2);
  const moved = join(box.root, 'app.asar');
  copyFileSync(box.file, moved);
  assert.throws(() => assertNoLocalBuildPaths(moved, box.options), /leaks local build path/);
});

test('every home occurrence is checked and arbitrary suffixes, incomplete prefixes and other homes remain blocked', (t) => {
  for (const contents of [
    `${prefix}src/model.cpp\0/home/runner/private/token\0`,
    '/home/runner/work/llama.cpp/llama.cpp-private/src/model.cpp\0',
    '/home/runner/work/llama.cpp/llama.cpp',
    `${prefix}src/model.cpp\0/home/another-builder/project\0`,
  ]) {
    const box = fixture(t, contents);
    const options = contents.includes('/home/another-builder') ? { ...box.options, homePath: '/home/another-builder' } : box.options;
    assert.throws(() => assertNoLocalBuildPaths(box.file, options), /leaks local build path/);
  }
});

test('a current checkout path is blocked even when it overlaps the upstream prefix', (t) => {
  const box = fixture(t, `${prefix}src/model.cpp\0`);
  assert.throws(() => assertNoLocalBuildPaths(box.file, { ...box.options, privatePaths: [prefix.slice(0, -1)] }), /leaks local build path/);
  writeFileSync(box.file, `${prefix}src/model.cpp\0/tmp/current-isolated-checkout/src/index.ts\0`);
  assert.throws(() => assertNoLocalBuildPaths(box.file, box.options), /current-isolated-checkout/);
});

test('home and private-path matches remain checked across the read boundary and at EOF', (t) => {
  const allowed = fixture(t, `${'x'.repeat(1024 * 1024 - 4)}${prefix}src/model.cpp`);
  assert.equal(assertNoLocalBuildPaths(allowed.file, allowed.options), 1);
  for (const contents of [
    `${'x'.repeat(1024 * 1024 - 4)}/tmp/current-isolated-checkout/src/index.ts`,
    `${'x'.repeat(1024 * 1024)}/home/runner/private`,
  ]) {
    const box = fixture(t, contents);
    assert.throws(() => assertNoLocalBuildPaths(box.file, box.options), /leaks local build path/);
  }
});

test('changed bytes, size, missing records and symlinks cannot gain an upstream exemption', (t) => {
  const box = fixture(t, `${prefix}src/model.cpp\0`);
  for (const record of [{ bytes: 0, sha256: sha(readFileSync(box.file)) },
    { bytes: readFileSync(box.file).length, sha256: '0'.repeat(64) }]) {
    assert.throws(() => assertNoLocalBuildPaths(box.file, { ...box.options, upstreamFiles: new Map([[box.file, record]]) }), /leaks local build path/);
  }
  assert.throws(() => assertNoLocalBuildPaths(box.file, { ...box.options, upstreamFiles: new Map() }), /leaks local build path/);
  writeFileSync(box.file, `${prefix}src/other.cpp\0`);
  assert.throws(() => assertNoLocalBuildPaths(box.file, box.options), /leaks local build path/, 'same-size byte mutation invalidates the pin');
  const link = join(box.root, 'linked.so');
  symlinkSync(box.file, link);
  assert.throws(() => assertNoLocalBuildPaths(link, box.options), /regular file/);
});

test('upstream policy records come only from the exact canonical source and packaged manifest', (t) => {
  const box = fixture(t, 'no build path');
  const source = join(box.root, 'vendor/llama-vulkan/manifest.json');
  const payload = join(box.root, 'payload');
  const packaged = join(payload, 'resources/vendor/llama-vulkan/manifest.json');
  mkdirSync(dirname(source), { recursive: true });
  const canonical = readFileSync(join(process.cwd(), 'vendor/llama-vulkan/manifest.json'));
  writeFileSync(source, canonical);
  writeFileSync(packaged, canonical);
  const records = reviewedUpstreamFiles(box.root, payload);
  assert.equal(records.size, 61);
  assert.deepEqual(records.get(box.file), { bytes: 920080, sha256: '5d76bfc1b390ddad6e324d75152ded8406a10547d34271423b824af8410d3b98' });
  // Even identical source/packaged replacements cannot change the trust anchor.
  writeFileSync(source, Buffer.concat([canonical, Buffer.from('\n')]));
  writeFileSync(packaged, readFileSync(source));
  assert.throws(() => reviewedUpstreamFiles(box.root, payload), /exact reviewed Vulkan manifest/);
  writeFileSync(source, canonical);
  assert.throws(() => reviewedUpstreamFiles(box.root, payload), /exact reviewed Vulkan manifest/);
});

test('ordinary files without the selected build paths need no upstream exception', (t) => {
  const box = fixture(t, 'ordinary application and license bytes');
  assert.equal(assertNoLocalBuildPaths(box.file, { ...box.options, upstreamFiles: new Map() }), 0);
});
