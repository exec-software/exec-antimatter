import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { JAVASCRIPT_INVENTORY_FILES, validateJavaScriptInventory, writeJavaScriptInventory } from '../scripts/lib/javascript-inventory.mjs';

function fixture(t: { after(fn: () => void): void }) {
  const temporary = mkdtempSync(join(tmpdir(), 'antimatter-js-inventory-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'source');
  const payloadRoot = join(temporary, 'payload');
  const outputDirectory = join(temporary, 'inventory');
  const write = (base: string, relative: string, data: string) => {
    const file = join(base, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  };
  const pkg = { name: 'fixture', version: '1.0.0', license: 'MIT', dependencies: { runtime: '1.0.0', shared: '1.0.0' },
    devDependencies: { electron: '44.10.2', builder: '1.0.0' }, build: { linux: { executableName: 'fixture-app' } } };
  const lock: any = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } };
  const raw: any = { bomFormat: 'CycloneDX', specVersion: '1.5', metadata: { tools: [{ vendor: 'npm', name: 'cli', version: '10.9.3' }] },
    components: [], dependencies: [{ ref: 'fixture@1.0.0', dependsOn: ['runtime@1.0.0', 'shared@1.0.0', 'builder@1.0.0'] }] };
  const archive: Record<string, string> = { 'package.json': JSON.stringify(pkg) };
  const addPackage = (name: string, location = `node_modules/${name}`, development = false, packaged = true) => {
    const metadata = { name, version: '1.0.0', license: 'MIT' };
    lock.packages[location] = { version: '1.0.0', license: 'MIT', integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, ...(development ? { dev: true } : {}) };
    write(root, `${location}/package.json`, JSON.stringify(metadata));
    write(root, `${location}/LICENSE`, `MIT notice for ${name}\n`);
    raw.components.push({ name, version: '1.0.0', 'bom-ref': `${name}@1.0.0`, purl: `pkg:npm/${name}@1.0.0`,
      licenses: [{ license: { id: 'MIT' } }], hashes: [{ alg: 'SHA-512', content: Buffer.alloc(64).toString('hex') }],
      properties: [{ name: 'cdx:npm:package:path', value: location },
        ...(development ? [{ name: 'cdx:npm:package:development', value: 'true' }] : [])] });
    raw.dependencies.push({ ref: `${name}@1.0.0`, dependsOn: [] });
    if (packaged) {
      archive[`${location}/package.json`] = JSON.stringify(metadata);
      archive[`${location}/LICENSE`] = `MIT notice for ${name}\n`;
    }
  };
  addPackage('runtime');
  addPackage('shared');
  addPackage('builder', 'node_modules/builder', true, false);
  lock.packages['node_modules/electron'] = { version: '44.10.2', license: 'MIT', dev: true };
  write(root, 'package.json', JSON.stringify(pkg));
  write(root, 'node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: '44.10.2', license: 'MIT' }));
  write(root, 'node_modules/electron/dist/version', '44.10.2\n');
  write(root, 'node_modules/electron/dist/electron', 'fixture runtime binary');
  write(root, 'node_modules/electron/dist/LICENSE', 'Electron MIT notice\n');
  write(root, 'node_modules/electron/dist/LICENSES.chromium.html', '<html>Chromium notices</html>\n');
  write(payloadRoot, 'fixture-app', 'fixture runtime binary');
  write(payloadRoot, 'LICENSE.electron.txt', 'Electron MIT notice\n');
  write(payloadRoot, 'LICENSES.chromium.html', '<html>Chromium notices</html>\n');
  const refresh = () => {
    write(root, 'package-lock.json', JSON.stringify(lock));
    write(payloadRoot, 'resources/app.asar', JSON.stringify(archive));
  };
  refresh();
  const commands: string[][] = [];
  const runCommand = (command: string, args: string[]) => {
    commands.push([command, ...args]);
    if (command === 'git') return 'a'.repeat(40);
    assert.equal(command, 'npm');
    return JSON.stringify(raw);
  };
  // Exercise inventory logic against concrete payload bytes without depending on ASAR internals.
  const asar = {
    listPackage: () => Object.keys(archive).map((name) => `/${name}`),
    statFile: (_file: string, name: string) => ({ size: Buffer.byteLength(archive[name]) }),
    extractFile: (_file: string, name: string) => Buffer.from(archive[name]),
  };
  const options = { root, payloadRoot, outputDirectory, runCommand, asar };
  return { temporary, root, payloadRoot, outputDirectory, write, pkg, lock, raw, archive, refresh, addPackage, commands, options };
}

test('inventory includes shared runtime packages and Electron, and retains exact notices without local paths', (t) => {
  const box = fixture(t);
  // A dependency shared with the build graph must not be lost through npm's omit selector.
  box.raw.components[1].properties.push({ name: 'cdx:npm:package:development', value: 'true' });
  const result = writeJavaScriptInventory(box.options);
  assert.equal(result.packages, 2);
  assert.equal(result.packagedPackages, 2);
  assert.equal(box.commands.some((command) => command.includes('--omit=dev')), false);
  const sbom = JSON.parse(readFileSync(join(box.outputDirectory, JAVASCRIPT_INVENTORY_FILES.sbom), 'utf8'));
  assert.deepEqual(sbom.components.map((item: any) => item.name), ['electron', 'runtime', 'shared']);
  const bundle = readFileSync(join(box.outputDirectory, JAVASCRIPT_INVENTORY_FILES.bundle), 'utf8');
  assert.match(bundle, /MIT notice for runtime\n/);
  assert.match(bundle, /Electron MIT notice\n/);
  assert.match(bundle, /Chromium notices/);
  for (const file of Object.values(JAVASCRIPT_INVENTORY_FILES) as string[]) {
    assert.equal(readFileSync(join(box.outputDirectory, file), 'utf8').includes(box.temporary), false);
  }
});

test('duplicate npm name/version components become one SBOM component while preserving installation copies', (t) => {
  const box = fixture(t);
  box.addPackage('shared', 'node_modules/runtime/node_modules/shared', false, false);
  box.refresh();
  const result = writeJavaScriptInventory(box.options);
  assert.equal(result.packages, 3);
  const sbom = JSON.parse(readFileSync(join(box.outputDirectory, JAVASCRIPT_INVENTORY_FILES.sbom), 'utf8'));
  assert.equal(sbom.components.filter((item: any) => item.name === 'shared').length, 1);
});

test('a locked required dependency omitted by the actual-tree report is refused', (t) => {
  const box = fixture(t);
  box.raw.components = box.raw.components.filter((item: any) => item.name !== 'shared');
  assert.throws(() => writeJavaScriptInventory(box.options), /required locked dependency absent/);
});

test('installed versions must match the reviewed lock', (t) => {
  const box = fixture(t);
  box.write(box.root, 'node_modules/runtime/package.json', JSON.stringify({ name: 'runtime', version: '2.0.0', license: 'MIT' }));
  assert.throws(() => writeJavaScriptInventory(box.options), /installed dependency differs from lock/);
});

test('actual-tree archive integrity metadata must match the reviewed lock', (t) => {
  const box = fixture(t);
  box.raw.components[0].hashes[0].content = 'f'.repeat(128);
  assert.throws(() => writeJavaScriptInventory(box.options), /installed integrity metadata differs from lock/);
});

test('unlisted or development-only packages in the payload are refused', (t) => {
  const box = fixture(t);
  box.archive['node_modules/builder/package.json'] = JSON.stringify({ name: 'builder', version: '1.0.0', license: 'MIT' });
  box.archive['node_modules/builder/LICENSE'] = 'MIT notice for builder\n';
  box.refresh();
  assert.throws(() => writeJavaScriptInventory(box.options), /unlisted or changed packaged dependency/);
});

test('packaged license text must be unchanged', (t) => {
  const box = fixture(t);
  box.archive['node_modules/runtime/LICENSE'] = 'replacement without the upstream attribution';
  box.refresh();
  assert.throws(() => writeJavaScriptInventory(box.options), /packaged notice changed/);
});

test('missing packaged license text and symlinked source licenses are refused', (t) => {
  const box = fixture(t);
  delete box.archive['node_modules/runtime/LICENSE'];
  box.refresh();
  assert.throws(() => writeJavaScriptInventory(box.options), /no retained license text/);
  box.archive['node_modules/runtime/LICENSE'] = 'MIT notice for runtime\n';
  rmSync(join(box.root, 'node_modules/runtime/LICENSE'));
  symlinkSync(join(box.root, 'node_modules/shared/LICENSE'), join(box.root, 'node_modules/runtime/LICENSE'));
  assert.throws(() => writeJavaScriptInventory(box.options), /symlink inside dependency/);
});

test('publisher can validate sealed artifacts without installed dependencies, and refuses tampering', (t) => {
  const box = fixture(t);
  writeJavaScriptInventory(box.options);
  rmSync(join(box.root, 'node_modules'), { recursive: true });
  const options = { root: box.root, outputDirectory: box.outputDirectory, runCommand: box.options.runCommand };
  assert.equal(validateJavaScriptInventory(options).packages, 2);
  box.write(box.outputDirectory, JAVASCRIPT_INVENTORY_FILES.bundle, 'changed');
  assert.throws(() => validateJavaScriptInventory(options), /inventory artifact changed/);
});

test('source-lock changes and post-inventory payload changes are refused', (t) => {
  const box = fixture(t);
  writeJavaScriptInventory(box.options);
  box.write(box.payloadRoot, 'resources/app.asar', 'different payload');
  assert.throws(() => validateJavaScriptInventory(box.options), /payload changed after inventory/);
  box.lock.packages['node_modules/runtime'].version = '2.0.0';
  box.refresh();
  assert.throws(() => validateJavaScriptInventory(box.options), /inventory source\/package\/lock identity differs/);
});

test('notices unpacked beside ASAR remain bound after generation', (t) => {
  const box = fixture(t);
  const name = 'node_modules/runtime/LICENSE';
  const unpacked = `resources/app.asar.unpacked/${name}`;
  box.write(box.payloadRoot, unpacked, box.archive[name]);
  const normalStat = box.options.asar.statFile;
  box.options.asar.statFile = (file, relative) => ({ ...normalStat(file, relative), ...(relative === name ? { unpacked: true } : {}) });
  writeJavaScriptInventory(box.options);
  box.write(box.payloadRoot, unpacked, 'changed after inventory');
  assert.throws(() => validateJavaScriptInventory(box.options), /payload changed after inventory/);
});

test('the shipped Electron executable and notices must match the locked installed distribution', (t) => {
  const box = fixture(t);
  box.write(box.payloadRoot, 'fixture-app', 'other runtime');
  assert.throws(() => writeJavaScriptInventory(box.options), /Electron executable differs/);
});
