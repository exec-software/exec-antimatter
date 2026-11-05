#!/usr/bin/env node
// Cuts release builds of the companion projects Antimatter ships and copies their artifacts
// into vendor/<name>/, together with canonical, reproducible provenance. Nothing under vendor is
// replaced until every selected dependency has built, copied, and verified in staging.
//
//   npm run deps:sync                              build and copy every dependency
//   npm run deps:sync -- beholdd                   only the named ones
//   npm run deps:sync -- --skip-build beholdd      copy an already-built dependency
//   npm run deps:sync -- --release                 refuse dirty dependency worktrees
//   node scripts/sync-deps.mjs --verify beholdd    verify checked-in artifacts for release
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const CONFIG_PATH = path.join(ROOT, 'scripts', 'deps.json');
const SUPPORTED_FLAGS = new Set(['--skip-build', '--release', '--verify']);
const ENCODED_RUSTFLAGS_SEPARATOR = '\x1f';
const RUST_PATH_REMAP_POLICY = 'cargo-rust-path-remapping-v1';
const ARTIFACT_STRING_SCAN_POLICY = 'artifact-forbidden-strings-v1';

const run = (command, commandArgs, cwd) =>
  execFileSync(command, commandArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const inside = (base, relative, label) => {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const resolved = path.resolve(base, relative);
  const fromBase = path.relative(base, resolved);
  if (!fromBase || fromBase === '..' || fromBase.startsWith(`..${path.sep}`) || path.isAbsolute(fromBase)) {
    throw new Error(`${label} escapes its root: ${relative}`);
  }
  return resolved;
};

const repositoryUrl = (value, label) => {
  if (typeof value !== 'string') throw new Error(`${label} is missing a repository URL`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid repository URL: ${value}`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname || parsed.search || parsed.hash) {
    throw new Error(`${label} must be a canonical HTTPS repository URL`);
  }
  return value.replace(/\/+$/, '').replace(/\.git$/, '');
};

const canonicalRepository = (value) => {
  const trimmed = value.trim();
  const ssh = trimmed.match(/^git@([^:]+):(.+)$/);
  const normalized = ssh ? `https://${ssh[1]}/${ssh[2]}` : trimmed.replace(/^ssh:\/\/git@([^/]+)\//, 'https://$1/');
  return normalized.replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();
};

const gitFacts = (source, configuredRepository, requireMatchingRemote) => {
  let commit;
  let committedAt;
  let dirty;
  let remote = null;
  try {
    commit = run('git', ['rev-parse', 'HEAD'], source);
    committedAt = run('git', ['log', '-1', '--format=%cI'], source);
    dirty = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], source).length > 0;
    try {
      remote = run('git', ['remote', 'get-url', 'origin'], source);
    } catch {
      // A development worktree can be useful without an origin. Release mode cannot.
    }
  } catch (error) {
    throw new Error(`cannot read Git provenance for ${source}: ${error.message}`);
  }

  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error(`Git returned a non-exact commit for ${source}: ${commit}`);
  }
  if (requireMatchingRemote) {
    if (!remote) throw new Error(`release source ${source} has no origin remote`);
    if (canonicalRepository(remote) !== canonicalRepository(configuredRepository)) {
      throw new Error(`release source ${source} points at ${remote}, expected ${configuredRepository}`);
    }
  }
  return { commit, committedAt, dirty };
};

/** Best-effort version for provenance: Cargo workspace/package version, or package.json. */
const readVersion = (source, versionFrom) => {
  if (!versionFrom) return null;
  const file = inside(source, versionFrom, 'versionFrom');
  if (!fs.existsSync(file)) return null;
  if (versionFrom.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null;
  const match = fs.readFileSync(file, 'utf8').match(/^version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
};

const hashFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Files in a tree, in the same stable order used for hashing and size accounting. */
const treeFiles = (dir) => {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`artifact trees may not contain symbolic links: ${full}`);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) files.push(full);
      else throw new Error(`artifact trees may contain only files and directories: ${full}`);
    }
  };
  walk(dir);
  return files;
};

