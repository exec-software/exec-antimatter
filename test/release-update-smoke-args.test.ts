import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Every invocation stops at preflight, before any archive copy, installer, or updater is started.
const script = join(process.cwd(), 'scripts/smoke-release-update.mjs');
const currentVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version as string;
const invoke = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10_000 });

test('upgrade smoke rejects missing, malformed, oversized, and repeated previous versions before reading inputs', () => {
  for (const args of [
    ['--previous-version'], ['--previous-version', '--keep'],
    ...['v1', 'v1.0.0', '../1.0.0', '01.0.0', '1.0.0-beta.1', '1.0.0\n', '9'.repeat(81)].map((value) => ['--previous-version', value]),
    ['--previous-version', '1.0.0', '--previous-version', '0.1.0-alpha.2'],
  ]) {
    const result = invoke(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--previous-version (?:requires|must be|may be specified only once)/);
    assert.doesNotMatch(result.stdout, /Installing|Running the real|isolated tree/);
  }
});

function inputs(t: { after(fn: () => void): void }): string[] {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-upgrade-args-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  const feed = join(root, 'feed');
  mkdirSync(dist);
  mkdirSync(feed);
  writeFileSync(join(dist, 'release-manifest.json'), JSON.stringify({ name: 'Antimatter', version: currentVersion }));
  writeFileSync(join(feed, 'index.json'), JSON.stringify({ schema: 'execute.buildd/index-v2', project: 'antimatter', builds: [] }));
  return ['--dist', dist, '--previous-feed', feed];
}

test('upgrade smoke defaults to the released 1.0.0 build and accepts an explicitly selected legacy alpha', (t) => {
  const args = inputs(t);
  const defaulted = invoke(args);
  assert.notEqual(defaulted.status, 0);
  assert.match(defaulted.stderr, /read-only managed feed has no 1\.0\.0 build/);
  const legacy = invoke([...args, '--previous-version', '0.1.0-alpha.2']);
  assert.notEqual(legacy.status, 0);
  assert.match(legacy.stderr, /read-only managed feed has no 0\.1\.0-alpha\.2 build/);
  for (const result of [defaulted, legacy]) assert.doesNotMatch(result.stdout, /Installing|Running the real|isolated tree/);
});

test('upgrade smoke refuses equal or newer previous versions before reading the managed feed', (t) => {
  const args = inputs(t);
  const nextMajor = Number(currentVersion.split('.')[0]) + 1;
  for (const version of [currentVersion, `${nextMajor}.0.0`]) {
    const result = invoke([...args, '--previous-version', version]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /previous version must be older than the target release/);
    assert.doesNotMatch(result.stdout, /Installing|Running the real|isolated tree/);
  }
});
