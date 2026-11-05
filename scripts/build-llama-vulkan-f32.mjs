#!/usr/bin/env node
/** Separate local Vulkan F32 build; never modifies the upstream vendor payload or services. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAME, inspectRuntime, materializeRuntime, publicBuildOptions, readRecipe, run, sha256, validateBuild, validateSource, verifyPayload } from './lib/llama-vulkan-f32.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const allowed = new Set(['--source', '--build', '--jobs', '--payload', '--prefix', '--include', '--verify', '--import-build', '--help']);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`unknown argument: ${args[i]}`);
  if (['--source', '--build', '--jobs', '--payload', '--prefix', '--include'].includes(args[i])) {
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`missing value: ${args[i]}`);
    i++;
  }
}
if (args.includes('--help')) {
  console.log('Build: node scripts/build-llama-vulkan-f32.mjs --source /pinned/llama.cpp --build /build/path [--jobs 2] [--prefix /optional/dependency/prefix] [--include /optional/header/directory]\nImport an existing identically configured build (ensures targets are current): add --import-build\nVerify installed bytes/dependencies/version: --verify [--payload /vendor/llama-vulkan-f32]\nApply the tracked patch to the pinned source before building. No services are started.');
  process.exit(0);
}
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This local runtime recipe requires Linux x86_64.');
const recipe = readRecipe(root);
const vendor = path.resolve(value('--payload') ?? path.join(root, 'vendor', NAME));
if (path.basename(vendor) !== NAME || (fs.existsSync(vendor) && fs.lstatSync(vendor).isSymbolicLink())) {
  throw new Error(`Payload must be a dedicated ${NAME} directory, not a symlink.`);
}
if (args.includes('--verify')) {
  const manifest = verifyPayload(vendor, recipe);
  console.log(`Verified ${NAME}: ${manifest.files.length} files, inventory ${manifest.runtime.sha256}`);
  process.exit(0);
}
if (!value('--source') || !value('--build')) throw new Error('--source and --build are required');
const source = fs.realpathSync(value('--source'));
const build = path.resolve(value('--build'));
validateSource(source, recipe);
const jobs = Number(value('--jobs') ?? 2);
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) throw new Error('--jobs must be between 1 and 64');
const include = value('--include') ? fs.realpathSync(value('--include')) : null;
if (include && !/^[A-Za-z0-9_/.+-]+$/.test(include)) throw new Error('--include must be a plain absolute directory without shell metacharacters or whitespace');
if (!args.includes('--import-build')) {
  run('cmake', ['-S', source, '-B', build, '-G', 'Ninja', ...(value('--prefix') ? [`-DCMAKE_PREFIX_PATH=${path.resolve(value('--prefix'))}`] : []), ...(include ? [`-DCMAKE_CXX_FLAGS=-isystem ${include}`] : []), ...Object.entries(recipe.cmake).map(([key, value]) => `-D${key}=${value}`)], { stdio: 'inherit' });
}
const cache = validateBuild(build, source, recipe);
// Upstream's always-dirty glob verifier makes a Ninja dry run inconclusive. Ensure the
// targets are current with a bounded incremental build, including on --import-build.
await new Promise((resolve, reject) => {
  const child = spawn('cmake', ['--build', build, '--target', ...recipe.targets, '--parallel', String(jobs)], {
    stdio: 'inherit', detached: true,
  });
  let stopped = false;
  const stop = (reason) => {
    if (stopped) return;
    stopped = true;
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') reject(error); }
    reject(new Error(reason));
  };
  const interrupt = () => stop('Build interrupted.');
  const timer = setTimeout(() => stop('Incremental build exceeded its 20-minute deadline.'), 20 * 60_000);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const cleanup = () => {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  };
  child.once('error', (error) => { cleanup(); reject(error); });
  child.once('exit', (code) => {
    cleanup();
    if (code === 0 && !stopped) resolve();
    else reject(new Error(`Incremental build failed (${code}).`));
  });
});
validateSource(source, recipe);
fs.mkdirSync(path.dirname(vendor), { recursive: true });
const stage = fs.mkdtempSync(path.join(path.dirname(vendor), '.llama-vulkan-f32-'));
try {
  const runtime = path.join(stage, 'runtime');
  const files = materializeRuntime(source, build, runtime);
  const smoke = inspectRuntime(runtime);
  const compiler = run(cache.CMAKE_CXX_COMPILER, ['--version']).split('\n')[0];
  const manifest = {
    schemaVersion: 1, name: NAME,
    description: 'Local llama.cpp Vulkan F32 expert-input build; independent of the upstream release payload',
    source: recipe.source, patches: recipe.patches, patchedFiles: recipe.files,
    platform: { os: 'linux', architecture: 'x86_64', accelerator: 'Vulkan', cpuRequirement: 'AVX2/FMA/F16C' },
    build: { options: recipe.cmake, targets: recipe.targets, compiler, ...publicBuildOptions(cache, { source, build }),
      cmake: run('cmake', ['--version']).split('\n')[0], ninja: run('ninja', ['--version']), ...smoke },
    runtime: { path: 'runtime', hashPolicy: 'antimatter-file-inventory-json-v1', sha256: sha256(JSON.stringify(files)), files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) },
    files,
    qualification: 'Payload integrity and version smoke only; backend numerical and full-model validation are separate.',
  };
  fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  verifyPayload(stage, recipe);
  const backup = `${vendor}.previous-${process.pid}`;
  if (fs.existsSync(backup)) throw new Error(`Backup already exists: ${backup}`);
  const existed = fs.existsSync(vendor);
  if (existed) {
    const old = JSON.parse(fs.readFileSync(path.join(vendor, 'manifest.json'), 'utf8'));
    if (old.name !== NAME || old.schemaVersion !== 1 || fs.readdirSync(vendor).sort().join(',') !== 'manifest.json,runtime') {
      throw new Error('Refusing to replace an unrecognized destination.');
    }
    fs.renameSync(vendor, backup);
  }
  try { fs.renameSync(stage, vendor); }
  catch (error) { if (existed) fs.renameSync(backup, vendor); throw error; }
  if (existed) fs.rmSync(backup, { recursive: true });
  console.log(`Installed ${NAME} at ${vendor}; no service configuration changed.`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
