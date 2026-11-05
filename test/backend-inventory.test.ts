import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createBackendInventory } from '../scripts/lib/backend-inventory.mjs';

const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-backend-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, 'source');
  const packagedVendorRoot = join(root, 'package', 'vendor');
  const write = (path: string, contents: string, mode = 0o644) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, { mode });
  };
  const native = 'native-cpu-executable';
  const gpu = 'gpu-library';
  const hagExecutable = 'experimental-hag-executable';
  const hagModel = JSON.stringify({ schemaVersion: 1, id: 'qwen3-0.6b-hag', architecture: 'qwen3', quantization: 'Q8_0',
    bytes: 639447744, sha256: 'e150ed544dfe6016930c026a93913a5e3184181ebfe6ab2223ae01dd0491784c' });
  const hag = {
    schemaVersion: 1, name: 'beholdd-hag', dirty: false, source: 'https://example.invalid/beholdd',
    version: '0.0.1', commit: 'e'.repeat(40), cargoFeatures: ['hag-native'], artifacts: [
      { path: 'bin/beholdd', type: 'file', bytes: hagExecutable.length, sha256: hash(hagExecutable) },
      { path: 'model.json', type: 'file', bytes: hagModel.length, sha256: hash(hagModel) },
    ],
  };
  const beholdd = {
    schemaVersion: 1, name: 'beholdd', dirty: false, source: 'https://example.invalid/beholdd',
    version: '0.0.1', commit: 'a'.repeat(40), artifacts: [
      { path: 'bin/beholdd', type: 'file', bytes: native.length, sha256: hash(native) },
    ],
  };
  const llama = {
    schemaVersion: 1, name: 'llama-vulkan', platform: { accelerator: 'Vulkan' },
    source: { tag: 'b123', commit: 'b'.repeat(40) }, runtime: { files: 3, sha256: 'c'.repeat(64) },
    artifacts: [{ path: 'runtime/libggml-vulkan.so', type: 'file', bytes: gpu.length, sha256: hash(gpu) }],
    systemSharedLibraries: ['libvulkan.so.1', 'libssl.so.3', 'libcrypto.so.3'],
    license: { identifier: 'MIT', sha256: 'd'.repeat(64) },
  };
  for (const [name, record] of [['beholdd', beholdd], ['beholdd-hag', hag], ['llama-vulkan', llama]] as const) {
    write(join(repositoryRoot, 'vendor', name, 'manifest.json'), `${JSON.stringify(record)}\n`);
    write(join(packagedVendorRoot, name, 'manifest.json'), `${JSON.stringify(record)}\n`);
  }
  write(join(packagedVendorRoot, 'beholdd', 'bin', 'beholdd'), native, 0o755);
  write(join(packagedVendorRoot, 'beholdd-hag', 'bin', 'beholdd'), hagExecutable, 0o755);
  write(join(packagedVendorRoot, 'beholdd-hag', 'model.json'), hagModel);
  write(join(packagedVendorRoot, 'llama-vulkan', 'runtime', 'libggml-vulkan.so'), gpu);
  write(join(packagedVendorRoot, 'llama-vulkan', 'runtime', 'llama-server'), 'llama-server', 0o755);
  const commands: Array<{ command: string; args: string[]; options: any }> = [];
  const runCommand = (command: string, args: string[], options: any) => {
    commands.push({ command, args, options });
    return {
      status: 0,
      stdout: command === 'ldd' ? '\tlibc.so.6 => /lib/libc.so.6 (0xabc)\n' : args[0] === '--list-devices'
        ? 'Available devices:\n  Vulkan0: Example GPU (12000 MiB, 10000 MiB free)\n' : 'verified runtime\n',
      stderr: '',
    };
  };
  const options = { repositoryRoot, packagedVendorRoot, runCommand };
  return { ...options, root, write, commands, options, nativeBinary: join(packagedVendorRoot, 'beholdd', 'bin', 'beholdd') };
}

test('backend inventory verifies the packaged payload and distinguishes CPU, Vulkan and host-only drivers', (t) => {
  const box = fixture(t);
  const result = createBackendInventory(box.options);
  assert.deepEqual(result.backends.map((backend: any) => backend.execution), [['cpu'], ['vulkan-gpu', 'cpu'], ['hag-native-gpu']]);
  assert.equal(result.backends[0].gpuAcceleration, false);
  assert.equal(result.backends[1].gpuAcceleration, true);
  assert.equal(result.backends[1].nativeBeholdd, false);
  assert.equal(result.backends[2].experimental, true);
  assert.equal(result.backends[2].enabledByDefault, false);
  assert.deepEqual(result.backends[2].cargoFeatures, ['hag-native']);
  assert.equal(result.backends[2].supportedHost.pciDevice, '0x1586');
  assert.equal(result.backends[2].buildHostDeviceProbe.inferenceTested, false);
  assert.equal(result.hostPrerequisites.gpuDriversBundled, false);
  assert.equal(result.hostPrerequisites.cudaRuntimeBundled, false);
  assert.equal(result.buildHostDeviceProbe.status, 'available');
  assert.equal(result.buildHostDeviceProbe.inferenceTested, false);
  assert.deepEqual(result.buildHostDeviceProbe.devices.map((device: any) => device.id), ['Vulkan0']);
  assert.deepEqual(box.commands.find(({ command }) => command === process.execPath)?.args, [join(box.repositoryRoot, 'scripts', 'sync-llama-vulkan.mjs'), '--verify', '--payload', join(box.packagedVendorRoot, 'llama-vulkan')]);
  for (const { options } of box.commands) {
    assert.equal(options.env.PATH, '/usr/bin:/bin');
    assert.equal(options.env.LD_LIBRARY_PATH, undefined);
    assert.ok(options.timeout <= 30_000);
  }
  assert.doesNotMatch(JSON.stringify(result), new RegExp(box.root));
});

