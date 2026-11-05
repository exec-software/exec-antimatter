import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const UPSTREAM_HOME = '/home/runner';
const UPSTREAM_PREFIX = Buffer.from('/home/runner/work/llama.cpp/llama.cpp/');
// Reviewed b11223 public manifest, including all 61 per-file content identities.
// A runtime refresh requires a new review; a mutable manifest cannot grant exemptions.
const REVIEWED_MANIFEST_SHA256 = 'f193550531e4b5783bb15577abe60aa009368200c3f49f3b63dc0f1766ac5af8';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const regular = (file) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error(`Build-path scan requires a regular file: ${file}`);
  return stat;
};

export function reviewedUpstreamFiles(root, payloadRoot) {
  const manifestPath = path.join(root, 'vendor/llama-vulkan/manifest.json');
  const packagedManifestPath = path.join(payloadRoot, 'resources/vendor/llama-vulkan/manifest.json');
  regular(manifestPath);
  regular(packagedManifestPath);
  const source = fs.readFileSync(manifestPath);
  if (sha(source) !== REVIEWED_MANIFEST_SHA256 || sha(fs.readFileSync(packagedManifestPath)) !== REVIEWED_MANIFEST_SHA256) {
    throw new Error('Upstream build-path policy requires the exact reviewed Vulkan manifest');
  }
  const manifest = JSON.parse(source);
  return new Map(manifest.files.map((entry) => [
    path.resolve(payloadRoot, 'resources/vendor/llama-vulkan/runtime', entry.path),
    { bytes: entry.bytes, sha256: entry.sha256 },
  ]));
}

/** Keep build paths blocked, allowing only byte-pinned upstream diagnostic paths. */
export function assertNoLocalBuildPaths(file, { privatePaths, homePath, upstreamFiles = new Map() }) {
  regular(file);
  const blocked = [...new Set(privatePaths.filter((value) => value && value !== '/'))].map((value) => Buffer.from(value));
  const home = homePath && homePath !== '/' ? Buffer.from(homePath) : null;
  const overlap = Math.max(1, UPSTREAM_PREFIX.length, home?.length ?? 0, ...blocked.map((value) => value.length)) - 1;
  const chunkBytes = 1024 * 1024;
  const chunk = Buffer.alloc(chunkBytes + overlap);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = createHash('sha256');
  let carry = 0, bytes = 0, homeOccurrences = 0, unexpectedHome = false;
  try {
    while (true) {
      const read = fs.readSync(descriptor, chunk, carry, chunkBytes, null);
      hash.update(chunk.subarray(carry, carry + read));
      bytes += read;
      const available = carry + read;
      const scanEnd = read === 0 ? available : Math.max(0, available - overlap);
      const window = chunk.subarray(0, available);
      for (const needle of blocked) {
        const at = window.indexOf(needle);
        if (at >= 0 && at < scanEnd) throw new Error(`packaged file leaks local build path ${needle}: ${file}`);
      }
      if (home) {
        for (let at = window.indexOf(home); at >= 0 && at < scanEnd; at = window.indexOf(home, at + home.length)) {
          homeOccurrences += 1;
          if (!window.subarray(at, at + UPSTREAM_PREFIX.length).equals(UPSTREAM_PREFIX)) unexpectedHome = true;
        }
      }
      if (read === 0) break;
      carry = available - scanEnd;
      if (carry) chunk.copyWithin(0, scanEnd, available);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (homeOccurrences === 0) return 0;
  const record = upstreamFiles.get(path.resolve(file));
  if (homePath !== UPSTREAM_HOME || unexpectedHome || !record || bytes !== record.bytes || hash.digest('hex') !== record.sha256) {
    throw new Error(`packaged file leaks local build path ${homePath}: ${file}`);
  }
  return homeOccurrences;
}
