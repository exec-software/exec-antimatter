#!/usr/bin/env node

/**
 * Build the publishable Linux release without touching the live checkout's node_modules.
 *
 * A clean detached worktree fixes the source revision, `npm ci` fixes the JavaScript dependency
 * tree, and the already verified internal binaries are copied in because release payloads under
 * vendor/ are intentionally not Git-tracked. Artifacts reach releases/dist only after the inner
 * assembler and every smoke test succeed.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installReleaseDependencies } from './lib/release-dependencies.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'releases', 'dist');
const RELEASES = path.dirname(DIST);
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
const capture = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options }).trim();

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run release:linux -- [--desktop-only]\n--desktop-only retains the tested unsigned Android APK for signing but excludes Android from publication.');
  process.exit(0);
}
if (args.some((arg) => arg !== '--desktop-only')) throw new Error('Unknown release option; use --help');
const desktopOnly = args.includes('--desktop-only');

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(`Linux x86_64 release required; found ${process.platform}/${process.arch}`);
}
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const supportedNode =
  (nodeMajor === 22 && nodeMinor >= 20) ||
  (nodeMajor === 24 && nodeMinor >= 12) ||
  nodeMajor >= 25;
if (!supportedNode) {
  throw new Error(`Node.js 22.20+, 24.12+, or 25+ is required; found ${process.versions.node}`);
}

const dirty = capture('git', ['status', '--porcelain', '--untracked-files=all']);
if (dirty) {
  throw new Error('Release builds require a clean worktree and isolated native compatibility build; commit the reviewed inputs first. Dirty-tree release rehearsals are no longer supported.');
}

const commit = capture('git', ['rev-parse', 'HEAD']);
console.log(`=== Preparing isolated release worktree for ${commit}`);
run(process.execPath, ['scripts/sync-deps.mjs', '--verify', 'beholdd', 'beholdd-hag', 'displacer']);
run(process.execPath, ['scripts/sync-llama-vulkan.mjs', '--verify']);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antimatter-release-worktree-'));
const checkout = path.join(temporaryRoot, 'checkout');
const nodeGypDevDir = path.join(temporaryRoot, 'node-gyp');
let worktreeAdded = false;

try {
  run('git', ['worktree', 'add', '--detach', checkout, commit]);
  worktreeAdded = true;

  // Only configured, manifested payloads are copied. The inner verifier rejects any extra or
  // changed file before packaging.
  for (const name of ['beholdd', 'beholdd-hag', 'displacer', 'llama-vulkan']) {
    const destination = path.join(checkout, 'vendor', name);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, 'vendor', name), destination, { recursive: true });
  }

  const isolatedEnvironment = {
    ...process.env,
    // npm itself may live outside the selected Node installation. Its env-based shebang must
    // resolve to the same runtime that passed this script's release-version gate.
    PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
    ANTIMATTER_ISOLATED_RELEASE: '1',
    ANTIMATTER_DESKTOP_ONLY: desktopOnly ? '1' : '0',
    npm_config_devdir: nodeGypDevDir,
  };
  console.log('\n=== Installing the exact lockfile in the isolated worktree');
  installReleaseDependencies(checkout, { env: isolatedEnvironment });
  capture('npm', ['ls', '--all'], { cwd: checkout, env: isolatedEnvironment });
  console.log('verified installed npm dependency tree');

  console.log('\n=== Rebuilding native terminal against the pinned compatibility baseline');
  run(process.execPath, ['scripts/rebuild-native.mjs', '--release'], { cwd: checkout, env: isolatedEnvironment });

  console.log('\n=== Assembling and testing the isolated release');
  run(process.execPath, ['scripts/build-release.mjs'], {
    cwd: checkout,
    env: isolatedEnvironment,
  });

  const isolatedDist = path.join(checkout, 'releases', 'dist');
  if (!fs.statSync(isolatedDist, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`isolated assembler did not create ${isolatedDist}`);
  }
  // Copy the complete tree, including the nonpublished .android-input APK/receipt from the
  // tested source revision. A protected signer finishes this handoff before release staging.

  fs.mkdirSync(RELEASES, { recursive: true });
  const stagedDist = path.join(RELEASES, `.dist-stage-${process.pid}-${randomUUID()}`);
  const previousDist = path.join(RELEASES, `.dist-previous-${process.pid}-${randomUUID()}`);
  fs.cpSync(isolatedDist, stagedDist, { recursive: true });
  let hadPrevious = false;
  try {
    if (fs.existsSync(DIST)) {
      fs.renameSync(DIST, previousDist);
      hadPrevious = true;
    }
    fs.renameSync(stagedDist, DIST);
    if (hadPrevious) fs.rmSync(previousDist, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(stagedDist, { recursive: true, force: true });
    if (hadPrevious && !fs.existsSync(DIST) && fs.existsSync(previousDist)) {
      fs.renameSync(previousDist, DIST);
    }
    throw error;
  }

  console.log(`\nVerified release copied to ${DIST}`);
  console.log(desktopOnly
    ? 'Desktop-only release: .android-input contains an unsigned, non-installable APK and is not published.'
    : 'Android production signing is still required: sign .android-input/app-release-unsigned.apk, then run scripts/import-android-release.mjs.');
} finally {
  if (worktreeAdded) {
    try {
      run('git', ['worktree', 'remove', '--force', checkout]);
    } catch (error) {
      console.warn(`[release] Could not unregister temporary worktree ${checkout}: ${error.message}`);
    }
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
