import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { NATIVE_RELEASE_IMAGE, NATIVE_RELEASE_CONTAINER_LIMITS, nativeReleaseContainerArgs, nativeAbiRequirements, packageLinuxRelease, verifyNativeRelease } from '../scripts/lib/native-release.mjs';

const write = (file: string, value: string, mode?: number) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value, { mode });
};
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-native-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(join(root, 'package.json'), '{}');
  const packages: Record<string, { version: string; integrity: string }> = {};
  const inputs: Record<string, { version: string; integrity: string }> = {};
  for (const name of ['node-pty', 'node-addon-api', 'node-gyp']) {
    const entry = { version: '1.0.0', integrity: `sha512-fixture-${name}` };
    packages[`node_modules/${name}`] = entry;
    inputs[name] = entry;
    write(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: entry.version }));
  }
  write(join(root, 'node_modules/node-gyp/bin/node-gyp.js'), '// tool fixture');
  write(join(root, 'node_modules/electron/package.json'), JSON.stringify({ name: 'electron', version: '44.3.0' }));
  write(join(root, 'package-lock.json'), JSON.stringify({ packages }));
  const binary = join(root, 'node_modules/node-pty/build/Release/pty.node');
  const packaged = join(root, 'releases/dist/linux-unpacked/resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node');
  write(binary, 'verified native fixture');
  const receiptPath = join(root, 'node_modules/node-pty/antimatter-native-release.json');
  const receipt = { schemaVersion: 1, name: 'node-pty', containerLimits: NATIVE_RELEASE_CONTAINER_LIMITS, image: NATIVE_RELEASE_IMAGE, platform: 'linux/amd64', electron: '44.3.0', packages: inputs, binarySha256: sha(binary), abi: { GLIBC: '2.28', GLIBCXX: '3.4.22', CXXABI: '1.3.9' }, verification: { networkDisabledDuringCompile: true, baselinePty: true, electronPty: true } };
  write(receiptPath, JSON.stringify(receipt));
  const bin = join(root, 'tools');
  write(join(bin, 'readelf'), `#!${process.execPath}\nconsole.log('Version needs section\\n Name: GLIBC_2.28\\n Name: GLIBCXX_3.4.22\\n Name: CXXABI_1.3.9');\n`, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  t.after(() => { process.env.PATH = previousPath; });
  return { root, binary, packaged, receipt, receiptPath, bin };
}

test('release packaging disables both host rebuild paths and checks the resulting packaged bytes', (t) => {
  const box = fixture(t);
  const packageCommand = join(box.root, 'package-command.cjs');
  // A packaging process with the same two default-on rebuild decisions. Either missed override
  // produces a different host binary, which the post-package integrity gate must reject.
  write(packageCommand, `const fs=require('node:fs'),p=require('node:path');const args=process.argv.slice(2);const safe=args.includes('--config.npmRebuild=false')&&args.includes('--config.nodeGypRebuild=false');fs.mkdirSync(p.dirname(${JSON.stringify(box.packaged)}),{recursive:true});if(safe)fs.copyFileSync(${JSON.stringify(box.binary)},${JSON.stringify(box.packaged)});else fs.writeFileSync(${JSON.stringify(box.packaged)},'host rebuilt');`);
  const receipt = packageLinuxRelease(box.root, (command: string, args: string[]) => {
    assert.equal(command, 'npm');
    assert.deepEqual(args.slice(0, 3), ['run', 'package:linux', '--']);
    execFileSync(process.execPath, [packageCommand, ...args]);
  });
  assert.equal(receipt.binarySha256, sha(box.packaged));
  assert.throws(() => packageLinuxRelease(box.root, () => write(box.packaged, 'unexpected builder replacement')), /changed after verification or during packaging/);
});

test('native release receipt rejects binary, source-lock and toolchain drift before packaging', (t) => {
  const box = fixture(t);
  verifyNativeRelease(box.root);
  appendFileSync(box.binary, 'tampered');
  let invoked = false;
  assert.throws(() => packageLinuxRelease(box.root, () => { invoked = true; }), /changed after verification/);
  assert.equal(invoked, false);
  write(box.binary, 'verified native fixture');
  write(box.receiptPath, JSON.stringify({ ...box.receipt, image: 'unpinned:latest' }));
  assert.throws(() => verifyNativeRelease(box.root), /receipt does not match/);
  write(box.receiptPath, JSON.stringify(box.receipt));
  write(join(box.root, 'node_modules/node-pty/package.json'), JSON.stringify({ name: 'node-pty', version: '2.0.0' }));
  assert.throws(() => verifyNativeRelease(box.root), /does not match its npm lockfile/);
});

test('native release ABI check keeps the existing ceiling and refuses unfamiliar symbol versions', (t) => {
  const box = fixture(t);
  for (const version of ['2.42', 'PRIVATE']) {
    write(join(box.bin, 'readelf'), `#!${process.execPath}\nconsole.log('Version needs section\\n Name: GLIBC_${version}');\n`, 0o755);
    assert.throws(() => nativeAbiRequirements(box.binary), version === '2.42' ? /above 2.34/ : /Unknown GLIBC/);
  }
});

test('native Docker commands carry their own serial, swap-free resource bounds and finite lifetime', () => {
  const args = nativeReleaseContainerArgs('/release', '/scratch', 1234, 1234);
  const option = (name: string) => {
    assert.equal(args.filter((value: string) => value === name).length, 1, `${name} cannot be overridden later`);
    return args[args.indexOf(name) + 1];
  };
  assert.equal(option('--memory'), '3g');
  assert.equal(option('--memory-swap'), option('--memory'), 'combined memory+swap ceiling must leave no swap allowance');
  assert.equal(option('--cpus'), '1');
  assert.equal(option('--pids-limit'), '256');
  assert.equal(option('--network'), 'none');
  assert.equal(option('--user'), '1234:1234');
  assert.ok(args.includes('MAKEFLAGS=-j1'));
  assert.ok(args.includes('type=bind,src=/release/node_modules,dst=/dependencies/node_modules,readonly'));
  assert.deepEqual(args.slice(args.indexOf(NATIVE_RELEASE_IMAGE) + 1), ['timeout', '--signal=TERM', '--kill-after=10s', '600s']);
});

test('native packaging refuses receipts without the required container resource policy', (t) => {
  const box = fixture(t);
  for (const containerLimits of [undefined, { ...NATIVE_RELEASE_CONTAINER_LIMITS, swapBytes: 1024 },
    { ...NATIVE_RELEASE_CONTAINER_LIMITS, cpus: 2 }, { ...NATIVE_RELEASE_CONTAINER_LIMITS, processes: 0 }]) {
    write(box.receiptPath, JSON.stringify({ ...box.receipt, containerLimits }));
    let packaged = false;
    assert.throws(() => packageLinuxRelease(box.root, () => { packaged = true; }), /bounded container policy/);
    assert.equal(packaged, false);
  }
});
