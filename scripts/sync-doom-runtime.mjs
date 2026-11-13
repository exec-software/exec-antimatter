#!/usr/bin/env node
/** Fetch pinned, verified optional game artifacts into an external build directory. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDoomLock, verifyDoomResources } from './lib/desktop-resources.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/sync-doom-runtime.mjs --output /external/build/doom [--verify-only]\nDownloads pinned engine, Freedoom data, complete corresponding source and all notices.\nSet ANTIMATTER_DOOM_RUNTIME to that directory when packaging; nothing is downloaded by end users.');
  process.exit(0);
}
const output = args[args.indexOf('--output') + 1];
if (!args.includes('--output') || !output || !isAbsolute(output)) throw new Error('Usage: sync-doom-runtime.mjs --output /external/build/doom [--verify-only]');
if (args.some((arg, index) => arg !== '--verify-only' && arg !== '--output' && args[index - 1] !== '--output')) throw new Error('Unknown option; see --help.');
const target = resolve(output);
const outside = (value) => { const location = relative(root, value); return location.startsWith(`..${sep}`) || isAbsolute(location); };
if (!outside(target)) throw new Error('Doom runtime artifacts belong outside the source checkout.');
const lock = readDoomLock(root);
await mkdir(target, { recursive: true });
if (!(await lstat(target)).isDirectory() || !outside(await realpath(target))) throw new Error('Doom output must be an external directory, not a symlink.');
if (args.includes('--verify-only')) {
  verifyDoomResources(root, target);
  console.log(`Verified Doom runtime, source archive, and notices: ${target}`);
  process.exit(0);
}
for (const asset of lock.assets) {
  const file = join(target, asset.name);
  const valid = (bytes) => bytes.length === asset.bytes && createHash('sha256').update(bytes).digest('hex') === asset.sha256;
  try { if (valid(await readFile(file))) continue; } catch {}
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  if (!response.ok || Number(response.headers.get('content-length')) > asset.bytes) throw new Error(`Could not fetch ${asset.name}: ${response.status}`);
  const chunks = []; let count = 0;
  for await (const chunk of response.body) { count += chunk.byteLength; if (count > asset.bytes) throw new Error(`${asset.name} exceeds its pinned size.`); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  if (!valid(bytes)) throw new Error(`Checksum mismatch for ${asset.name}`);
  const staging = `${file}.tmp-${process.pid}`;
  try { await writeFile(staging, bytes); await rename(staging, file); } finally { await rm(staging, { force: true }); }
}
await writeFile(join(target, 'runtime-manifest.json'), JSON.stringify(lock, null, 2) + '\n');
verifyDoomResources(root, target);
console.log(`Verified Doom runtime, source archive, and notices: ${target}`);