test('backend inventory refuses a missing GPU library instead of accepting CPU-only packaging', (t) => {
  const box = fixture(t);
  rmSync(join(box.packagedVendorRoot, 'llama-vulkan', 'runtime', 'libggml-vulkan.so'));
  assert.throws(() => createBackendInventory(box.options), /missing or unsafe file.*libggml-vulkan/);
});

test('backend inventory refuses changed, extra, non-executable or symlinked native payloads', (t) => {
  const box = fixture(t);
  box.write(box.nativeBinary, 'different executable');
  assert.throws(() => createBackendInventory(box.options), /artifact identity differs/);
  box.write(box.nativeBinary, 'native-cpu-executable');
  chmodSync(box.nativeBinary, 0o644);
  assert.throws(() => createBackendInventory(box.options), /executable mode/);
  chmodSync(box.nativeBinary, 0o755);
  const extra = join(box.packagedVendorRoot, 'beholdd', 'accidental.so');
  box.write(extra, 'unmanifested');
  assert.throws(() => createBackendInventory(box.options), /unexpected files/);
  rmSync(extra);
  const original = join(box.root, 'outside-binary');
  copyFileSync(box.nativeBinary, original);
  rmSync(box.nativeBinary);
  symlinkSync(original, box.nativeBinary);
  assert.throws(() => createBackendInventory(box.options), /unsafe file/);
});

test('backend inventory refuses a substituted manifest and unresolved native libraries', (t) => {
  const box = fixture(t);
  const manifest = join(box.packagedVendorRoot, 'beholdd', 'manifest.json');
  const prior = readFileSync(manifest, 'utf8');
  box.write(manifest, prior.replace('a'.repeat(40), 'e'.repeat(40)));
  assert.throws(() => createBackendInventory(box.options), /manifest differs/);
  box.write(manifest, prior);
  assert.throws(() => createBackendInventory({ ...box.options, runCommand: () => ({ status: 0, stdout: 'libgcc_s.so.1 => not found\n' }) }), /unresolved shared libraries/);
});

test('backend inventory propagates full Vulkan verifier failure including missing transitive payloads', (t) => {
  const box = fixture(t);
  const runCommand = (command: string, args: string[], options: any) => command === process.execPath
    ? { status: 1, stderr: 'runtime tree hash differs' } : box.runCommand(command, args, options);
  assert.throws(() => createBackendInventory({ ...box.options, runCommand }), /complete Vulkan payload verification failed.*runtime tree hash differs/);
});

test('backend inventory reports no-device and failed probes without claiming inference passed', (t) => {
  const box = fixture(t);
  const runCommand = (command: string, args: string[], options: any) => args[0] === '--list-devices'
    ? { status: 0, stdout: 'Available devices:\n' } : box.runCommand(command, args, options);
  const noDevice = createBackendInventory({ ...box.options, runCommand });
  assert.equal(noDevice.buildHostDeviceProbe.status, 'no-vulkan-device');
  assert.equal(noDevice.backends[1].gpuAcceleration, true, 'packaged capability is separate from this host');
  const failed = createBackendInventory({ ...box.options, runCommand: (command: string, args: string[], options: any) => args[0] === '--list-devices'
    ? { status: null, error: new Error('timeout') } : box.runCommand(command, args, options) });
  assert.equal(failed.buildHostDeviceProbe.status, 'failed');
  assert.equal(failed.buildHostDeviceProbe.inferenceTested, false);
  assert.equal(createBackendInventory({ ...box.options, probeDevices: false }).buildHostDeviceProbe.status, 'not-run');
});

test('backend inventory refuses missing experimental HAG payload instead of shipping an unusable opt-in', (t) => {
  const box = fixture(t);
  rmSync(join(box.packagedVendorRoot, 'beholdd-hag', 'bin', 'beholdd'));
  assert.throws(() => createBackendInventory(box.options), /missing or unsafe file/);
});

test('backend inventory refuses an unfeatured or substituted experimental HAG model', (t) => {
  const box = fixture(t);
  const names = [join(box.repositoryRoot, 'vendor', 'beholdd-hag', 'manifest.json'),
    join(box.packagedVendorRoot, 'beholdd-hag', 'manifest.json')];
  const record = JSON.parse(readFileSync(names[0], 'utf8'));
  record.cargoFeatures = [];
  for (const name of names) box.write(name, JSON.stringify(record));
  assert.throws(() => createBackendInventory(box.options), /hag-native Cargo feature/);
  record.cargoFeatures = ['hag-native'];
  const replacement = JSON.stringify({ schemaVersion: 1, architecture: 'qwen3', quantization: 'Q8_0', bytes: 42, sha256: 'f'.repeat(64) });
  record.artifacts[1].bytes = replacement.length;
  record.artifacts[1].sha256 = hash(replacement);
  for (const name of names) box.write(name, JSON.stringify(record));
  box.write(join(box.packagedVendorRoot, 'beholdd-hag', 'model.json'), replacement);
  assert.throws(() => createBackendInventory(box.options), /qualified Qwen3-0.6B/);
});
