#!/usr/bin/env node

/**
 * Import and verify the exact upstream llama.cpp Vulkan runtime used by the temporary Linux
 * compatibility service. The binary payload is ignored by Git; its deterministic manifest is
 * tracked, reviewed, and copied into clean release worktrees after this verifier succeeds.
 *
 *   node scripts/sync-llama-vulkan.mjs --archive /path/to/upstream.tar.gz
 *   node scripts/sync-llama-vulkan.mjs                 # download the pinned upstream asset
 *   node scripts/sync-llama-vulkan.mjs --verify        # offline payload verification + smoke
 *   node scripts/sync-llama-vulkan.mjs --verify --payload /packaged/vendor/llama-vulkan
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'llama-vulkan');
const SAFE_EXTRACTOR = path.join(ROOT, 'scripts', 'lib', 'safe-tar-extract.py');
const LICENSE_COPY = path.join(ROOT, 'releases', 'licenses', 'llama.cpp', 'LICENSE');
const ARCHIVE_ROOT = 'llama-b11223';
const TREE_HASH_POLICY = 'antimatter-directory-artifact-v1';
const MATERIALIZATION_POLICY = 'validated-in-tree-symlinks-as-regular-files-v1';
/**
 * b11223 rather than b10361, because b10361 cannot serve a striped glm-dsa model at all.
 *
 * Upstream #28047: the split scheduler ships compute-flagged views to the wrong RPC worker
 * whenever two or more workers are in play. The receiving worker correctly rejects the foreign
 * buffer handle in `create_node`, closes the connection, and the host aborts on `recv failed`.
 * It reproduces on deepseek4 and glm-dsa alike, which is every large MoE we stripe. The fix
 * closed 2026-09-05; b10361 was cut on 2026-08-11 and so predates it by three weeks.
 *
 * Verified against the same contract as its predecessor, and the system shared-library set is
 * byte-for-byte the same nine sonames plus the same two platform-variable ones -- no new direct
 * dependency, so nothing here was widened to make the bump pass.
 *
 * Note the version line changed shape upstream: 10361 reported `version: 10361 (14e78ddef)`,
 * while 11223 reports a semantic version with the build as a field. The smoke test matches the
 * literal string, so this is not a formatting preference.
 */
