import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const root = process.cwd();
const extractor = join(root, 'scripts', 'lib', 'safe-tar-extract.py');
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

interface ArchiveEntry {
  name: string;
  kind: 'directory' | 'file' | 'symlink' | 'hardlink' | 'fifo';
  data?: string;
  target?: string;
  mode?: number;
}

function makeArchive(work: string, entries: ArchiveEntry[]): string {
  const archive = join(work, 'fixture.tar.gz');
  const octal = (buffer: Buffer, offset: number, length: number, value: number) => {
    buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  };
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const data = Buffer.from(entry.data ?? '', 'utf8');
    header.write(entry.name, 0, 100, 'utf8');
    octal(header, 100, 8, entry.mode ?? 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, entry.kind === 'file' ? data.length : 0);
    octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(
      { directory: '5', file: '0', symlink: '2', hardlink: '1', fifo: '6' }[entry.kind],
      156,
      1,
      'ascii'
    );
    if (entry.target) header.write(entry.target, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'binary');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header);
    if (entry.kind === 'file') {
      blocks.push(data);
      if (data.length % 512) blocks.push(Buffer.alloc(512 - (data.length % 512)));
    }
  }
  blocks.push(Buffer.alloc(1024));
  writeFileSync(archive, gzipSync(Buffer.concat(blocks), { mtime: 0 }));
  return archive;
}

function extract(archive: string, destination: string, expectedRoot = 'payload') {
  return spawnSync('python3', [extractor, archive, destination, '--root', expectedRoot], {
    encoding: 'utf8',
  });
}

test('safe tar extraction materializes an in-tree symlink chain as normalized regular files', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'antimatter-safe-tar-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const archive = makeArchive(work, [
    { name: 'payload', kind: 'directory', mode: 0o777 },
    { name: 'payload/lib.real', kind: 'file', data: 'runtime-bytes', mode: 0o775 },
    { name: 'payload/lib.alias.0', kind: 'symlink', target: 'lib.real' },
    { name: 'payload/lib.alias', kind: 'symlink', target: 'lib.alias.0' },
    { name: 'payload/LICENSE', kind: 'file', data: 'license\n', mode: 0o666 },
  ]);
  const destination = join(work, 'runtime');
  const result = extract(archive, destination);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.sourceEntries, 5);
  assert.equal(report.materializedBytes, 47);
  assert.deepEqual(
    report.files.map((entry: { path: string }) => entry.path),
    ['LICENSE', 'lib.alias', 'lib.alias.0', 'lib.real']
  );
  for (const name of ['lib.real', 'lib.alias.0', 'lib.alias']) {
    const file = join(destination, name);
    assert.equal(lstatSync(file).isFile(), true);
    assert.equal(lstatSync(file).isSymbolicLink(), false);
    assert.equal(readFileSync(file, 'utf8'), 'runtime-bytes');
    assert.equal(statSync(file).mode & 0o777, 0o755);
  }
  assert.equal(statSync(join(destination, 'LICENSE')).mode & 0o777, 0o644);
  const alias = report.files.find((entry: { path: string }) => entry.path === 'lib.alias');
  assert.deepEqual(
    { sourceType: alias.sourceType, linkTarget: alias.linkTarget, resolvedTarget: alias.resolvedTarget },
    { sourceType: 'symlink', linkTarget: 'lib.alias.0', resolvedTarget: 'lib.real' }
  );
});