/** For a directory artifact, hash every file's path and contents in a stable order. */
const hashTree = (dir) => {
  const digest = createHash('sha256');
  digest.update('antimatter-directory-artifact-v1\0');
  for (const file of treeFiles(dir)) {
    const relative = path.relative(dir, file).split(path.sep).join('/');
    const relativeBytes = Buffer.from(relative, 'utf8');
    const contents = fs.readFileSync(file);
    const lengths = Buffer.allocUnsafe(16);
    lengths.writeBigUInt64BE(BigInt(relativeBytes.length), 0);
    lengths.writeBigUInt64BE(BigInt(contents.length), 8);
    digest.update(lengths).update(relativeBytes).update(contents);
  }
  return digest.digest('hex');
};

const treeSize = (dir) => treeFiles(dir).reduce((total, file) => total + fs.statSync(file).size, 0);

const formatBytes = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;

const validateDependency = (dependency) => {
  if (!dependency || typeof dependency !== 'object') throw new Error('dependency entries must be objects');
  if (typeof dependency.name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(dependency.name)) {
    throw new Error(`invalid dependency name: ${dependency.name}`);
  }
  if (typeof dependency.source !== 'string' || !dependency.source) {
    throw new Error(`${dependency.name}.source must be a non-empty path relative to the Antimatter root`);
  }
  if (dependency.sourceEnv !== undefined) {
    if (typeof dependency.sourceEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(dependency.sourceEnv)) {
      throw new Error(`${dependency.name}.sourceEnv must be an uppercase environment variable name`);
    }
    if (Object.hasOwn(process.env, dependency.sourceEnv) && !process.env[dependency.sourceEnv]) {
      throw new Error(`${dependency.sourceEnv} is set but empty`);
    }
  }
  const configuredSource = dependency.sourceEnv ? process.env[dependency.sourceEnv] ?? dependency.source : dependency.source;
  dependency.source = path.resolve(ROOT, configuredSource);
  dependency.repository = repositoryUrl(dependency.repository, `${dependency.name}.repository`);
  if (!dependency.build || typeof dependency.build.command !== 'string' || !Array.isArray(dependency.build.args)) {
    throw new Error(`${dependency.name}.build must contain a command and argument array`);
  }
  if (!dependency.build.args.every((argument) => typeof argument === 'string')) {
    throw new Error(`${dependency.name}.build arguments must all be strings`);
  }
  if (dependency.build.rustPathRemapping !== undefined && typeof dependency.build.rustPathRemapping !== 'boolean') {
    throw new Error(`${dependency.name}.build.rustPathRemapping must be a boolean`);
  }
  if (dependency.sourceCommit !== undefined && !/^[0-9a-f]{40}$/.test(dependency.sourceCommit)) {
    throw new Error(`${dependency.name}.sourceCommit must be an exact commit`);
  }
  if (dependency.build.cargoFeatures !== undefined) {
    const features = dependency.build.cargoFeatures;
    if (!Array.isArray(features) || !features.length || new Set(features).size !== features.length ||
        !features.every((value) => typeof value === 'string' && /^[a-z0-9_-]+$/.test(value))) {
      throw new Error(`${dependency.name}.build.cargoFeatures must be unique feature names`);
    }
    const index = dependency.build.args.indexOf('--features');
    if (dependency.build.command !== 'cargo' || index < 0 ||
        dependency.build.args[index + 1] !== features.join(',')) {
      throw new Error(`${dependency.name}: configured Cargo features differ from its build command`);
    }
  }
  if (!Array.isArray(dependency.artifacts) || dependency.artifacts.length === 0) {
    throw new Error(`${dependency.name}.artifacts must be a non-empty array`);
  }

  const destinations = [];
  for (const [index, artifact] of dependency.artifacts.entries()) {
    if (artifact.fromProject !== undefined && typeof artifact.fromProject !== 'boolean') {
      throw new Error(`${dependency.name}.artifacts[${index}].fromProject must be a boolean`);
    }
    inside(artifact.fromProject ? ROOT : dependency.source, artifact.from, `${dependency.name}.artifacts[${index}].from`);
    inside(path.join(VENDOR_DIR, dependency.name), artifact.to, `${dependency.name}.artifacts[${index}].to`);
    if (artifact.executable !== undefined && typeof artifact.executable !== 'boolean') {
      throw new Error(`${dependency.name}.artifacts[${index}].executable must be a boolean`);
    }
    if (artifact.releaseForbiddenStrings !== undefined) {
      if (
        !Array.isArray(artifact.releaseForbiddenStrings) ||
        artifact.releaseForbiddenStrings.length === 0 ||
        !artifact.releaseForbiddenStrings.every((value) => typeof value === 'string' && value.length > 0)
      ) {
        throw new Error(
          `${dependency.name}.artifacts[${index}].releaseForbiddenStrings must be a non-empty string array`
        );
      }
    }
    const normalized = path.normalize(artifact.to);
    if (
      destinations.some(
        (other) => normalized === other || normalized.startsWith(`${other}${path.sep}`) || other.startsWith(`${normalized}${path.sep}`)
      )
    ) {
      throw new Error(`${dependency.name} has overlapping artifact destination ${artifact.to}`);
    }
    destinations.push(normalized);
  }
  return dependency;
};