const PIN = Object.freeze({
  repository: 'https://github.com/ggml-org/llama.cpp',
  tag: 'b11223',
  commit: '4da6337767f973e2b4d0797e5b323d77d8565e4a',
  releasedAt: '2026-09-27T22:03:23Z',
  archiveName: 'llama-b11223-bin-ubuntu-vulkan-x64.tar.gz',
  archiveUrl:
    'https://github.com/ggml-org/llama.cpp/releases/download/b11223/llama-b11223-bin-ubuntu-vulkan-x64.tar.gz',
  archiveBytes: 31348616,
  archiveSha256: 'd4505b5752a967e070fb418ec1d365d4448d692eccea1d7d4d0a6e75b7300025',
  licenseSha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d',
  sourceEntries: 62,
  materializedSymlinks: 10,
  runtimeFiles: 61,
  runtimeBytes: 117076838,
  runtimeSha256: 'e621c95dda21dd9b40fb1838b42f6507a90d33aea8fd1e045b0f682b5c199de8',
  versionLine: 'version: 0.5.0-dev (build 11223, commit 4da633776)',
  buildLine: 'built with GNU 11.4.0 for Linux x86_64',
});
const KEY_ARTIFACTS = Object.freeze([
  'runtime/llama-server',
  'runtime/libggml-vulkan.so',
  'runtime/LICENSE',
]);
const SYSTEM_SHARED_LIBRARIES = Object.freeze([
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

/**
 * Sonames that appear on some distributions and not others, reached through a system
 * library's own transitive dependencies rather than by anything llama.cpp links directly.
 * Ubuntu 26.04's OpenSSL brings both; 24.04's does not, and the payload is byte-identical
 * either way. `ldd` resolves against the host, so strict equality makes the same verified
 * bytes pass on one build host and fail on another. Tolerating exactly these two keeps the
 * gate meaningful -- a genuinely new direct dependency is still a failure -- while letting
 * one pinned runtime verify on 24.04 and 26.04 alike.
 *
 * Deliberately NOT added to SYSTEM_SHARED_LIBRARIES: `sync` writes that constant into the
 * manifest, so widening it would make every manifest disagree with the 24.04 build hosts.
 */
const PLATFORM_VARIABLE_SHARED_LIBRARIES = Object.freeze(['libz.so.1', 'libzstd.so.1']);

const fail = (message) => {
  throw new Error(message);
};

/**
 * Every pinned soname must be present; beyond them only the platform-variable set is allowed.
 * Names what is wrong, because "does not match" alone sends you reading ldd output by hand.
 */
const assertSharedLibrarySet = (observed, label) => {
  const seen = [...observed].sort();
  const missing = [...SYSTEM_SHARED_LIBRARIES].filter((soname) => !seen.includes(soname));
  const unexpected = seen.filter(
    (soname) =>
      !SYSTEM_SHARED_LIBRARIES.includes(soname) && !PLATFORM_VARIABLE_SHARED_LIBRARIES.includes(soname)
  );
  if (!missing.length && !unexpected.length) return;
  const detail = [
    missing.length ? `missing ${missing.join(', ')}` : '',
    unexpected.length ? `unexpected ${unexpected.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  fail(`${label} does not match the pinned release contract (${detail})`);
};
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256File = (file) => sha256Bytes(fs.readFileSync(file));
const inside = (root, relative, label) => {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) fail(`${label} is not a relative path`);
  const resolved = path.resolve(root, relative);
  const fromRoot = path.relative(root, resolved);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    fail(`${label} escapes its root: ${relative}`);
  }
  return resolved;
};
const treeFiles = (root) => {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) fail(`runtime may not contain symbolic links: ${full}`);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) files.push(full);
      else fail(`runtime may contain only regular files and directories: ${full}`);
    }
  };
  walk(root);
  return files;
};
const hashTree = (root) => {
  const digest = createHash('sha256');
  digest.update(`${TREE_HASH_POLICY}\0`);
  for (const file of treeFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const relativeBytes = Buffer.from(relative, 'utf8');
    const contents = fs.readFileSync(file);
    const lengths = Buffer.allocUnsafe(16);
    lengths.writeBigUInt64BE(BigInt(relativeBytes.length), 0);
    lengths.writeBigUInt64BE(BigInt(contents.length), 8);
    digest.update(lengths).update(relativeBytes).update(contents);
  }
  return digest.digest('hex');
};
const measureFile = (file) => ({ bytes: fs.statSync(file).size, sha256: sha256File(file) });
const cleanEnvironment = () => ({
  PATH: '/usr/bin:/bin',
  HOME: os.tmpdir(),
  LANG: 'C',
  LC_ALL: 'C',
});

const assertHost = () => {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    fail(`the pinned runtime is for Linux x86_64; found ${process.platform}/${process.arch}`);
  }
};

const downloadArchive = async (destination) => {
  console.log(`downloading ${PIN.archiveUrl}`);
  const response = await fetch(PIN.archiveUrl, { redirect: 'follow' });
  if (!response.ok) fail(`upstream asset download failed with HTTP ${response.status}`);
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) !== PIN.archiveBytes) {
    fail(`upstream asset declares ${declaredLength} bytes, expected ${PIN.archiveBytes}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== PIN.archiveBytes) fail(`upstream asset has ${bytes.length} bytes, expected ${PIN.archiveBytes}`);
  fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
};

const validateArchive = (archive) => {
  const stat = fs.statSync(archive, { throwIfNoEntry: false });
  if (!stat?.isFile()) fail(`archive is not a regular file: ${archive}`);
  if (stat.size !== PIN.archiveBytes) fail(`archive has ${stat.size} bytes, expected ${PIN.archiveBytes}`);
  const actualHash = sha256File(archive);
  if (actualHash !== PIN.archiveSha256) fail(`archive SHA-256 is ${actualHash}, expected ${PIN.archiveSha256}`);
};

const inventoryFromReport = (runtime, report) => {
  if (report?.schemaVersion !== 1 || report.archiveRoot !== ARCHIVE_ROOT || !Array.isArray(report.files)) {
    fail('safe extractor returned an invalid report');
  }
  return report.files
    .map((entry) => {
      const file = inside(runtime, entry.path, 'extracted file');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`extracted entry is not a regular file: ${entry.path}`);
      const measured = measureFile(file);
      if (entry.bytes !== measured.bytes || entry.sha256 !== measured.sha256) {
        fail(`safe extractor report does not match ${entry.path}`);
      }
      return {
        path: entry.path,
        sourceType: entry.sourceType,
        ...(entry.sourceType === 'symlink'
          ? { linkTarget: entry.linkTarget, resolvedTarget: entry.resolvedTarget }
          : {}),
        executable: Boolean(stat.mode & 0o111),
        ...measured,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
};

const createManifest = (runtime, report) => {
  const files = inventoryFromReport(runtime, report);
  const runtimeBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const runtimeSha256 = hashTree(runtime);
  const materializedSymlinks = files.filter((file) => file.sourceType === 'symlink').length;
  if (
    report.sourceEntries !== PIN.sourceEntries ||
    materializedSymlinks !== PIN.materializedSymlinks ||
    files.length !== PIN.runtimeFiles ||
    runtimeBytes !== PIN.runtimeBytes ||
    runtimeSha256 !== PIN.runtimeSha256
  ) {
    fail('materialized runtime does not match the pinned archive tree');
  }
  const artifacts = KEY_ARTIFACTS.map((artifactPath) => {
    const file = inside(path.dirname(runtime), artifactPath, 'key artifact');
    return { path: artifactPath, type: 'file', ...measureFile(file) };
  });
  return {
    schemaVersion: 1,
    name: 'llama-vulkan',
    description: 'Pinned llama.cpp Vulkan runtime for the temporary Linux compatibility service',
    source: {
      repository: PIN.repository,
      tag: PIN.tag,
      commit: PIN.commit,
      releasedAt: PIN.releasedAt,
    },
    platform: { os: 'linux', architecture: 'x86_64', accelerator: 'Vulkan' },
    archive: {
      name: PIN.archiveName,
      url: PIN.archiveUrl,
      bytes: PIN.archiveBytes,
      sha256: PIN.archiveSha256,
    },
    extraction: {
      archiveRoot: ARCHIVE_ROOT,
      policy: MATERIALIZATION_POLICY,
      sourceEntries: report.sourceEntries,
      materializedSymlinks,
    },
    runtime: {
      path: 'runtime',
      type: 'directory',
      hashPolicy: TREE_HASH_POLICY,
      files: files.length,
      bytes: runtimeBytes,
      sha256: runtimeSha256,
    },
    artifacts,
    files,
    systemSharedLibraries: [...SYSTEM_SHARED_LIBRARIES],
    smokeTest: { command: 'runtime/llama-server --version', contains: [PIN.versionLine, PIN.buildLine] },
    license: { path: 'runtime/LICENSE', identifier: 'MIT', sha256: PIN.licenseSha256 },
  };
};

const assertJsonEqual = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} does not match the pinned release contract`);
};

const inspectElfDependencies = (runtime) => {
  const systemLibraries = new Set();
  let elfFiles = 0;
  let vulkanLinked = false;
  for (const file of treeFiles(runtime)) {
    const descriptor = fs.openSync(file, 'r');
    const magic = Buffer.alloc(4);
    try {
      fs.readSync(descriptor, magic, 0, 4, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
    elfFiles += 1;
    const result = spawnSync('ldd', [file], { cwd: runtime, encoding: 'utf8', env: cleanEnvironment() });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0 || /\bnot found\b/.test(output)) {
      fail(`shared-library resolution failed for ${path.basename(file)}: ${output.trim()}`);
    }
    if (path.basename(file) === 'libggml-vulkan.so' && /\blibvulkan\.so\.1\b/.test(output)) vulkanLinked = true;
    for (const line of output.split('\n')) {
      const match = line.match(/^\s*(\/[^\s]+|[^\s]+\.so(?:\.[^\s]+)*)\s+(?:=>|\()/);
      if (!match) continue;
      const soname = path.basename(match[1]);
      const resolved = line.match(/=>\s+(\/[^\s]+)/)?.[1];
      if (resolved && path.dirname(resolved) === runtime) continue;
      if (soname.startsWith('libggml') || soname.startsWith('libllama') || soname.startsWith('libmtmd')) continue;
      if (soname !== 'linux-vdso.so.1') systemLibraries.add(soname);
    }
  }
  if (!elfFiles) fail('runtime contains no ELF files');
  if (!vulkanLinked) fail('libggml-vulkan.so does not declare libvulkan.so.1');
  assertSharedLibrarySet(systemLibraries, 'system shared-library set');
  return elfFiles;
};

const verifyPayload = ({ smoke = true, ldd = true, vendor = VENDOR } = {}) => {
  assertHost();
  const manifestPath = path.join(vendor, 'manifest.json');
  const runtime = path.join(vendor, 'runtime');
  const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  const runtimeStat = fs.lstatSync(runtime, { throwIfNoEntry: false });
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) fail('llama-vulkan manifest is missing or unsafe');
  if (!runtimeStat?.isDirectory() || runtimeStat.isSymbolicLink()) fail('llama-vulkan runtime is missing or unsafe');
  const topLevel = fs.readdirSync(vendor).sort();
  assertJsonEqual(topLevel, ['manifest.json', 'runtime'], 'vendor/llama-vulkan payload');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.name !== 'llama-vulkan') fail('llama-vulkan manifest schema is invalid');
  assertJsonEqual(manifest.source, {
    repository: PIN.repository,
    tag: PIN.tag,
    commit: PIN.commit,
    releasedAt: PIN.releasedAt,
  }, 'source provenance');
  assertJsonEqual(manifest.archive, {
    name: PIN.archiveName,
    url: PIN.archiveUrl,
    bytes: PIN.archiveBytes,
    sha256: PIN.archiveSha256,
  }, 'archive provenance');
  assertJsonEqual(manifest.extraction, {
    archiveRoot: ARCHIVE_ROOT,
    policy: MATERIALIZATION_POLICY,
    sourceEntries: PIN.sourceEntries,
    materializedSymlinks: PIN.materializedSymlinks,
  }, 'archive extraction policy');
  if (manifest.runtime?.path !== 'runtime' || manifest.runtime?.hashPolicy !== TREE_HASH_POLICY) {
    fail('runtime tree policy does not match');
  }
  const actualFiles = treeFiles(runtime);
  const actualBytes = actualFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  if (
    actualFiles.length !== PIN.runtimeFiles ||
    actualBytes !== PIN.runtimeBytes ||
    manifest.runtime.files !== actualFiles.length ||
    manifest.runtime.bytes !== actualBytes
  ) {
    fail('runtime tree size or file count does not match manifest');
  }
  const actualTreeHash = hashTree(runtime);
  if (actualTreeHash !== PIN.runtimeSha256 || manifest.runtime.sha256 !== actualTreeHash) {
    fail(`runtime tree hash mismatch: ${actualTreeHash}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== actualFiles.length) fail('file inventory is incomplete');
  const inventoried = new Set();
  for (const entry of manifest.files) {
    const file = inside(runtime, entry.path, 'manifest file');
    if (inventoried.has(entry.path)) fail(`duplicate manifest file: ${entry.path}`);
    inventoried.add(entry.path);
    const measured = measureFile(file);
    if (entry.bytes !== measured.bytes || entry.sha256 !== measured.sha256) fail(`file hash mismatch: ${entry.path}`);
    if (Boolean(fs.statSync(file).mode & 0o111) !== entry.executable) fail(`file mode mismatch: ${entry.path}`);
    if (!['file', 'symlink'].includes(entry.sourceType)) fail(`invalid source type: ${entry.path}`);
  }
  for (const file of actualFiles) {
    const relative = path.relative(runtime, file).split(path.sep).join('/');
    if (!inventoried.has(relative)) fail(`unmanifested runtime file: ${relative}`);
  }
  const expectedArtifacts = KEY_ARTIFACTS.map((artifactPath) => ({
    path: artifactPath,
    type: 'file',
    ...measureFile(inside(vendor, artifactPath, 'key artifact')),
  }));
  assertJsonEqual(manifest.artifacts, expectedArtifacts, 'key artifact hashes');
  assertJsonEqual(manifest.systemSharedLibraries, [...SYSTEM_SHARED_LIBRARIES], 'system shared-library contract');
  if (manifest.license?.path !== 'runtime/LICENSE' || manifest.license?.sha256 !== PIN.licenseSha256) {
    fail('runtime license identity does not match');
  }
  if (sha256File(path.join(runtime, 'LICENSE')) !== PIN.licenseSha256) fail('runtime LICENSE hash mismatch');
  if (sha256File(LICENSE_COPY) !== PIN.licenseSha256) fail('tracked llama.cpp LICENSE copy does not match runtime');

  const elfFiles = ldd ? inspectElfDependencies(runtime) : 0;
  if (smoke) {
    const server = path.join(runtime, 'llama-server');
    const result = spawnSync(server, ['--version'], { cwd: runtime, encoding: 'utf8', env: cleanEnvironment() });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0 || !output.includes(PIN.versionLine) || !output.includes(PIN.buildLine)) {
      fail(`clean-environment llama-server smoke test failed: ${output.trim() || result.error}`);
    }
  }
  console.log(
    `verified llama.cpp ${PIN.tag} Vulkan runtime: ${actualFiles.length} files, ` +
      `${actualBytes} bytes, tree ${actualTreeHash}${ldd ? `, ${elfFiles} ELF files` : ''}`
  );
  return manifest;
};

