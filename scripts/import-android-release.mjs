#!/usr/bin/env node

// Imports a protected-environment signature; this process never receives a private key/password.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importAndroidRelease } from './lib/android-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--apk' || !path.isAbsolute(args[1])) {
  throw new Error('Usage: node scripts/import-android-release.mjs --apk /absolute/path/signed-release.apk');
}
const result = importAndroidRelease(root, path.join(root, 'releases/dist'), args[1]);
console.log(`Verified Android ${result.publicRelease} (${result.versionName}, code ${result.versionCode}): ${result.apk}`);
console.log(`Production certificate SHA-256: ${result.certificateSha256}`);
console.log('Updated the release manifest, exact published asset list and SHA256SUMS atomically.');