const readConfiguration = () => {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!Array.isArray(config.dependencies)) throw new Error('scripts/deps.json must contain a dependencies array');
  const seen = new Set();
  for (const dependency of config.dependencies) {
    validateDependency(dependency);
    if (seen.has(dependency.name)) throw new Error(`duplicate dependency name: ${dependency.name}`);
    seen.add(dependency.name);
  }
  return config;
};

const selectedDependencies = (config, wanted) => {
  const known = new Set(config.dependencies.map((dependency) => dependency.name));
  const unknown = wanted.filter((name) => !known.has(name));
  if (unknown.length) throw new Error(`unknown dependencies: ${unknown.join(', ')} (known: ${[...known].join(', ')})`);
  return config.dependencies.filter((dependency) => wanted.length === 0 || wanted.includes(dependency.name));
};

const artifactMeasurement = (artifactPath) => {
  const stat = fs.lstatSync(artifactPath);
  if (stat.isSymbolicLink()) throw new Error(`artifact may not be a symbolic link: ${artifactPath}`);
  if (stat.isDirectory()) return { type: 'directory', bytes: treeSize(artifactPath), sha256: hashTree(artifactPath) };
  if (stat.isFile()) return { type: 'file', bytes: stat.size, sha256: hashFile(artifactPath) };
  throw new Error(`artifact must be a regular file or directory: ${artifactPath}`);
};

const configuredReleasePolicies = (dependency) => [
  ...(dependency.build.rustPathRemapping ? [RUST_PATH_REMAP_POLICY] : []),
  ...(dependency.artifacts.some((artifact) => artifact.releaseForbiddenStrings) ? [ARTIFACT_STRING_SCAN_POLICY] : []),
];

const filesInArtifact = (artifactPath) =>
  fs.lstatSync(artifactPath).isDirectory() ? treeFiles(artifactPath) : [artifactPath];

const assertNoForbiddenStrings = (artifactPath, forbiddenStrings, label) => {
  if (forbiddenStrings.length === 0) return;
  const forbidden = forbiddenStrings.map((value) => ({ value, bytes: Buffer.from(value, 'utf8') }));
  for (const file of filesInArtifact(artifactPath)) {
    const contents = fs.readFileSync(file);
    for (const candidate of forbidden) {
      if (contents.includes(candidate.bytes)) {
        throw new Error(`${label} contains forbidden release string ${JSON.stringify(candidate.value)}`);
      }
    }
  }
};

