#!/usr/bin/env node

/**
 * Generate (or verify) the license corpus for the exact Linux Beholdd CLI graph.
 *
 *   node scripts/generate-beholdd-licenses.mjs
 *   node scripts/generate-beholdd-licenses.mjs --check
 *   node scripts/generate-beholdd-licenses.mjs --source /path/to/exec-beholdd
 *
 * Generation requires the clean sibling Beholdd checkout and an already populated Cargo cache.
 * A release worktree without that sibling (or with a newer default sibling) can still run --check:
 * the bundle is self-verified and tied to both the vendor manifest and configured source commit.
 * An explicitly selected source must match that pin; it never silently falls back to the sealed check.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LICENSES_ROOT = path.join(ROOT, 'releases', 'licenses');
const COMMON_APACHE = path.join(LICENSES_ROOT, 'Apache-2.0.txt');
const DEPS_CONFIG = path.join(ROOT, 'scripts', 'deps.json');
const TARGET = 'x86_64-unknown-linux-gnu';
const ROOT_PACKAGE = 'beholdd-cli';
const BUNDLE_NAME = 'THIRD_PARTY_LICENSES.txt';
const MANIFEST_NAME = 'manifest.json';
const SCHEMA_VERSION = 1;
const LICENSE_FILE = /^(?:licen[sc]e|copying|notice)(?:$|[._-])/i;

const sha256 = (contents) => createHash('sha256').update(contents).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();

const parseArguments = () => {
  const args = process.argv.slice(2);
  let check = false;
  let source = null;
  let component = 'beholdd';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--check') check = true;
    else if (argument === '--source') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`);
      source = path.resolve(value);
      index += 1;
    } else if (argument === '--component') {
      component = args[++index];
      if (!['beholdd', 'beholdd-hag'].includes(component)) throw new Error('--component must be beholdd or beholdd-hag');
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  return { check, source, component, output: path.join(LICENSES_ROOT, component) };
};

const configuredBeholdd = (component) => {
  const dependency = readJson(DEPS_CONFIG).dependencies?.find((candidate) => candidate.name === component);
  if (!dependency) throw new Error(`scripts/deps.json has no ${component} dependency`);
  const configured = dependency.sourceEnv
    ? process.env[dependency.sourceEnv] || dependency.source
    : dependency.source;
  return {
    source: path.resolve(ROOT, configured),
    repository: dependency.repository?.replace(/\/+$/, '').replace(/\.git$/, ''),
    explicitSource: Boolean(dependency.sourceEnv && process.env[dependency.sourceEnv]),
    features: dependency.build?.cargoFeatures ?? [],
    sourceCommit: dependency.sourceCommit,
  };
};

const packageKey = (pkg) => `${pkg.source ? 'registry' : 'workspace'}:${pkg.name}@${pkg.version}`;
const publicPackageSource = (pkg, repository, commit) =>
  pkg.source
    ? `https://crates.io/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`
    : `${repository}/tree/${commit}`;

const topLevelLicenseFiles = (pkg) => {
  const packageRoot = path.dirname(pkg.manifest_path);
  const names = fs
    .readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name);

  if (pkg.license_file) {
    const declared = path.resolve(pkg.license_file);
    const relative = path.relative(packageRoot, declared);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`${pkg.name}@${pkg.version} license_file escapes its package root`);
    }
    if (!names.includes(relative)) names.push(relative);
  }

  return names.sort((left, right) => left.localeCompare(right)).map((name) => {
    const file = path.join(packageRoot, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${pkg.name}@${pkg.version} license input is not a regular file: ${name}`);
    }
    const contents = fs.readFileSync(file);
    return { name: name.split(path.sep).join('/'), bytes: contents.length, sha256: sha256(contents), contents };
  });
};

const graphFromMetadata = (metadata, source, repository, commit, apache) => {
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodesById = new Map(metadata.resolve?.nodes?.map((node) => [node.id, node]) ?? []);
  const roots = metadata.packages.filter(
    (pkg) => pkg.name === ROOT_PACKAGE && !pkg.source && path.resolve(pkg.manifest_path).startsWith(`${source}${path.sep}`)
  );
  if (roots.length !== 1) throw new Error(`expected exactly one workspace ${ROOT_PACKAGE}, found ${roots.length}`);

  const reachable = new Set();
  const pending = [roots[0].id];
  while (pending.length) {
    const id = pending.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = nodesById.get(id);
    if (!node) throw new Error(`Cargo metadata omitted resolve node ${id}`);
    for (const dependency of node.deps) {
      if (dependency.dep_kinds.some((edge) => edge.kind !== 'dev')) pending.push(dependency.pkg);
    }
  }

  const records = [...reachable]
    .map((id) => {
      const pkg = packagesById.get(id);
      if (!pkg?.license) throw new Error(`${pkg?.name ?? id} has no SPDX license expression`);
      const node = nodesById.get(id);
      const licenseFiles = topLevelLicenseFiles(pkg);
      const isBeholddWorkspace = !pkg.source && pkg.name.startsWith('beholdd-');
      if (isBeholddWorkspace && licenseFiles.length === 0) {
        licenseFiles.push({
          name: '../Apache-2.0.txt',
          bytes: apache.length,
          sha256: sha256(apache),
          contents: null,
          shared: true,
        });
      }
      if (licenseFiles.length === 0) {
        throw new Error(`${pkg.name}@${pkg.version} supplies no top-level license file`);
      }

      const dependencies = node.deps
        .map((dependency) => {
          const edges = dependency.dep_kinds.filter((edge) => edge.kind !== 'dev');
          if (edges.length === 0 || !reachable.has(dependency.pkg)) return null;
          const dependencyPackage = packagesById.get(dependency.pkg);
          return {
            package: packageKey(dependencyPackage),
            kinds: [...new Set(edges.map((edge) => edge.kind ?? 'normal'))].sort(),
          };
        })
        .filter(Boolean)
        .sort((left, right) => left.package.localeCompare(right.package));

      return {
        key: packageKey(pkg),
        name: pkg.name,
        version: pkg.version,
        spdx: pkg.license,
        source: publicPackageSource(pkg, repository, commit),
        features: [...node.features].sort(),
        dependencies,
        licenseFiles,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));

  return records;
};

const makeBundle = ({ commit, repository, cargoLockSha256, graphSha256, records, apache }) => {
  const chunks = [];
  const text = (value) => chunks.push(Buffer.from(value, 'utf8'));
  text(
    'BEHOLDD THIRD-PARTY LICENSES\n' +
      '================================\n\n' +
      `Source: ${repository}\n` +
      `Commit: ${commit}\n` +
      `Cargo.lock SHA-256: ${cargoLockSha256}\n` +
      `Target: ${TARGET}\n` +
      `Graph SHA-256: ${graphSha256}\n\n` +
      'PACKAGE / VERSION / SPDX INDEX\n' +
      '--------------------------------\n'
  );
  for (const record of records) text(`${record.name} ${record.version} | ${record.spdx}\n`);

  text(
    '\n\n===============================================================================\n' +
      'Shared license file: Apache-2.0.txt\n' +
      `SHA-256: ${sha256(apache)}\n` +
      'Used by: Beholdd workspace crates that declare Apache-2.0\n' +
      '-------------------------------------------------------------------------------\n'
  );
  chunks.push(apache);
  if (apache.at(-1) !== 0x0a) text('\n');

  for (const record of records) {
    for (const license of record.licenseFiles) {
      if (license.shared) continue;
      text(
        '\n===============================================================================\n' +
          `Package: ${record.name} ${record.version}\n` +
          `SPDX: ${record.spdx}\n` +
          `Source: ${record.source}\n` +
          `File: ${license.name}\n` +
          `SHA-256: ${license.sha256}\n` +
          '-------------------------------------------------------------------------------\n'
      );
      chunks.push(license.contents);
      if (license.contents.at(-1) !== 0x0a) text('\n');
    }
  }
  return Buffer.concat(chunks);
};

const expectedArtifacts = (source, repository, features = []) => {
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Beholdd source tree is missing: ${source}`);
  }
  const origin = run('git', ['remote', 'get-url', 'origin'], source)
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@([^/]+)\//, 'https://$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  if (origin.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`Beholdd origin ${origin} does not match ${repository}`);
  }
  const dirty = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], source);
  if (dirty) throw new Error('Beholdd license generation requires a clean source tree');
  const commit = run('git', ['rev-parse', 'HEAD'], source);
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error(`invalid Beholdd commit ${commit}`);

  const apache = fs.readFileSync(COMMON_APACHE);
  const cargoLock = fs.readFileSync(path.join(source, 'Cargo.lock'));
  const cargoLockSha256 = sha256(cargoLock);
  const metadata = JSON.parse(
    run(
      'cargo',
      [
        'metadata',
        '--locked',
        '--offline',
        '--filter-platform',
        TARGET,
        '--format-version',
        '1',
        '--manifest-path',
        path.join(source, 'crates', ROOT_PACKAGE, 'Cargo.toml'),
        '--no-default-features',
        ...(features.length ? ['--features', features.join(',')] : []),
      ],
      source
    )
  );
  const records = graphFromMetadata(metadata, source, repository, commit, apache);
  const graph = records.map(({ key, version, spdx, features, dependencies }) => ({
    key,
    version,
    spdx,
    features,
    dependencies,
  }));
  const graphSha256 = sha256(Buffer.from(JSON.stringify(graph), 'utf8'));
  const bundle = makeBundle({ commit, repository, cargoLockSha256, graphSha256, records, apache });
  const packages = records.map(({ key, name, version, spdx, source: packageSource, features, dependencies, licenseFiles }) => ({
    key,
    name,
    version,
    spdx,
    source: packageSource,
    features,
    dependencies,
    licenseFiles: licenseFiles.map(({ name: file, bytes, sha256: digest, shared = false }) => ({
      file,
      bytes,
      sha256: digest,
      ...(shared ? { shared: true } : {}),
    })),
  }));
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    component: 'beholdd-cli',
    target: TARGET,
    dependencyEdges: ['normal', 'build'],
    ...(features.length ? { cargoFeatures: features } : {}),
    source: { repository, commit, cargoLockSha256 },
    graphSha256,
    packageCount: packages.length,
    packages,
    bundle: { file: BUNDLE_NAME, bytes: bundle.length, sha256: sha256(bundle) },
  };
  return new Map([
    [BUNDLE_NAME, bundle],
    [MANIFEST_NAME, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')],
  ]);
};

const validateSealedBundle = (output, component, features, configuredCommit) => {
  const manifestPath = path.join(output, MANIFEST_NAME);
  const bundlePath = path.join(output, BUNDLE_NAME);
  const manifest = readJson(manifestPath);
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.component !== ROOT_PACKAGE || manifest.target !== TARGET) {
    throw new Error('Beholdd license manifest identity is invalid');
  }
  if (!Array.isArray(manifest.packages) || manifest.packageCount !== manifest.packages.length) {
    throw new Error('Beholdd license manifest package inventory is invalid');
  }
  const bundle = fs.readFileSync(bundlePath);
  if (manifest.bundle?.file !== BUNDLE_NAME || manifest.bundle.bytes !== bundle.length || manifest.bundle.sha256 !== sha256(bundle)) {
    throw new Error('Beholdd license bundle does not match its manifest');
  }
  const apache = fs.readFileSync(COMMON_APACHE);
  const sharedApache = manifest.packages.flatMap((pkg) => pkg.licenseFiles ?? []).find((file) => file.shared);
  if (!sharedApache || sharedApache.sha256 !== sha256(apache) || sharedApache.bytes !== apache.length) {
    throw new Error('Beholdd license inventory does not match the shared Apache-2.0 text');
  }
  for (const [key, required] of [
    ['registry:atomic-waker@1.1.2', ['LICENSE-THIRD-PARTY']],
    ['registry:matchit@0.7.3', ['LICENSE', 'LICENSE.httprouter']],
    ['registry:unicode-ident@1.0.24', ['LICENSE-UNICODE']],
  ]) {
    const pkg = manifest.packages.find((candidate) => candidate.key === key);
    const files = new Set(pkg?.licenseFiles?.map((file) => file.file) ?? []);
    for (const file of required) {
      if (!files.has(file)) throw new Error(`Beholdd license inventory omits ${key}/${file}`);
    }
  }
  const vendor = readJson(path.join(ROOT, 'vendor', component, 'manifest.json'));
  if (JSON.stringify(manifest.cargoFeatures ?? []) !== JSON.stringify(features) ||
      JSON.stringify(vendor.cargoFeatures ?? []) !== JSON.stringify(features)) {
    throw new Error('Beholdd license inventory Cargo features differ from its packaged build');
  }
  if (component === 'beholdd-hag') {
    const hag = manifest.packages.find((pkg) => pkg.name === 'exec-hag');
    if (hag?.spdx !== 'MIT' || !hag.features?.includes('native-compute') ||
        !hag.licenseFiles?.some((file) => file.file === 'LICENSE' && !file.shared)) {
      throw new Error('HAG license inventory must include the linked MIT exec-hag native-compute package');
    }
  }
  if (vendor.commit !== manifest.source?.commit) {
    throw new Error(`Beholdd license inventory is for ${manifest.source?.commit}, vendor is ${vendor.commit}`);
  }
  if (configuredCommit && manifest.source?.commit !== configuredCommit) {
    throw new Error(
      `Beholdd license inventory is for ${manifest.source?.commit}, but the configured source pin for ${component} is ${configuredCommit}; rebuild the dependency and regenerate its licenses`
    );
  }
  return manifest;
};

const assertExactOutput = (output, expected) => {
  const actualNames = fs.readdirSync(output, { withFileTypes: true });
  if (actualNames.some((entry) => !entry.isFile()) || actualNames.length !== expected.size) {
    throw new Error(`Beholdd license output contains unexpected entries: ${output}`);
  }
  for (const [name, contents] of expected) {
    const file = path.join(output, name);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile() || !fs.readFileSync(file).equals(contents)) {
      throw new Error(`Beholdd license artifact is stale: ${file}`);
    }
  }
};

const installOutput = (output, artifacts) => {
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.lstatSync(output, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`refusing symlinked output: ${output}`);
  }
  const stage = path.join(parent, `.beholdd-licenses-stage-${randomUUID()}`);
  const backup = path.join(parent, `.beholdd-licenses-backup-${randomUUID()}`);
  fs.mkdirSync(stage, { mode: 0o755 });
  try {
    for (const [name, contents] of artifacts) fs.writeFileSync(path.join(stage, name), contents, { mode: 0o644 });
    assertExactOutput(stage, artifacts);
    const hadOutput = fs.existsSync(output);
    if (hadOutput) fs.renameSync(output, backup);
    try {
      fs.renameSync(stage, output);
    } catch (error) {
      if (hadOutput) fs.renameSync(backup, output);
      throw error;
    }
    if (hadOutput) fs.rmSync(backup, { recursive: true, force: true });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
};

const main = () => {
  const options = parseArguments();
  const configured = configuredBeholdd(options.component);
  const source = options.source ?? configured.source;
  if (options.check) {
    const manifest = validateSealedBundle(options.output, options.component, configured.features, configured.sourceCommit);
    const explicitSource = options.source !== null || configured.explicitSource;
    if (fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
      const sourceCommit = run('git', ['rev-parse', 'HEAD'], source);
      if (!/^[0-9a-f]{40,64}$/i.test(sourceCommit)) throw new Error('Beholdd source has an invalid Git commit');
      if (sourceCommit === manifest.source.commit) {
        assertExactOutput(options.output, expectedArtifacts(source, configured.repository, configured.features));
        console.log(`verified Beholdd license graph (${manifest.packageCount} packages) against ${source}`);
        return;
      }
      if (explicitSource) {
        throw new Error(`Explicit Beholdd source is at ${sourceCommit}, but the vendored license pin is ${manifest.source.commit}`);
      }
      console.log(`skipped default sibling source comparison: HEAD ${sourceCommit} differs from vendored pin ${manifest.source.commit}`);
    } else if (explicitSource) {
      throw new Error(`Explicit Beholdd source tree is missing: ${source}`);
    }
    console.log(
      `verified sealed Beholdd license bundle (${manifest.packageCount} packages) for ${manifest.source.commit}`
    );
    return;
  }

  if (configured.sourceCommit && run('git', ['rev-parse', 'HEAD'], source) !== configured.sourceCommit) {
    throw new Error('Beholdd license source differs from its configured source pin');
  }
  const artifacts = expectedArtifacts(source, configured.repository, configured.features);
  installOutput(options.output, artifacts);
  console.log(`generated ${options.output}`);
};

try {
  main();
} catch (error) {
  console.error(`[beholdd:licenses] ${error.message}`);
  process.exitCode = 1;
}
