#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Repairs a crash in Vite's vendored CommonJS plugin, in watch rebuilds only.
 *
 * `vite-plugin-electron` builds each Electron entry with `build.watch`, so every rebuild after
 * the first reuses Rollup's module cache and runs the plugin's `shouldTransformCachedModule`.
 * There, for a module Vite has wrapped as `?commonjs-es-import`, it reads
 * `(await this.load({ id })).meta.commonjs.resolved` without checking that `meta.commonjs`
 * exists. On this graph the wrapper is `ajv`, pulled in by
 * `@modelcontextprotocol/sdk`'s ESM `import Ajv from 'ajv'`, and its meta is missing on the
 * cached path, so the rebuild throws `Cannot read properties of undefined (reading 'resolved')`.
 *
 * A plugin error aborts the build *before* the bundle is written, so the running Electron keeps
 * the previous `dist-electron/main/index.js`. Nothing says so: the renderer is still served live
 * by Vite, so a renderer change appears and a main-process change silently does nothing. The
 * symptom reads as "settings won't save" because the IPC handler that would accept them is only
 * in the new bundle. The first build after a restart has no cache and always succeeds, which is
 * why restarting looks like it fixes it. See vitejs/vite#19410 and rollup/rollup#5848.
 *
 * The fix is a missing-meta guard: re-transform the cached module instead of dereferencing
 * nothing. That is safe and merely forgoes one cache reuse.
 *
 * A failure here is a warning, not an error, exactly like `rebuild-native.mjs`: refusing to
 * finish `npm install` over a dependency's internals would be a worse trade than a noisy dev
 * rebuild. If Vite is upgraded and the pattern moves, the warning tells you to revisit this.
 */
const require = createRequire(import.meta.url);

let chunksDir;
try {
  chunksDir = join(dirname(require.resolve('vite/package.json')), 'dist/node/chunks');
} catch {
  console.warn('[patch:vite-commonjs] Vite is not installed yet; skipping.');
  process.exit(0);
}

/**
 * Matches the exact vulnerable read, tolerating the whitespace a rebundle may change. Every
 * literal paren is escaped because the `)` that closes `this.load(...)` is part of what we key on.
 */
const VULNERABLE =
  /if \(isWrappedId\(resolved\.id, ES_IMPORT_SUFFIX\)\) \{\s*return \(\s*\(await getTypeForImportedModule\(\s*\(\s*await this\.load\(\{ id: resolved\.id \}\)\s*\)\.meta\.commonjs\.resolved,\s*this\.load\s*\)\) !== IS_WRAPPED_COMMONJS\s*\);\s*\}/;

/** Marker unique to the patched code, so a second run is a no-op. */
const PATCHED_MARKER = 'meta.commonjs;';

const PATCHED = `if (isWrappedId(resolved.id, ES_IMPORT_SUFFIX)) {
                const commonjsMeta = (await this.load({ id: resolved.id })).meta.commonjs;
                if (!commonjsMeta) return true;
                return (
                  (await getTypeForImportedModule(
                    commonjsMeta.resolved,
                    this.load
                  )) !== IS_WRAPPED_COMMONJS
                );
              }`;

let chunks;
try {
  chunks = readdirSync(chunksDir).filter((name) => name.endsWith('.js'));
} catch {
  console.warn(`[patch:vite-commonjs] No chunks at ${chunksDir}; skipping.`);
  process.exit(0);
}

let patched = 0;
let already = 0;
for (const name of chunks) {
  const file = join(chunksDir, name);
  const source = readFileSync(file, 'utf8');
  if (source.includes(PATCHED_MARKER)) {
    already++;
    continue;
  }
  if (!VULNERABLE.test(source)) continue;
  writeFileSync(file, source.replace(VULNERABLE, PATCHED));
  console.log(`[patch:vite-commonjs] guarded cached-CommonJS rebuild in ${name}`);
  patched++;
}

if (patched === 0 && already === 0) {
  console.warn(
    '[patch:vite-commonjs] The vulnerable pattern was not found in any Vite chunk. Either Vite ' +
      'fixed this upstream (drop this script) or the code moved (update the pattern). Dev ' +
      'rebuilds of the main process may silently keep a stale bundle until then.'
  );
} else if (patched === 0) {
  console.log('[patch:vite-commonjs] already guarded.');
}