/**
 * Cargo passes CARGO_ENCODED_RUSTFLAGS to every target crate, unlike a shell-quoted
 * RUSTFLAGS string. Release builds use it to replace machine-specific source/cache paths
 * with deterministic virtual paths before rustc writes panic locations and debug metadata.
 */
const releaseBuildPlan = (dependency, { release, skipBuild }) => {
  if (!release || !dependency.build.rustPathRemapping) {
    return {
      environment: undefined,
      localBuildPaths: [],
      releasePolicies: release ? configuredReleasePolicies(dependency) : [],
    };
  }

  const home = path.resolve(process.env.HOME || homedir());
  const candidates = [
    [home, '/usr/src/antimatter/home'],
    [
      process.env.CARGO_HOME ? path.resolve(process.env.CARGO_HOME) : home && path.join(home, '.cargo'),
      '/usr/src/antimatter/cargo',
    ],
    [
      process.env.RUSTUP_HOME ? path.resolve(process.env.RUSTUP_HOME) : home && path.join(home, '.rustup'),
      '/usr/src/antimatter/rustup',
    ],
    [dependency.source, `/usr/src/antimatter/deps/${dependency.name}`],
  ];
  const mappings = [];
  const seen = new Set();
  for (const [source, destination] of candidates) {
    if (!source) continue;
    for (const spelling of [source, fs.existsSync(source) ? fs.realpathSync(source) : source]) {
      if (seen.has(spelling)) continue;
      if (spelling.includes(ENCODED_RUSTFLAGS_SEPARATOR)) {
        throw new Error(`${dependency.name}: a build path contains Cargo's encoded flag separator`);
      }
      seen.add(spelling);
      mappings.push([spelling, destination]);
    }
  }

  let environment;
  if (!skipBuild) {
    if (process.env.RUSTFLAGS?.trim() && !process.env.CARGO_ENCODED_RUSTFLAGS) {
      throw new Error(
        `${dependency.name}: release path remapping cannot safely combine shell-form RUSTFLAGS; ` +
          'use CARGO_ENCODED_RUSTFLAGS instead'
      );
    }
    const existing = process.env.CARGO_ENCODED_RUSTFLAGS
      ? process.env.CARGO_ENCODED_RUSTFLAGS.split(ENCODED_RUSTFLAGS_SEPARATOR).filter(Boolean)
      : [];
    const remapping = mappings.map(([source, destination]) => `--remap-path-prefix=${source}=${destination}`);
    environment = {
      ...process.env,
      CARGO_ENCODED_RUSTFLAGS: [...existing, ...remapping].join(ENCODED_RUSTFLAGS_SEPARATOR),
    };
  }

  return {
    environment,
    localBuildPaths: mappings.map(([source]) => source),
    releasePolicies: configuredReleasePolicies(dependency),
  };
};

