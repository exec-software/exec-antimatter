#!/usr/bin/env node
/** Verify the pinned packaging glob override with the builder's actual FileMatcher API. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencyRoot = process.env.ANTIMATTER_PACKAGING_DEPENDENCIES ? path.resolve(process.env.ANTIMATTER_PACKAGING_DEPENDENCIES) : root;
const require = createRequire(path.join(dependencyRoot, 'package.json'));
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
const universalRequire = createRequire(builderRequire.resolve('@electron/universal/package.json'));
const { FileMatcher } = builderRequire('./out/fileMatcher.js');
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(metadata.build.afterPack, 'scripts/after-pack.cjs');
for (const consumer of [builderRequire, universalRequire]) {
  assert.equal(consumer('minimatch/package.json').version, '11.0.1');
  const { minimatch, Minimatch } = consumer('minimatch');
  assert.equal(minimatch('nested/module.node', '*.node', { matchBase: true }), true);
  assert.equal(new Minimatch('**/*', { dot: true }).match('.hidden/config'), true);
}
// An override of every transitive minimatch would break legacy callable consumers.
const dirCompareRequire = createRequire(universalRequire.resolve('dir-compare/package.json'));
assert.equal(typeof dirCompareRequire('minimatch'), 'function');
const file = { isDirectory: () => false };
const folder = { isDirectory: () => true };
const source = path.resolve('/fixture/source');
const accepts = (patterns, name, stat = file) => new FileMatcher(source, '/fixture/output', value => value, patterns).createFilter()(path.join(source, name), stat);
assert.equal(accepts(metadata.build.files, 'dist/index.html'), true);
assert.equal(accepts(metadata.build.files, 'dist-electron/main/index.js'), true);
assert.equal(accepts(metadata.build.files, 'dist-electron/main/index.js.map'), false);
assert.equal(accepts(metadata.build.files, '.env'), false);
assert.equal(accepts(metadata.build.files, 'src/main/index.ts'), false);
assert.equal(accepts(metadata.build.files, 'dist-electron', folder), true);
const vendor = metadata.build.extraResources.find(resource => resource.from === 'vendor');
assert.ok(vendor);
for (const name of ['beholdd/beholdd', 'beholdd-hag/libhag.so', 'llama-vulkan/runtime/libggml-vulkan.so']) assert.equal(accepts(vendor.filter, name), true, name);
for (const name of ['pensieve/private-curriculum.json', 'pensieve/.hidden/state', 'llama-vulkan-f32/llama-server']) assert.equal(accepts(vendor.filter, name), false, name);
const match = builderRequire('minimatch').minimatch;
for (const name of ['node_modules/node-pty/build/Release/pty.node', 'dist-electron/mcp/index.js']) assert.ok(metadata.build.asarUnpack.some(pattern => match(name, pattern)));
console.log('Packaging filters passed: patched APIs, legacy callable compatibility, source maps, private vendor exclusions, and native ASAR unpack.');
