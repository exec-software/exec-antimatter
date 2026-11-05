#!/usr/bin/env node

/**
 * Stage an assembled release on a configured build share, ready for buildd to import.
 *
 *   npm run release:stage [-- --dry-run]
 *
 * buildd publishes only what it imports itself: it re-verifies the release manifest and SHA256SUMS
 * against two SHA-256 values supplied out of band, copies everything into its own staging, and
 * renames the finished build into its managed project directory. A distributor can export that root
 * separately as the read-only `releases` share used by people and installed applications.
 * This script does the half that belongs to this machine — checks releases/dist the way
 * release:publish does, copies it atomically into the share's .incoming directory, and prints the
 * import to run on the release server with those trust anchors filled in. It never touches the managed tree.
 *
 * Options:
 *   --dist DIR           assembled release (default releases/dist)
 *   --incoming DIR       .incoming as this machine mounts it (default /mnt/builds/antimatter/.incoming)
 *   --server-incoming DIR  the same directory as the server sees it (default /mnt/builds/antimatter/.incoming)
 *   --lich-incoming DIR  compatibility alias for --server-incoming
 *   --managed DIR        buildd's published Antimatter folder, to catch a version already taken
 *                        (default /mnt/builds/managed/antimatter)
 *   --dry-run            check everything and print the import, but copy nothing
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isReleaseIdentity } from './lib/release-version.mjs';
import { assertAndroidReleaseReady } from './lib/android-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARE_INCOMING = '/mnt/builds/antimatter/.incoming';

const fail = (message) => {
  console.error(`release:stage: ${message}`);
  process.exit(1);
};

function options(argv) {
  const parsed = {
    dist: path.join(ROOT, 'releases', 'dist'),
    incoming: SHARE_INCOMING,
    lichIncoming: SHARE_INCOMING,
    managed: '/mnt/builds/managed/antimatter',
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) fail(`${flag} needs a value`);
      return path.resolve(next);
    };
    if (flag === '--dist') parsed.dist = value();
    else if (flag === '--incoming') parsed.incoming = value();
    else if (flag === '--server-incoming' || flag === '--lich-incoming') parsed.lichIncoming = argv[++index] ?? '';
    else if (flag === '--managed') parsed.managed = value();
    else if (flag === '--dry-run') parsed.dryRun = true;
    else fail(`unknown option ${flag}`);
  }
  if (!parsed.lichIncoming.startsWith('/')) fail('--server-incoming must be an absolute path on the release server');
  return parsed;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: npm run release:stage -- [--dist DIR] [--incoming DIR] [--server-incoming DIR] [--managed DIR] [--dry-run]');
  console.log('Verify and stage an assembled release; print the buildd import without running it.');
  console.log('Set BUILDD_CONFIG on the release server before running the printed command.');
  console.log('release:lich and --lich-incoming remain compatibility aliases.');
  process.exit(0);
}

const opts = options(process.argv.slice(2));
const capture = (command, args) => execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// ── The assembled release, checked as release:publish checks it ──────────────────────────────────
const manifestPath = path.join(opts.dist, 'release-manifest.json');
if (!fs.statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) fail(`no release manifest in ${opts.dist}; run npm run release:linux first`);
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
  fail(`release-manifest.json is not readable JSON: ${error.message}`);
}
const { version, tag, commit, channel } = manifest;
if (manifest.schemaVersion !== 1 || manifest.name !== 'Antimatter') fail('release-manifest.json is not an Antimatter release manifest');
if (!isReleaseIdentity(manifest)) {
  fail(`release-manifest.json names ${JSON.stringify({ version, tag, channel })}; expected matching stable/alpha version, channel and v<version> tag`);
}
if (manifest.platform?.os !== 'linux' || manifest.platform?.architecture !== 'x86_64') fail('release is not linux/x86_64');
if (!/^[0-9a-f]{40}$/.test(commit ?? '')) fail('release-manifest.json has no full commit hash');

const assets = [...(manifest.publishedAssets ?? [])].sort(compareText);
if (!assets.length || new Set(assets).size !== assets.length || assets.some((name) => path.basename(name) !== name)) {
  fail('release-manifest.json has no usable publishedAssets list');
}
for (const required of ['release-manifest.json', 'model-manifest.json', 'SHA256SUMS']) {
  if (!assets.includes(required)) fail(`publishedAssets is missing ${required}`);
}
const present = fs
  .readdirSync(opts.dist, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort(compareText);
if (JSON.stringify(present) !== JSON.stringify(assets)) {
  fail(`${opts.dist} does not hold exactly the published assets; expected ${assets.join(', ')}; found ${present.join(', ')}`);
}

const sums = new Map();
for (const line of fs.readFileSync(path.join(opts.dist, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)) {
  const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
  if (!match || sums.has(match[2])) fail(`SHA256SUMS has an unusable or repeated line: ${line}`);
  sums.set(match[2], match[1]);
}
const covered = assets.filter((name) => name !== 'SHA256SUMS');
if (JSON.stringify([...sums.keys()].sort(compareText)) !== JSON.stringify(covered)) fail('SHA256SUMS does not cover exactly the other assets');
const identities = new Map(assets.map((name) => [name, name === 'SHA256SUMS' ? sha256(path.join(opts.dist, name)) : sums.get(name)]));
for (const name of covered) {
  if (sha256(path.join(opts.dist, name)) !== sums.get(name)) fail(`${name} does not match SHA256SUMS`);
}
try { assertAndroidReleaseReady(ROOT, opts.dist, manifest); }
catch (error) { fail(error.message); }
if (Number(version.split('.')[0]) >= 19 || manifest.javaScriptInventory) {
  try {
    const { validateJavaScriptInventory } = await import('./lib/javascript-inventory.mjs');
    const inventory = validateJavaScriptInventory({ root: ROOT, outputDirectory: opts.dist });
    if (!isDeepStrictEqual(inventory, manifest.javaScriptInventory)) fail('JavaScript inventory differs from the assembled release');
    for (const artifact of [inventory.sbom, inventory.bundle, inventory.manifest]) {
      if (!assets.includes(artifact.file)) fail(`publishedAssets is missing ${artifact.file}`);
    }
  } catch (error) { fail(error.message); }
}

// ── The checkout it claims to come from ──────────────────────────────────────────────────────────
if (capture('git', ['status', '--porcelain', '--untracked-files=all'])) fail('refusing to stage from a dirty worktree');
const head = capture('git', ['rev-parse', 'HEAD']);
if (head !== commit) fail(`the release was built from ${commit}, but HEAD is ${head}`);
let tagCommit = '';
try {
  tagCommit = capture('git', ['rev-list', '-n', '1', tag]);
} catch {
  fail(`tag ${tag} does not exist; tag the release commit first (git tag ${tag})`);
}
if (tagCommit !== head) fail(`${tag} points at ${tagCommit}, not the release commit ${head}`);
if (manifest.releaseVersion !== undefined) {
  const rolling = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (rolling !== manifest.releaseVersion || pkg.releaseVersion !== rolling || pkg.version !== version) fail('public VERSION and package pins do not match the assembled release');
  let publicCommit = '';
  try { publicCommit = capture('git', ['rev-list', '-n', '1', manifest.releaseVersion]); }
  catch { fail(`public tag ${manifest.releaseVersion} does not exist; tag the release commit first`); }
  if (publicCommit !== head) fail(`${manifest.releaseVersion} points at ${publicCommit}, not the release commit ${head}`);
}

// ── buildd refuses a version or a commit it already published with a different identity ──────────
const indexPath = path.join(opts.managed, 'index.json');
if (fs.existsSync(indexPath)) {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const existing = (index.builds ?? []).find((build) => build.version === version);
  if (existing && existing.commit !== commit) {
    fail(`${version} is already published from ${existing.commit}; run npm run release:version for a new one`);
  }
  const sameCommit = (index.builds ?? []).find((build) => build.commit === commit && build.version !== version);
  if (sameCommit) fail(`${commit} is already published as ${sameCommit.version}; buildd publishes one version per commit`);
  if (existing) {
    console.log(`${version} is already published at ${path.join(opts.managed, existing.relative_path)}; nothing to stage.`);
    process.exit(0);
  }
}

// ── Stage into .incoming, atomically ─────────────────────────────────────────────────────────────
const folder = `${version}-${commit.slice(0, 8)}`;
const target = path.join(opts.incoming, folder);
const matches = (directory) =>
  assets.every((name) => {
    const file = path.join(directory, name);
    return fs.statSync(file, { throwIfNoEntry: false })?.isFile() && sha256(file) === identities.get(name);
  });

if (opts.dryRun) {
  console.log(`Dry run: would stage ${assets.length} files into ${target}`);
} else if (fs.existsSync(target)) {
  if (!matches(target)) fail(`${target} already holds a different release; remove it before staging again`);
  console.log(`Already staged, identical: ${target}`);
} else {
  fs.mkdirSync(opts.incoming, { recursive: true });
  const partial = path.join(opts.incoming, `.${folder}.partial-${process.pid}`);
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial);
  try {
    for (const name of assets) {
      process.stdout.write(`  copying ${name}\n`);
      fs.copyFileSync(path.join(opts.dist, name), path.join(partial, name));
    }
    if (!matches(partial)) throw new Error('a copied file did not match its SHA-256; nothing was staged');
    fs.renameSync(partial, target);
  } catch (error) {
    fs.rmSync(partial, { recursive: true, force: true });
    fail(error.message);
  }
  console.log(`Staged ${assets.length} verified files: ${target}`);
}

// ── What to run on the release server ─────────────────────────────────────────────────────────────────────
const source = path.posix.join(opts.lichIncoming, folder);
const executables = assets.filter((name) => name === 'install.sh' || name === 'uninstall.sh' || name.endsWith('.AppImage'));
console.log(`
Trust anchors for ${version} (${commit}):
  release-manifest.json  ${identities.get('release-manifest.json')}
  SHA256SUMS             ${identities.get('SHA256SUMS')}

On the release server, as the account responsible for publishing (set BUILDD_CONFIG first):

  cd ${source}
  # Samba decides the modes of files written from other machines. buildd accepts exactly these,
  # and wants the snapshot unwritable by anyone else while it verifies and copies.
  chmod 0755 .
  find . -maxdepth 1 -type f -exec chmod 0644 {} +
  chmod 0755 ${executables.join(' ')}
  buildd --config "$BUILDD_CONFIG" import \\
    --project antimatter \\
    --version ${version} \\
    --git-ref ${tag} \\
    --commit ${commit} \\
    --manifest-sha256 ${identities.get('release-manifest.json')} \\
    --checksums-sha256 ${identities.get('SHA256SUMS')} \\
    --source ${source}

The published project appears under the read-only releases share at releases/antimatter. Installed
copies pick it up on their next update check (Settings → Updates → Check now).`);
