import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const SOURCE_COMMIT = '4da6337767f973e2b4d0797e5b323d77d8565e4a';
export const NAME = 'llama-vulkan-f32';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(message); };
const equal = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} does not match`);
};
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) fail(`${command} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}
export function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\')) fail('unsafe relative path');
  const resolved = path.resolve(root, relative);
  const normalized = path.relative(root, resolved);
  if (!normalized || normalized !== relative || normalized.startsWith('../')) fail(`unsafe relative path: ${relative}`);
  return resolved;
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`not a regular file: ${file}`);
  return stat;
}
export function inventory(directory) {
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) fail('runtime is not a regular directory');
  return fs.readdirSync(directory).sort().map((name) => {
    const file = inside(directory, name);
    const stat = regular(file);
    return { path: name, bytes: stat.size, sha256: sha256(fs.readFileSync(file)), executable: Boolean(stat.mode & 0o111) };
  });
}
export function readRecipe(root) {
  const recipe = JSON.parse(fs.readFileSync(path.join(root, 'patches/llama.cpp/vulkan-f32.json'), 'utf8'));
  if (recipe.schemaVersion !== 1 || recipe.name !== NAME || recipe.source?.commit !== SOURCE_COMMIT ||
      !Array.isArray(recipe.patches) || !recipe.patches.length || !Array.isArray(recipe.files) || !recipe.files.length) fail('invalid F32 build recipe');
  for (const patch of recipe.patches) {
    const file = inside(root, patch.path);
    regular(file);
    if (sha256(fs.readFileSync(file)) !== patch.sha256) fail(`patch hash mismatch: ${patch.path}`);
  }
  return recipe;
}
export function validateSource(source, recipe, execute = run) {
  if (execute('git', ['-C', source, 'rev-parse', 'HEAD']) !== recipe.source.commit) fail('source is not the pinned llama.cpp commit');
  const expected = recipe.files.map((file) => file.path).sort();
  const changed = new Set([
    ...execute('git', ['-C', source, 'diff', '--name-only', 'HEAD']).split('\n'),
    ...execute('git', ['-C', source, 'ls-files', '--others', '--exclude-standard']).split('\n'),
  ].filter(Boolean));
  equal([...changed].sort(), expected, 'source changes');
  for (const file of recipe.files) {
    const filename = inside(source, file.path);
    regular(filename);
    if (sha256(fs.readFileSync(filename)) !== file.sha256) fail(`patched source hash mismatch: ${file.path}`);
  }
}
export function validateBuild(build, source, recipe) {
  const cache = Object.fromEntries(fs.readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8').split('\n')
    .flatMap((line) => { const m = line.match(/^([^/#][^:]*):[^=]+=(.*)$/); return m ? [[m[1], m[2]]] : []; }));
  if (fs.realpathSync(cache.CMAKE_HOME_DIRECTORY) !== fs.realpathSync(source)) fail('build cache belongs to a different source tree');
  for (const [key, value] of Object.entries(recipe.cmake)) {
    if (cache[key] !== String(value)) fail(`build option ${key} is ${cache[key]}, expected ${value}`);
  }
  if (cache.CMAKE_GENERATOR !== 'Ninja') fail('the reproducible build recipe requires Ninja');
  return cache;
}

/** Informational CMake provenance, with explicitly labeled local-path redaction. */
export function publicBuildOptions(cache, { source, build, home = homedir() }) {
  const prefixes = String(cache.CMAKE_PREFIX_PATH ?? '').split(';').filter(Boolean);
  const replacements = [
    ...prefixes.map((prefix, index) => [prefix, prefixes.length === 1 ? '<DEPENDENCY_PREFIX>' : `<DEPENDENCY_PREFIX_${index + 1}>`]),
    [source, '<SOURCE>'], [build, '<BUILD>'], [home, '<USER_HOME>'],
  ].filter(([value]) => typeof value === 'string' && value.length > 1)
    .sort(([left], [right]) => right.length - left.length);
  const redact = (value) => replacements.reduce((text, [from, to]) => text.replaceAll(from, to), String(value));
  return {
    pathPolicy: 'redacted-local-build-paths-v1',
    dependencyPrefix: redact(cache.CMAKE_PREFIX_PATH ?? ''),
    effectiveOptions: Object.fromEntries(Object.entries(cache)
      .filter(([key]) => /^(GGML_|LLAMA_|CMAKE_(?:C|CXX)_FLAGS)/.test(key) && !key.endsWith('-ADVANCED'))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, redact(value)])),
  };
}

export function materializeRuntime(source, build, destination) {
  fs.mkdirSync(destination);
  const bin = fs.realpathSync(path.join(build, 'bin'));
  const names = fs.readdirSync(bin).filter((name) => name === 'llama-server' || /^lib(?:ggml|llama|mtmd|llama-common).*\.so(?:\.[0-9.]+)?$/.test(name)).sort();
  for (const required of ['llama-server', 'libggml-vulkan.so', 'libggml-base.so', 'libggml-cpu.so', 'libllama.so']) {
    if (!names.includes(required)) fail(`build is missing ${required}`);
  }
  for (const name of names) {
    const resolved = fs.realpathSync(path.join(bin, name));
    if (!resolved.startsWith(`${bin}${path.sep}`)) fail(`build artifact escapes bin: ${name}`);
    regular(resolved);
    fs.copyFileSync(resolved, path.join(destination, name));
    fs.chmodSync(path.join(destination, name), 0o755);
  }
  regular(path.join(source, 'LICENSE'));
  fs.copyFileSync(path.join(source, 'LICENSE'), path.join(destination, 'LICENSE'));
  fs.chmodSync(path.join(destination, 'LICENSE'), 0o644);
  return inventory(destination);
}
export function inspectRuntime(runtime, execute = run) {
  const environment = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/tmp' };
  const options = { cwd: runtime, env: environment, timeout: 30_000 };
  const systemLibraries = new Set();
  for (const entry of inventory(runtime).filter((entry) => entry.path !== 'LICENSE')) {
    const file = path.join(runtime, entry.path);
    if (!fs.readFileSync(file).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) fail(`runtime artifact is not ELF: ${entry.path}`);
    const dynamic = execute('readelf', ['-d', file], options);
    for (const match of dynamic.matchAll(/\((?:RPATH|RUNPATH)\)[^\n]*\[([^\]]*)\]/g)) {
      if (match[1].split(':').some((entry) => entry && entry !== '$ORIGIN')) fail(`non-relocatable runtime search path: ${entry.path}`);
    }
    const output = execute('ldd', [file], options);
    if (/not found/.test(output)) fail(`unresolved runtime dependency: ${entry.path}`);
    for (const line of output.split('\n')) {
      const match = line.match(/^\s*(\S+)\s+=>\s+(\/\S+)/);
      if (!match) continue;
      if (/^lib(?:ggml|llama|mtmd)/.test(match[1])) {
        if (path.dirname(fs.realpathSync(match[2])) !== fs.realpathSync(runtime)) fail(`runtime dependency escaped payload: ${match[1]}`);
      } else systemLibraries.add(match[1]);
    }
    if (entry.path === 'libggml-vulkan.so' && !/\blibvulkan\.so\.1\b/.test(output)) fail('Vulkan library is not linked to the Vulkan loader');
  }
  const output = execute(path.join(runtime, 'llama-server'), ['--version'], options);
  const version = output.split('\n').filter((line) => /^(version:|built with )/.test(line)).join('\n');
  if (!version.includes('build 11223, commit 4da633776')) fail('runtime version does not identify the pinned build');
  return { systemLibraries: [...systemLibraries].sort(), version };
}
export function verifyPayload(vendor, recipe, { execute = run, smoke = true } = {}) {
  if (fs.lstatSync(vendor).isSymbolicLink()) fail('payload directory must not be a symlink');
  equal(fs.readdirSync(vendor).sort(), ['manifest.json', 'runtime'], 'payload entries');
  const manifestFile = path.join(vendor, 'manifest.json');
  regular(manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.name !== NAME) fail('invalid F32 payload manifest');
  equal(manifest.source, recipe.source, 'source provenance');
  equal(manifest.patches, recipe.patches, 'patch provenance');
  equal(manifest.patchedFiles, recipe.files, 'patched source inventory');
  equal(manifest.build.options, recipe.cmake, 'build recipe');
  equal(manifest.build.targets, recipe.targets, 'build targets');
  const runtime = path.join(vendor, 'runtime');
  const files = inventory(runtime);
  equal(manifest.files, files, 'runtime inventory');
  if (manifest.runtime?.path !== 'runtime' || manifest.runtime?.hashPolicy !== 'antimatter-file-inventory-json-v1' ||
      manifest.runtime?.sha256 !== sha256(JSON.stringify(files)) || manifest.runtime?.files !== files.length ||
      manifest.runtime?.bytes !== files.reduce((sum, entry) => sum + entry.bytes, 0)) fail('runtime inventory hash mismatch');
  if (files.find((file) => file.path === 'LICENSE')?.sha256 !== recipe.licenseSha256) fail('license hash mismatch');
  for (const name of ['llama-server', 'libggml-vulkan.so', 'libggml-base.so', 'libggml-cpu.so', 'libllama.so']) {
    if (!files.some((entry) => entry.path === name && entry.executable)) fail(`required runtime artifact missing: ${name}`);
  }
  if (smoke) {
    const observed = inspectRuntime(runtime, execute);
    equal(observed.systemLibraries, manifest.build.systemLibraries, 'system library dependencies');
    equal(observed.version, manifest.build.version, 'version smoke');
  }
  return manifest;
}
