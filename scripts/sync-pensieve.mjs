import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--source') || !process.argv.includes('--curriculum')) {
  throw new Error('Usage: node scripts/sync-pensieve.mjs --source <Pensieve repository> --curriculum <verified curriculum.json>');
}
const source = resolve(option('--source'));
const curriculum = resolve(option('--curriculum'));
const bundle = JSON.parse(readFileSync(curriculum, 'utf8'));
if (bundle.schema_version !== 1 || !Array.isArray(bundle.entries) || !bundle.entries.length) throw new Error('Invalid curriculum.');
// Public provenance identifies content, not the developer's SDK directory or other local state.
const sdk = {};
for (const key of ['manifest_sha256', 'source_revision', 'compiler_sha256']) {
  const identity = bundle.sdk?.[key];
  const pattern = key === 'source_revision' ? /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/ : /^[0-9a-f]{64}$/;
  if (typeof identity !== 'string' || !pattern.test(identity)) throw new Error(`Invalid SDK identity: ${key}.`);
  sdk[key] = identity;
}
const target = join(root, 'vendor', 'pensieve');
mkdirSync(target, { recursive: true });
// This directory is a derived vendor package, never a user's memory store.
rmSync(join(target, 'pensieve'), { recursive: true, force: true });
mkdirSync(join(target, 'pensieve'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const files = {};
for (const name of readdirSync(join(source, 'pensieve')).filter(name => name.endsWith('.py')).sort()) {
  const destination = join(target, 'pensieve', name);
  cpSync(join(source, 'pensieve', name), destination);
  files[`pensieve/${name}`] = sha(destination);
}
cpSync(curriculum, join(target, 'curriculum.json'));
files['curriculum.json'] = sha(curriculum);
writeFileSync(join(target, 'manifest.json'), JSON.stringify({ schemaVersion: 1, component: 'pensieve',
  version: readFileSync(join(source, 'VERSION'), 'utf8').trim(), curriculumId: bundle.id,
  sdk, python: '>=3.10', defaultEnabled: false, files }, null, 2) + '\n');
console.log(JSON.stringify({ target, curriculum: bundle.id, entries: bundle.entries.length }));