test('safe tar extraction rejects traversal, links outside the tree, duplicates, and special files', async (t) => {
  const malicious: { name: string; entries: ArchiveEntry[]; pattern: RegExp }[] = [
    {
      name: 'member traversal',
      entries: [{ name: 'payload/../escape', kind: 'file', data: 'bad' }],
      pattern: /not a normalized relative path/,
    },
    {
      name: 'absolute member',
      entries: [{ name: '/payload/escape', kind: 'file', data: 'bad' }],
      pattern: /not a normalized relative path/,
    },
    {
      name: 'non-normalized member',
      entries: [{ name: 'payload//alias', kind: 'file', data: 'bad' }],
      pattern: /not a normalized relative path/,
    },
    {
      name: 'escaping link',
      entries: [{ name: 'payload/link', kind: 'symlink', target: '../outside' }],
      pattern: /symbolic-link target.*not a normalized relative path/,
    },
    {
      name: 'missing link target',
      entries: [{ name: 'payload/link', kind: 'symlink', target: 'missing' }],
      pattern: /targets a missing member/,
    },
    {
      name: 'hard link',
      entries: [{ name: 'payload/link', kind: 'hardlink', target: 'payload/file' }],
      pattern: /forbidden type/,
    },
    {
      name: 'fifo',
      entries: [{ name: 'payload/pipe', kind: 'fifo' }],
      pattern: /forbidden type/,
    },
    {
      name: 'duplicate member',
      entries: [
        { name: 'payload/file', kind: 'file', data: 'one' },
        { name: 'payload/file', kind: 'file', data: 'two' },
      ],
      pattern: /duplicate member/,
    },
  ];

  for (const candidate of malicious) {
    await t.test(candidate.name, () => {
      const work = mkdtempSync(join(tmpdir(), 'antimatter-unsafe-tar-'));
      try {
        const archive = makeArchive(work, [
          { name: 'payload', kind: 'directory' },
          ...candidate.entries,
        ]);
        const destination = join(work, 'runtime');
        const result = extract(archive, destination);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, candidate.pattern);
        assert.equal(lstatSync(work).isDirectory(), true);
        assert.throws(() => lstatSync(destination), /ENOENT/);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }
});

test('llama.cpp Vulkan pins, manifest, license, and release wiring stay exact', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'vendor', 'llama-vulkan', 'manifest.json'), 'utf8'));
  // b11223, not b10361: b10361 predates the fix for upstream #28047, which makes a striped
  // glm-dsa model abort at warmup whenever two or more RPC workers are in play.
  assert.equal(manifest.source.tag, 'b11223');
  assert.equal(manifest.source.commit, '4da6337767f973e2b4d0797e5b323d77d8565e4a');
  assert.equal(manifest.archive.bytes, 31348616);
  assert.equal(manifest.archive.sha256, 'd4505b5752a967e070fb418ec1d365d4448d692eccea1d7d4d0a6e75b7300025');
  assert.equal(manifest.extraction.policy, 'validated-in-tree-symlinks-as-regular-files-v1');
  assert.equal(manifest.extraction.materializedSymlinks, 10);
  assert.equal(manifest.runtime.path, 'runtime');
  assert.equal(manifest.runtime.files, 61);
  assert.equal(manifest.runtime.sha256, 'e621c95dda21dd9b40fb1838b42f6507a90d33aea8fd1e045b0f682b5c199de8');
  assert.deepEqual(
    manifest.artifacts.map((artifact: { path: string }) => artifact.path),
    ['runtime/llama-server', 'runtime/libggml-vulkan.so', 'runtime/LICENSE']
  );
  assert.deepEqual(manifest.systemSharedLibraries, [
    'ld-linux-x86-64.so.2',
    'libc.so.6',
    'libcrypto.so.3',
    'libgcc_s.so.1',
    'libgomp.so.1',
    'libm.so.6',
    'libssl.so.3',
    'libstdc++.so.6',
    'libvulkan.so.1',
  ]);

  const license = readFileSync(join(root, 'releases', 'licenses', 'llama.cpp', 'LICENSE'));
  assert.equal(sha256(license), '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d');

  const releaseLinux = readFileSync(join(root, 'scripts', 'release-linux.mjs'), 'utf8');
  assert.match(releaseLinux, /sync-llama-vulkan\.mjs', '--verify/);
  assert.match(releaseLinux, /\['beholdd', 'beholdd-hag', 'displacer', 'llama-vulkan'\]/);
  const buildRelease = readFileSync(join(root, 'scripts', 'build-release.mjs'), 'utf8');
  assert.match(buildRelease, /embeddedLlamaVulkanRoot = path\.join\([^;]+?'llama-vulkan'\)/s);
  assert.match(buildRelease, /embeddedLlamaVulkanRoot,[\s\S]*?'runtime',[\s\S]*?'llama-server'/);
  assert.match(buildRelease, /import \{ createBackendInventory \} from '\.\/lib\/backend-inventory\.mjs'/);
  assert.match(
    buildRelease,
    /const backendInventory = createBackendInventory\(\{\s*repositoryRoot: ROOT,\s*packagedVendorRoot: path\.join\(unpacked, 'resources', 'vendor'\),\s*\}\)/,
    'the release checks Electron Builder output, not just the source vendor directory'
  );
  const backendInventory = readFileSync(join(root, 'scripts', 'lib', 'backend-inventory.mjs'), 'utf8');
  assert.match(
    backendInventory,
    /path\.join\(repositoryRoot, 'scripts', 'sync-llama-vulkan\.mjs'\), '--verify', '--payload', llamaRoot/,
    'the inventory must retain the complete canonical Vulkan payload verification'
  );
  assert.match(backendInventory, /const llamaRoot = path\.join\(packagedVendorRoot, 'llama-vulkan'\)/);
  assert.match(backendInventory, /const gpuLibrary = path\.join\(runtime, 'libggml-vulkan\.so'\);\s*regularFile\(gpuLibrary\)/);
  assert.match(buildRelease, /const expectedPublishedAssets = \[[\s\S]*?'backend-inventory\.json'[\s\S]*?\]\.sort\(\)/);
  assert.match(buildRelease, /const backendInventoryPath = path\.join\(DIST, 'backend-inventory\.json'\)/);
  assert.match(buildRelease, /fs\.writeFileSync\(backendInventoryPath, [^;]*JSON\.stringify\(backendInventory, null, 2\)/);
  assert.match(buildRelease, /copyFile\(backendInventoryPath, path\.join\(appRoot, 'backend-inventory\.json'\)\)/);
  assert.match(buildRelease, /backendInventory: \{ name: 'backend-inventory\.json', sha256: sha256\(backendInventoryPath\) \}/);
  assert.match(buildRelease, /LLAMA_CPP_LICENSE\.txt/);
  assert.match(buildRelease, /\['beholdd', 'beholdd-hag', 'displacer', 'llama-vulkan'\]/);

  const installer = readFileSync(join(root, 'releases', 'linux-x86_64', 'install.sh'), 'utf8');
  for (const critical of [
    'resources/vendor/llama-vulkan/manifest.json',
    'resources/vendor/llama-vulkan/runtime/llama-server',
    'resources/vendor/llama-vulkan/runtime/libggml-vulkan.so',
    'resources/vendor/llama-vulkan/runtime/LICENSE',
  ]) {
    assert.ok(installer.includes(critical), `installer does not validate ${critical}`);
  }
  assert.ok(installer.includes(manifest.runtime.sha256));
});
