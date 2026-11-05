/** Verify the backends Electron Builder actually shipped, then describe their real capabilities. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cleanEnvironment = () => ({ PATH: '/usr/bin:/bin', HOME: os.tmpdir(), LANG: 'C', LC_ALL: 'C' });
const fail = (message) => { throw new Error(`Packaged backend verification: ${message}`); };

function regularFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`missing or unsafe file: ${file}`);
  return stat;
}

function payloadFiles(root) {
  const files = [];
  const visit = (directory) => {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`missing or unsafe directory: ${directory}`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        regularFile(file);
        files.push(path.relative(root, file).split(path.sep).join('/'));
      }
    }
  };
  visit(root);
  return files.sort();
}

function manifest(root, expectedRoot) {
  const file = path.join(root, 'manifest.json');
  const expected = path.join(expectedRoot, 'manifest.json');
  regularFile(file);
  regularFile(expected);
  if (sha256(file) !== sha256(expected)) fail(`${path.basename(root)} manifest differs from its reviewed source manifest`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function relativeArtifact(root, artifact) {
  if (typeof artifact !== 'string' || !artifact || path.isAbsolute(artifact)) fail('artifact path must be relative');
  const full = path.resolve(root, artifact);
  const relative = path.relative(root, full);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    fail(`artifact escapes its payload: ${artifact}`);
  }
  return full;
}

function checkedRun(runCommand, command, args, cwd, label) {
  const result = runCommand(command, args, {
    cwd, encoding: 'utf8', env: cleanEnvironment(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(`${label} failed${result.error ? ` (${result.error.message})` : ` (exit ${result.status})`}: ${result.stderr ?? ''}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function verifyBeholdd(root, expectedRoot, runCommand, name = 'beholdd') {
  const files = payloadFiles(root);
  const recorded = manifest(root, expectedRoot);
  if (recorded.schemaVersion !== 1 || recorded.name !== name || !Array.isArray(recorded.artifacts)) {
    fail('Beholdd manifest identity is invalid');
  }
  if (recorded.dirty !== false || !/^[0-9a-f]{40}$/.test(recorded.commit ?? '')) fail('Beholdd source is not a clean exact commit');
  const expectedFiles = ['manifest.json'];
  for (const artifact of recorded.artifacts) {
    if (artifact.type !== 'file') fail(`unsupported Beholdd artifact type: ${artifact.type}`);
    const file = relativeArtifact(root, artifact.path);
    const stat = regularFile(file);
    if (stat.size !== artifact.bytes || sha256(file) !== artifact.sha256) fail(`Beholdd artifact identity differs: ${artifact.path}`);
    expectedFiles.push(artifact.path);
  }
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles.sort())) fail('Beholdd payload contains missing or unexpected files');
  const binary = path.join(root, 'bin', 'beholdd');
  if (!(regularFile(binary).mode & 0o111)) fail('Beholdd executable lost its executable mode');
  const libraries = checkedRun(runCommand, 'ldd', [binary], path.dirname(binary), 'Beholdd clean shared-library resolution');
  if (/\bnot found\b/.test(libraries)) fail('Beholdd has unresolved shared libraries');
  const systemSharedLibraries = [...new Set([...libraries.matchAll(/^\s*(\/[^\s]+|[^\s]+\.so(?:\.[^\s]+)*)\s+(?:=>|\()/gm)]
    .map((match) => path.basename(match[1])).filter((name) => name !== 'linux-vdso.so.1'))].sort();
  return { recorded, manifestSha256: sha256(path.join(root, 'manifest.json')), systemSharedLibraries };
}

function deviceProbe(binary, runCommand, enabled) {
  if (!enabled) return { status: 'not-run', devices: [], inferenceTested: false };
  const result = runCommand(binary, ['--list-devices'], {
    cwd: path.dirname(binary), encoding: 'utf8', env: cleanEnvironment(), timeout: 15_000, maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { status: 'failed', devices: [], inferenceTested: false, exitCode: result.status ?? null };
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const devices = [...output.matchAll(/^\s*(Vulkan\d+):\s*(.+)$/gm)]
    .map((match) => ({ id: match[1], description: match[2].trim().slice(0, 512) }));
  return { status: devices.length ? 'available' : 'no-vulkan-device', devices, inferenceTested: false };
}

/**
 * No models are loaded. Device enumeration is evidence about this build host only, never a
 * hardware requirement or a claim of cross-vendor inference qualification. runCommand is the
 * subprocess seam for fixture tests; production callers use spawnSync unchanged.
 */
