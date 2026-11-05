#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { rebuildNativeForRelease } from './lib/native-release.mjs';

/**
 * Rebuilds the one native module against Electron's ABI.
 *
 * node-pty is compiled for whatever runtime built it, and npm builds it for the system Node —
 * which is not the Node inside Electron. Without this it loads in a script and fails in the app.
 *
 * The Electron version is read from the installed package rather than written here, so bumping
 * Electron cannot silently leave a module compiled for the previous one.
 *
 * A failure is a warning, not an error: everything except the terminal works without it, and
 * `npm install` refusing to finish on a machine with no compiler would be a worse trade.
 */
const require = createRequire(import.meta.url);

let version;
try {
  version = require('electron/package.json').version;
} catch {
  console.warn('[rebuild:native] Electron is not installed yet; skipping.');
  process.exit(0);
}

if (process.argv.includes('--release')) {
  await rebuildNativeForRelease(fileURLToPath(new URL('..', import.meta.url)));
  process.exit(0);
}

try {
  // Keep Electron headers in a location that is writable in build sandboxes and CI. npm's
  // default node-gyp cache is under the user's home directory, which is intentionally
  // read-only in several supported build environments.
  const nodeGypDevDir =
    process.env.npm_config_devdir ?? join(tmpdir(), 'antimatter-node-gyp');
  execFileSync(
    'npm',
    [
      'rebuild',
      'node-pty',
      '--runtime=electron',
      `--target=${version}`,
      '--dist-url=https://electronjs.org/headers',
      '--build-from-source',
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, npm_config_devdir: nodeGypDevDir },
    }
  );
  console.log(`[rebuild:native] node-pty rebuilt for Electron ${version}.`);
} catch (error) {
  console.warn(
    `[rebuild:native] could not rebuild node-pty for Electron ${version}: ${error.message}\n` +
      '[rebuild:native] Everything but the terminal will work. Retry with: npm run rebuild:native'
  );
}