const installStage = (stage) => {
  fs.mkdirSync(path.dirname(VENDOR), { recursive: true });
  const backup = `${VENDOR}.backup-${process.pid}-${randomUUID()}`;
  const hadTarget = fs.existsSync(VENDOR);
  if (hadTarget) fs.renameSync(VENDOR, backup);
  try {
    fs.renameSync(stage, VENDOR);
    if (hadTarget) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(VENDOR) && hadTarget) fs.renameSync(backup, VENDOR);
    throw error;
  }
};

const importArchive = (archive) => {
  validateArchive(archive);
  fs.mkdirSync(path.dirname(VENDOR), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(VENDOR), '.sync-llama-vulkan-'));
  try {
    const runtime = path.join(stage, 'runtime');
    const output = execFileSync('python3', [SAFE_EXTRACTOR, archive, runtime, '--root', ARCHIVE_ROOT], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const report = JSON.parse(output);
    const manifest = createManifest(runtime, report);
    fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    installStage(stage);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  verifyPayload();
};

const parseArguments = () => {
  const args = process.argv.slice(2);
  const known = new Set(['--verify', '--archive', '--payload', '--skip-smoke', '--skip-ldd']);
  for (const argument of args) {
    if (argument.startsWith('--') && !known.has(argument)) fail(`unknown option: ${argument}`);
  }
  if (args.filter((argument) => argument === '--archive').length > 1) fail('--archive may be specified only once');
  if (args.filter((argument) => argument === '--payload').length > 1) fail('--payload may be specified only once');
  const value = (name) => {
    const index = args.indexOf(name);
    if (index < 0) return null;
    const selected = args[index + 1];
    if (!selected || selected.startsWith('--')) fail(`${name} requires a path`);
    return selected;
  };
  const archive = value('--archive');
  const payload = value('--payload');
  const valueOptions = new Set(['--archive', '--payload']);
  const operands = args.filter(
    (argument, index) => !argument.startsWith('--') && !valueOptions.has(args[index - 1])
  );
  if (operands.length) fail(`unexpected arguments: ${operands.join(', ')}`);
  const verify = args.includes('--verify');
  if (verify && archive) fail('--verify cannot be combined with --archive');
  if (payload && !verify) fail('--payload is available only with --verify');
  if (!verify && (args.includes('--skip-smoke') || args.includes('--skip-ldd'))) {
    fail('--skip-smoke and --skip-ldd are verification-only options');
  }
  return {
    verify,
    archive,
    payload: payload ? path.resolve(payload) : VENDOR,
    smoke: !args.includes('--skip-smoke'),
    ldd: !args.includes('--skip-ldd'),
  };
};

const main = async () => {
  assertHost();
  const options = parseArguments();
  if (options.verify) {
    verifyPayload({ smoke: options.smoke, ldd: options.ldd, vendor: options.payload });
    return;
  }
  if (options.archive) {
    importArchive(path.resolve(options.archive));
    return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'antimatter-llama-vulkan-'));
  try {
    const archive = path.join(temporary, PIN.archiveName);
    await downloadArchive(archive);
    importArchive(archive);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
};

try {
  await main();
} catch (error) {
  console.error(`[llama-vulkan] ${error.message}`);
  process.exitCode = 1;
}
