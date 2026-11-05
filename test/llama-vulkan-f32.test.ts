import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { NAME, inspectRuntime, inventory, materializeRuntime, publicBuildOptions, sha256, validateBuild, validateSource, verifyPayload, readRecipe } from '../scripts/lib/llama-vulkan-f32.mjs';

test('public build provenance labels path redactions without changing build flags or input cache', () => {
  const cache = { CMAKE_PREFIX_PATH: '/private/builder/deps', GGML_VULKAN: 'ON',
    CMAKE_CXX_FLAGS: '-isystem /private/builder/deps/include -I/private/builder/source/include',
    GGML_BACKEND_DIR: '/private/builder/build/bin', LLAMA_METADATA: '/private/builder/cache',
    CMAKE_CXX_FLAGS_RELEASE: '-O3 -DNDEBUG' };
  const before = JSON.stringify(cache);
  const published = publicBuildOptions(cache, { source: '/private/builder/source', build: '/private/builder/build', home: '/private/builder' });
  assert.equal(published.pathPolicy, 'redacted-local-build-paths-v1');
  assert.equal(published.dependencyPrefix, '<DEPENDENCY_PREFIX>');
  assert.equal(published.effectiveOptions.CMAKE_CXX_FLAGS, '-isystem <DEPENDENCY_PREFIX>/include -I<SOURCE>/include');
  assert.equal(published.effectiveOptions.GGML_BACKEND_DIR, '<BUILD>/bin');
  assert.equal(published.effectiveOptions.LLAMA_METADATA, '<USER_HOME>/cache');
  assert.equal(published.effectiveOptions.CMAKE_CXX_FLAGS_RELEASE, '-O3 -DNDEBUG');
  assert.equal(published.effectiveOptions.GGML_VULKAN, 'ON');
  assert.doesNotMatch(JSON.stringify(published), /private\/builder/);
  assert.equal(JSON.stringify(cache), before);
});

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-f32-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const build = join(root, 'build');
  const vendor = join(root, NAME);
  const runtime = join(vendor, 'runtime');
  const write = (file: string, content: string | Buffer, mode = 0o644) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { mode });
  };
  const license = 'fixture license\n';
  write(join(source, 'LICENSE'), license);
  for (const name of ['llama-server', 'libggml-vulkan.so', 'libggml-base.so', 'libggml-cpu.so', 'libllama.so']) {
    write(join(runtime, name), Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(name)]), 0o755);
  }
  write(join(runtime, 'LICENSE'), license);
  const files = inventory(runtime);
  const recipe = {
    source: { commit: 'a'.repeat(40), tag: 'b11223' }, patches: [{ path: 'patch.diff', sha256: 'b'.repeat(64) }],
    files: [{ path: 'ggml/kernel.cpp', sha256: sha256('patched') }],
    cmake: { GGML_VULKAN: 'ON', GGML_NATIVE: 'OFF' }, targets: ['llama-server'], licenseSha256: sha256(license),
  };
  const version = 'version: 0.5.0-dev (build 11223, commit 4da633776)\nbuilt with GNU 15.2.0 for Linux x86_64';
  const manifest = {
    schemaVersion: 1, name: NAME, source: recipe.source, patches: recipe.patches, patchedFiles: recipe.files,
    build: { options: recipe.cmake, targets: recipe.targets, version, systemLibraries: ['libc.so.6', 'libvulkan.so.1'] },
    runtime: { path: 'runtime', hashPolicy: 'antimatter-file-inventory-json-v1', sha256: sha256(JSON.stringify(files)), files: files.length, bytes: files.reduce((sum: number, file: any) => sum + file.bytes, 0) }, files,
  };
  const save = () => write(join(vendor, 'manifest.json'), JSON.stringify(manifest));
  save();
  const execute = (command: string, args: string[]) => command === 'readelf' ? ' (RUNPATH) Library runpath: [$ORIGIN:]' : command === 'ldd'
    ? `libggml-base.so => ${runtime}/libggml-base.so (0xabc)\nlibc.so.6 => /lib/libc.so.6 (0xdef)\nlibvulkan.so.1 => /lib/libvulkan.so.1 (0x123)`
    : `machine-dependent Vulkan enumeration\n${version}`;
  return { root, source, build, vendor, runtime, write, recipe, manifest, save, execute };
}

test('F32 payload verifies exact patch provenance, regular files, required GPU binary, dependencies and smoke', (t) => {
  const box = fixture(t);
  assert.equal(verifyPayload(box.vendor, box.recipe, { execute: box.execute }).name, NAME);
  box.manifest.patches = [{ path: 'patch.diff', sha256: 'c'.repeat(64) }];
  box.save();
  assert.throws(() => verifyPayload(box.vendor, box.recipe, { smoke: false }), /patch provenance/);
});