const assertManifest = (
  root,
  dependency,
  { allowDirty, enforceReleasePolicies = !allowDirty, localBuildPaths = [] }
) => {
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`${dependency.name}: missing manifest.json`);
  if (!fs.lstatSync(manifestPath).isFile()) throw new Error(`${dependency.name}: manifest.json is not a regular file`);
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`${dependency.name}: invalid manifest.json: ${error.message}`);
  }

  if (manifest.schemaVersion !== 1) throw new Error(`${dependency.name}: unsupported manifest schema`);
  if (manifest.name !== dependency.name) throw new Error(`${dependency.name}: manifest name does not match`);
  if (manifest.source !== dependency.repository) throw new Error(`${dependency.name}: manifest source repository does not match`);
  if (dependency.source && manifestText.includes(dependency.source)) {
    throw new Error(`${dependency.name}: manifest leaks its local source path`);
  }
  if (!/^[0-9a-f]{40,64}$/i.test(manifest.commit ?? '')) {
    throw new Error(`${dependency.name}: manifest does not record an exact Git commit`);
  }
  if (dependency.sourceCommit && manifest.commit !== dependency.sourceCommit) {
    throw new Error(`${dependency.name}: manifest differs from the pinned source commit`);
  }
  if (dependency.build.cargoFeatures &&
      JSON.stringify(manifest.cargoFeatures) !== JSON.stringify(dependency.build.cargoFeatures)) {
    throw new Error(`${dependency.name}: manifest Cargo features differ from the configured build`);
  }
  if (typeof manifest.committedAt !== 'string' || !manifest.committedAt) {
    throw new Error(`${dependency.name}: manifest has no commit timestamp`);
  }
  if (typeof manifest.builtAt !== 'string' || !manifest.builtAt) {
    throw new Error(`${dependency.name}: manifest has no build timestamp`);
  }
  if (!allowDirty && manifest.dirty !== false) {
    throw new Error(`${dependency.name}: manifest was produced from a dirty dependency tree`);
  }
  if (enforceReleasePolicies) {
    const recordedPolicies = new Set(Array.isArray(manifest.releasePolicies) ? manifest.releasePolicies : []);
    for (const policy of configuredReleasePolicies(dependency)) {
      if (!recordedPolicies.has(policy)) {
        throw new Error(`${dependency.name}: manifest is missing release policy ${policy}`);
      }
    }
  }
  if (!Array.isArray(manifest.artifacts)) throw new Error(`${dependency.name}: manifest artifacts are invalid`);

  const expectedPaths = new Set(dependency.artifacts.map((artifact) => path.normalize(artifact.to)));
  const manifestedPaths = new Set();
  for (const artifact of manifest.artifacts) {
    const normalized = path.normalize(artifact.path ?? '');
    if (!expectedPaths.has(normalized)) throw new Error(`${dependency.name}: unexpected manifested artifact ${artifact.path}`);
    if (manifestedPaths.has(normalized)) throw new Error(`${dependency.name}: duplicate manifested artifact ${artifact.path}`);
    manifestedPaths.add(normalized);
    const artifactPath = inside(root, normalized, `${dependency.name} manifest artifact`);
    if (!fs.existsSync(artifactPath)) throw new Error(`${dependency.name}: missing artifact ${artifact.path}`);
    const measured = artifactMeasurement(artifactPath);
    if (artifact.type !== measured.type) throw new Error(`${dependency.name}: type mismatch for ${artifact.path}`);
    if (artifact.bytes !== measured.bytes) throw new Error(`${dependency.name}: size mismatch for ${artifact.path}`);
    if (artifact.sha256 !== measured.sha256) throw new Error(`${dependency.name}: hash mismatch for ${artifact.path}`);

    const expected = dependency.artifacts.find((candidate) => path.normalize(candidate.to) === normalized);
    if (expected?.executable && measured.type === 'file' && (fs.statSync(artifactPath).mode & 0o111) === 0) {
      throw new Error(`${dependency.name}: executable artifact is not executable: ${artifact.path}`);
    }
    if (expected?.fromProject) {
      const source = inside(ROOT, expected.from, `${dependency.name} project artifact`);
      const original = artifactMeasurement(source);
      if (original.type !== artifact.type || original.bytes !== artifact.bytes || original.sha256 !== artifact.sha256) {
        throw new Error(`${dependency.name}: project artifact differs from its reviewed input: ${artifact.path}`);
      }
    }
    if (enforceReleasePolicies && expected?.releaseForbiddenStrings) {
      assertNoForbiddenStrings(
        artifactPath,
        [...new Set([...expected.releaseForbiddenStrings, ...localBuildPaths])],
        `${dependency.name}: artifact ${artifact.path}`
      );
    }
  }
  if (manifestedPaths.size !== expectedPaths.size) {
    const missing = [...expectedPaths].filter((artifact) => !manifestedPaths.has(artifact));
    throw new Error(`${dependency.name}: manifest omits configured artifacts: ${missing.join(', ')}`);
  }

  // Refuse payloads which are not covered by a configured file or directory artifact.
  for (const file of treeFiles(root)) {
    const relative = path.relative(root, file);
    if (relative === 'manifest.json') continue;
    const covered = manifest.artifacts.some((artifact) => {
      const artifactPath = path.normalize(artifact.path);
      return artifact.type === 'directory'
        ? relative.startsWith(`${artifactPath}${path.sep}`)
        : relative === artifactPath;
    });
    if (!covered) throw new Error(`${dependency.name}: unmanifested artifact ${relative}`);
  }
  return manifest;
};