export function createBackendInventory({ repositoryRoot, packagedVendorRoot, probeDevices = true, runCommand = spawnSync }) {
  const beholddRoot = path.join(packagedVendorRoot, 'beholdd');
  const llamaRoot = path.join(packagedVendorRoot, 'llama-vulkan');
  const hagRoot = path.join(packagedVendorRoot, 'beholdd-hag');
  const native = verifyBeholdd(beholddRoot, path.join(repositoryRoot, 'vendor', 'beholdd'), runCommand);
  const hag = verifyBeholdd(hagRoot, path.join(repositoryRoot, 'vendor', 'beholdd-hag'), runCommand, 'beholdd-hag');
  if (JSON.stringify(hag.recorded.cargoFeatures) !== JSON.stringify(['hag-native'])) {
    fail('experimental HAG executable must record its hag-native Cargo feature');
  }
  const hagModel = JSON.parse(fs.readFileSync(path.join(hagRoot, 'model.json'), 'utf8'));
  if (hagModel.schemaVersion !== 1 || hagModel.architecture !== 'qwen3' || hagModel.quantization !== 'Q8_0' ||
      hagModel.bytes !== 639447744 || hagModel.sha256 !== 'e150ed544dfe6016930c026a93913a5e3184181ebfe6ab2223ae01dd0491784c') {
    fail('experimental HAG model is not the qualified Qwen3-0.6B Q8_0 checkpoint');
  }
  const llama = manifest(llamaRoot, path.join(repositoryRoot, 'vendor', 'llama-vulkan'));
  const runtime = path.join(llamaRoot, 'runtime');
  const gpuLibrary = path.join(runtime, 'libggml-vulkan.so');
  regularFile(gpuLibrary);
  if (llama.name !== 'llama-vulkan' || llama.platform?.accelerator !== 'Vulkan') fail('the GPU payload is not the Vulkan runtime');
  // One canonical verifier owns the pinned tree, all per-file hashes/modes, symlink rejection,
  // version smoke and every ELF dependency. Missing GPU libraries cannot become a CPU fallback.
  checkedRun(runCommand, process.execPath, [
    path.join(repositoryRoot, 'scripts', 'sync-llama-vulkan.mjs'), '--verify', '--payload', llamaRoot,
  ], repositoryRoot, 'complete Vulkan payload verification');
  const binary = path.join(runtime, 'llama-server');
  const gpuArtifact = llama.artifacts?.find((artifact) => artifact.path === 'runtime/libggml-vulkan.so');
  if (!gpuArtifact || sha256(gpuLibrary) !== gpuArtifact.sha256) fail('Vulkan GPU library does not match its manifest');
  return {
    schemaVersion: 1,
    platform: { os: 'linux', architecture: 'x86_64' },
    verifiedFrom: 'packaged-resources/vendor',
    backends: [
      {
        id: 'bundled-beholdd', name: 'Beholdd native CPU', implementation: 'beholdd', execution: ['cpu'],
        gpuAcceleration: false, source: { repository: native.recorded.source, version: native.recorded.version, commit: native.recorded.commit },
        manifest: { path: 'vendor/beholdd/manifest.json', sha256: native.manifestSha256 },
        artifacts: native.recorded.artifacts,
        systemSharedLibraries: native.systemSharedLibraries,
      },
      {
        id: 'bundled-llama-vulkan', name: 'llama.cpp compatibility (Vulkan)', implementation: 'llama.cpp',
        execution: ['vulkan-gpu', 'cpu'], gpuAcceleration: true, nativeBeholdd: false,
        placement: 'Adaptive Vulkan GPU offload with CPU spill; performance depends on available device memory.',
        source: llama.source,
        manifest: { path: 'vendor/llama-vulkan/manifest.json', sha256: sha256(path.join(llamaRoot, 'manifest.json')) },
        runtime: llama.runtime, gpuLibrary: gpuArtifact,
        systemSharedLibraries: llama.systemSharedLibraries,
        license: { identifier: llama.license.identifier, path: 'vendor/llama-vulkan/runtime/LICENSE', sha256: llama.license.sha256 },
      },
      {
        id: 'bundled-beholdd-hag', name: 'Beholdd HAG (experimental)', implementation: 'beholdd',
        execution: ['hag-native-gpu'], gpuAcceleration: true, nativeBeholdd: true,
        experimental: true, enabledByDefault: false, cargoFeatures: hag.recorded.cargoFeatures,
        source: { repository: hag.recorded.source, version: hag.recorded.version, commit: hag.recorded.commit },
        manifest: { path: 'vendor/beholdd-hag/manifest.json', sha256: hag.manifestSha256 },
        artifacts: hag.recorded.artifacts, systemSharedLibraries: hag.systemSharedLibraries,
        model: { path: 'vendor/beholdd-hag/model.json', id: hagModel.id, bytes: hagModel.bytes, sha256: hagModel.sha256 },
        supportedHost: { os: 'linux', architecture: 'x86_64', pciVendor: '0x1002', pciDevice: '0x1586', gpuArchitecture: 'gfx1151' },
        qualification: 'Pinned Qwen3-0.6B Q8_0 text-only preview: up to 64 output tokens and a conservative 1,024-position total budget; the complete 8,079-token tool prompt is not qualified.',
        buildHostDeviceProbe: { status: 'not-run', inferenceTested: false, reason: 'Packaging never opens the HAG compute device.' },
      },
    ],
    hostPrerequisites: {
      vulkan: ['libvulkan.so.1 loader', 'Working GPU-vendor or Mesa Vulkan ICD/driver'],
      openssl: ['libssl.so.3', 'libcrypto.so.3'],
      gpuDriversBundled: false,
      cudaRuntimeBundled: false,
      hag: ['AMD 0x1002:0x1586 GFX1151 on Linux x86_64', 'Accessible amdgpu render node and systemd user session'],
      notes: 'Vulkan compatibility and a separate opt-in native HAG backend are packaged alongside the unchanged Beholdd CPU fallback. GPU drivers, kernel modules, firmware and ICD configuration are provided by the host.',
    },
    buildHostDeviceProbe: {
      scope: 'Build-host enumeration only; not a full-model or cross-vendor inference test.',
      ...deviceProbe(binary, runCommand, probeDevices),
    },
  };
}
