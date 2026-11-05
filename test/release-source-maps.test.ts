import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';

const require = createRequire(join(process.cwd(), 'package.json'));
const { FileMatcher, getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher');
const { NodeModuleCopyHelper } = require('app-builder-lib/out/util/NodeModuleCopyHelper');
const asar = require('@electron/asar');
const config = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).build;
const write = (file: string, value: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
};

test('actual dependency packaging excludes upstream debug maps while preserving runtime, source and notices', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-source-map-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source/node_modules/style-to-js');
  const upstreamPath = '/home/runner/work/style-to-js/style-to-js/cjs/index.js';
  const files = {
    'package.json': '{"name":"style-to-js","version":"1.1.21","main":"cjs/index.js","license":"MIT"}',
    'cjs/index.js': 'module.exports = {};\n',
    'src/index.ts': 'export default {};\n',
    'umd/style-to-js.js': 'var styleToJS = {};\n//# sourceMappingURL=style-to-js.js.map\n',
    'umd/style-to-js.js.map': JSON.stringify({ version: 3, sources: ['index.js'], sourcesContent: [`import source from '${upstreamPath}';`] }),
    'umd/style-to-js.min.js.map': JSON.stringify({ version: 3, sources: [upstreamPath] }),
    LICENSE: 'MIT license fixture; preserve these exact notice bytes.\n',
  };
  for (const [file, data] of Object.entries(files)) write(join(source, file), data);
  const baseline = join(root, 'before.asar');
  await asar.createPackage(join(root, 'source'), baseline);
  assert.ok(readFileSync(baseline).includes(Buffer.from('/home/runner')), 'fixture reproduces the release leakage check');

  const destination = join(root, 'payload');
  const packager = { config, debugLogger: { isEnabled: false }, appInfo: { type: 'module' }, getWorkspaceRoot: async () => root };
  const matcher = getNodeModuleFileMatcher(join(root, 'source'), destination, (value: string) => value, {}, packager);
  const moduleMatcher = new FileMatcher(source, join(destination, 'node_modules/style-to-js'), matcher.macroExpander, matcher.patterns);
  const copier = new NodeModuleCopyHelper(moduleMatcher, packager);
  const retained: string[] = await copier.collectNodeModules({ name: 'style-to-js', dir: source }, [], 'node_modules/style-to-js');
  assert.deepEqual(retained.map((file) => relative(source, file)).sort(),
    ['LICENSE', 'cjs/index.js', 'package.json', 'src/index.ts', 'umd/style-to-js.js']);
  for (const file of retained) {
    const output = join(destination, 'node_modules/style-to-js', relative(source, file));
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(file, output);
  }
  const packaged = join(root, 'after.asar');
  await asar.createPackage(destination, packaged);
  assert.equal(readFileSync(packaged).includes(Buffer.from('/home/runner')), false);
  for (const file of ['LICENSE', 'cjs/index.js', 'src/index.ts', 'umd/style-to-js.js']) {
    assert.equal(asar.extractFile(packaged, `node_modules/style-to-js/${file}`).toString(), files[file as keyof typeof files]);
  }
});

test('the same release filter excludes application source maps without removing application code', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-source-map-app-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filter = new FileMatcher(root, join(root, 'out'), (value: string) => value, config.files).createFilter();
  for (const file of ['dist/index.js', 'dist/index.js.map', 'dist-electron/main/index.js', 'dist-electron/main/index.js.map']) {
    write(join(root, file), 'fixture');
    assert.equal(filter(join(root, file), statSync(join(root, file))), !file.endsWith('.map'), file);
  }
});