const stageDependency = (dependency, facts, { skipBuild, release, buildPlan }) => {
  const stage = fs.mkdtempSync(path.join(VENDOR_DIR, `.sync-${dependency.name}-`));
  const copied = [];
  try {
    for (const artifact of dependency.artifacts) {
      const from = inside(artifact.fromProject ? ROOT : dependency.source, artifact.from, `${dependency.name} artifact source`);
      if (!fs.existsSync(from)) throw new Error(`${dependency.name}: artifact missing after build: ${artifact.from}`);
      const to = inside(stage, artifact.to, `${dependency.name} artifact destination`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const sourceStat = fs.lstatSync(from);
      if (sourceStat.isSymbolicLink()) throw new Error(`${dependency.name}: artifact source is a symbolic link: ${artifact.from}`);
      fs.cpSync(from, to, { recursive: sourceStat.isDirectory() });
      if (artifact.executable) fs.chmodSync(to, 0o755);
      const measured = artifactMeasurement(to);
      copied.push({ path: artifact.to, type: measured.type, bytes: measured.bytes, sha256: measured.sha256 });
      console.log(`  staged ${artifact.to.padEnd(28)} ${formatBytes(measured.bytes).padStart(9)}`);
    }

    const manifest = {
      schemaVersion: 1,
      name: dependency.name,
      description: dependency.description ?? null,
      source: dependency.repository,
      version: readVersion(dependency.source, dependency.versionFrom),
      ...facts,
      builtAt: new Date().toISOString(),
      builtBy: skipBuild ? 'existing build (--skip-build)' : `${dependency.build.command} ${dependency.build.args.join(' ')}`,
      releasePolicies: buildPlan.releasePolicies,
      ...(dependency.build.cargoFeatures ? { cargoFeatures: dependency.build.cargoFeatures } : {}),
      artifacts: copied,
    };
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    if (serialized.includes(dependency.source)) throw new Error(`${dependency.name}: refusing to write local source path to manifest`);
    fs.writeFileSync(path.join(stage, 'manifest.json'), serialized);
    assertManifest(stage, dependency, {
      allowDirty: true,
      enforceReleasePolicies: release,
      localBuildPaths: buildPlan.localBuildPaths,
    });
    return { dependency, stage, manifest };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
};

/** Install every fully verified stage, restoring all old targets if any rename fails. */
const installStages = (prepared) => {
  const installed = [];
  try {
    for (const item of prepared) {
      const target = path.join(VENDOR_DIR, item.dependency.name);
      const backup = path.join(VENDOR_DIR, `.sync-backup-${item.dependency.name}-${randomUUID()}`);
      const hadTarget = fs.existsSync(target);
      if (hadTarget) fs.renameSync(target, backup);
      try {
        fs.renameSync(item.stage, target);
      } catch (error) {
        if (hadTarget) fs.renameSync(backup, target);
        throw error;
      }
      installed.push({ ...item, target, backup: hadTarget ? backup : null });
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of installed.reverse()) {
      try {
        fs.renameSync(item.target, item.stage);
        if (item.backup) fs.renameSync(item.backup, item.target);
      } catch (rollbackError) {
        rollbackErrors.push(`${item.dependency.name}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length) {
      throw new Error(`${error.message}; rollback also failed (${rollbackErrors.join('; ')})`);
    }
    throw error;
  }

  for (const item of installed) {
    if (item.backup) fs.rmSync(item.backup, { recursive: true, force: true });
    item.stage = null;
  }
};

const parseArguments = () => {
  const args = process.argv.slice(2);
  const unknownFlags = args.filter((argument) => argument.startsWith('--') && !SUPPORTED_FLAGS.has(argument));
  if (unknownFlags.length) throw new Error(`unknown options: ${unknownFlags.join(', ')}`);
  const flags = new Set(args.filter((argument) => argument.startsWith('--')));
  if (flags.has('--verify') && (flags.has('--skip-build') || flags.has('--release'))) {
    throw new Error('--verify cannot be combined with --skip-build or --release');
  }
  return {
    skipBuild: flags.has('--skip-build'),
    release: flags.has('--release'),
    verify: flags.has('--verify'),
    wanted: args.filter((argument) => !argument.startsWith('--')),
  };
};

const main = () => {
  const options = parseArguments();
  const config = readConfiguration();
  const selected = selectedDependencies(config, options.wanted);

  if (options.verify) {
    for (const dependency of selected) {
      assertManifest(path.join(VENDOR_DIR, dependency.name), dependency, {
        allowDirty: false,
        enforceReleasePolicies: true,
      });
      console.log(`verified ${dependency.name}`);
    }
    return;
  }

  // Refuse release dirt before doing expensive builds, then check again afterward in case a
  // build command changed a tracked file.
  if (options.release) {
    for (const dependency of selected) {
      const facts = gitFacts(dependency.source, dependency.repository, true);
      if (facts.dirty) throw new Error(`${dependency.name}: release sync refuses a dirty dependency tree`);
      if (dependency.sourceCommit && facts.commit !== dependency.sourceCommit) {
        throw new Error(`${dependency.name}: source differs from the pinned source commit`);
      }
    }
  }

  const buildPlans = new Map();
  for (const dependency of selected) {
    console.log(`\n=== ${dependency.name} — ${dependency.description ?? ''}`);
    if (!fs.existsSync(dependency.source)) throw new Error(`${dependency.name}: source tree missing: ${dependency.source}`);
    const buildPlan = releaseBuildPlan(dependency, options);
    buildPlans.set(dependency.name, buildPlan);
    if (options.skipBuild) {
      console.log('  skipping build (--skip-build)');
    } else {
      console.log(`  building: ${dependency.build.command} ${dependency.build.args.join(' ')}`);
      if (options.release && dependency.build.rustPathRemapping) {
        console.log('  applying deterministic Rust source-path remapping');
      }
      execFileSync(dependency.build.command, dependency.build.args, {
        cwd: dependency.source,
        stdio: 'inherit',
        env: buildPlan.environment,
      });
    }
  }

  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const prepared = [];
  try {
    for (const dependency of selected) {
      const facts = gitFacts(dependency.source, dependency.repository, options.release);
      if (options.release && facts.dirty) {
        throw new Error(`${dependency.name}: build left the dependency tree dirty; refusing release sync`);
      }
      const staged = stageDependency(dependency, facts, {
        skipBuild: options.skipBuild,
        release: options.release,
        buildPlan: buildPlans.get(dependency.name),
      });
      prepared.push(staged);
      console.log(
        `  manifest: version ${staged.manifest.version ?? 'unknown'} · commit ${staged.manifest.commit}` +
          `${facts.dirty ? ' (dirty tree)' : ''}`
      );
    }
    if (options.release) {
      for (const item of prepared) {
        const finalFacts = gitFacts(item.dependency.source, item.dependency.repository, true);
        if (finalFacts.dirty) {
          throw new Error(`${item.dependency.name}: dependency tree changed while staging; refusing release sync`);
        }
        if (finalFacts.commit !== item.manifest.commit) {
          throw new Error(`${item.dependency.name}: dependency commit changed while staging; refusing release sync`);
        }
      }
    }
    installStages(prepared);
  } finally {
    for (const item of prepared) {
      if (item.stage) fs.rmSync(item.stage, { recursive: true, force: true });
    }
  }
};

try {
  main();
} catch (error) {
  console.error(`[deps:sync] ${error.message}`);
  process.exitCode = 1;
}