test('F32 payload rejects changed bytes, mode changes, extra files and symlinks before executing', (t) => {
  const box = fixture(t);
  const file = join(box.runtime, 'llama-server');
  const bytes = readFileSync(file);
  writeFileSync(file, 'tampered');
  assert.throws(() => verifyPayload(box.vendor, box.recipe, { smoke: false }), /runtime inventory/);
  writeFileSync(file, bytes);
  chmodSync(file, 0o644);
  assert.throws(() => verifyPayload(box.vendor, box.recipe, { smoke: false }), /runtime inventory/);
  chmodSync(file, 0o755);
  box.write(join(box.runtime, 'foreign'), 'unexpected');
  assert.throws(() => verifyPayload(box.vendor, box.recipe, { smoke: false }), /runtime inventory/);
  rmSync(join(box.runtime, 'foreign'));
  rmSync(file);
  symlinkSync(join(box.runtime, 'libllama.so'), file);
  assert.throws(() => verifyPayload(box.vendor, box.recipe, { smoke: false }), /not a regular file/);
});

test('F32 loader verification refuses a missing library or a ggml dependency outside the payload', (t) => {
  const box = fixture(t);
  assert.throws(() => inspectRuntime(box.runtime, () => 'libggml-base.so => not found'), /unresolved/);
  assert.throws(() => inspectRuntime(box.runtime, () => ' (RUNPATH) Library runpath: [/scratch/build/bin]'), /non-relocatable/);
  const foreign = join(box.root, 'foreign.so');
  box.write(foreign, 'foreign');
  assert.throws(() => inspectRuntime(box.runtime, () => `libggml-base.so => ${foreign} (0xabc)`), /escaped payload/);
});

test('build import materializes only in-tree aliases and refuses dependencies outside build bin', (t) => {
  const box = fixture(t);
  const bin = join(box.build, 'bin');
  for (const name of ['llama-server', 'libggml-vulkan.so', 'libggml-base.so', 'libggml-cpu.so', 'libllama.so.0']) box.write(join(bin, name), 'built');
  symlinkSync('libllama.so.0', join(bin, 'libllama.so'));
  const destination = join(box.root, 'materialized');
  const result = materializeRuntime(box.source, box.build, destination);
  assert.equal(result.find((file: any) => file.path === 'libllama.so').sha256, sha256('built'));
  assert.equal(inventory(destination).length, 7);
  rmSync(join(bin, 'libllama.so'));
  symlinkSync(join(box.runtime, 'libllama.so'), join(bin, 'libllama.so'));
  assert.throws(() => materializeRuntime(box.source, box.build, join(box.root, 'unsafe')), /escapes bin/);
});

test('build validation rejects foreign source paths and changed safety flags', (t) => {
  const box = fixture(t);
  const cache = (source: string, native: string) => box.write(join(box.build, 'CMakeCache.txt'), [
    `CMAKE_HOME_DIRECTORY:INTERNAL=${source}`, 'CMAKE_GENERATOR:INTERNAL=Ninja',
    'GGML_VULKAN:BOOL=ON', `GGML_NATIVE:BOOL=${native}`,
  ].join('\n'));
  cache(box.source, 'OFF');
  assert.equal(validateBuild(box.build, box.source, box.recipe).GGML_VULKAN, 'ON');
  cache(box.source, 'ON');
  assert.throws(() => validateBuild(box.build, box.source, box.recipe), /GGML_NATIVE/);
  cache(box.root, 'OFF');
  assert.throws(() => validateBuild(box.build, box.source, box.recipe), /different source/);
});

test('source validation permits exactly the reviewed patch on the pinned tree', (t) => {
  const box = fixture(t);
  const git = (...args: string[]) => execFileSync('git', ['-C', box.source, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  box.write(join(box.source, 'ggml/kernel.cpp'), 'original');
  git('add', '.'); git('commit', '-qm', 'fixture');
  box.recipe.source.commit = git('rev-parse', 'HEAD');
  box.write(join(box.source, 'ggml/kernel.cpp'), 'patched');
  validateSource(box.source, box.recipe);
  box.write(join(box.source, 'unexpected.cpp'), 'unreviewed');
  assert.throws(() => validateSource(box.source, box.recipe), /source changes/);
  rmSync(join(box.source, 'unexpected.cpp'));
  box.write(join(box.source, 'ggml/kernel.cpp'), 'different patch');
  assert.throws(() => validateSource(box.source, box.recipe), /source hash mismatch/);
  box.recipe.source.commit = 'f'.repeat(40);
  assert.throws(() => validateSource(box.source, box.recipe), /pinned llama.cpp commit/);
});


test('tracked F32 recipe pins source, patch bytes and local-only packaging separately from upstream', () => {
  const recipe = readRecipe(process.cwd());
  assert.equal(recipe.source.commit, '4da6337767f973e2b4d0797e5b323d77d8565e4a');
  assert.equal(recipe.files.length, 3);
  assert.equal(recipe.cmake.GGML_VULKAN, 'ON');
  assert.equal(recipe.cmake.GGML_NATIVE, 'OFF');
  assert.equal(recipe.cmake.CMAKE_BUILD_RPATH_USE_ORIGIN, 'ON');
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  assert.ok(pkg.build.extraResources.find((item: any) => item.from === 'vendor').filter.includes('!llama-vulkan-f32/**'));
  const upstream = JSON.parse(readFileSync(join(process.cwd(), 'vendor/llama-vulkan/manifest.json'), 'utf8'));
  assert.equal(upstream.runtime.sha256, 'e621c95dda21dd9b40fb1838b42f6507a90d33aea8fd1e045b0f682b5c199de8');
});
