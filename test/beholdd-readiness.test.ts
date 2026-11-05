import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { beholddStartupReadiness } from '../src/main/beholddReadiness';

function fixture(t: { after(fn: () => unknown): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-beholdd-readiness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binaryPath = join(root, 'beholdd');
  const defaultConfigPath = join(root, 'config.yaml');
  writeFileSync(binaryPath, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  return { root, binaryPath, defaultConfigPath, canPrepareConfig: () => false };
}

test('an executable and the existing default configuration allow deferred startup without writing or executing', (t) => {
  const input = fixture(t);
  writeFileSync(input.defaultConfigPath, '# existing config\nmodels: []\n');
  const before = readdirSync(input.root).map((file) => [file, readFileSync(join(input.root, file), 'utf8')]);
  for (let i = 0; i < 3; i++) {
    assert.equal(beholddStartupReadiness(input).state, 'startable');
  }
  assert.deepEqual(readdirSync(input.root).map((file) => [file, readFileSync(join(input.root, file), 'utf8')]), before);
});

test('a generated configuration can start Beholdd without a base configuration', (t) => {
  const input = fixture(t);
  assert.equal(beholddStartupReadiness({ ...input, canPrepareConfig: () => true }).state, 'startable');
  assert.deepEqual(readdirSync(input.root), ['beholdd'], 'inspection must not generate the configuration');
});

test('configuration preparation errors use the default fallback that actual startup uses', (t) => {
  const input = fixture(t);
  const canPrepareConfig = () => { throw new Error('invalid overlay'); };
  assert.equal(beholddStartupReadiness({ ...input, canPrepareConfig }).state, 'unreachable');
  writeFileSync(input.defaultConfigPath, 'models: []\n');
  assert.equal(beholddStartupReadiness({ ...input, canPrepareConfig }).state, 'startable');
});

test('missing, nonexecutable, and directory binaries are unavailable even with a generated configuration', (t) => {
  const input = fixture(t);
  const canPrepareConfig = () => { throw new Error('binary validation must run first'); };
  chmodSync(input.binaryPath, 0o600);
  assert.match(beholddStartupReadiness({ ...input, canPrepareConfig }).detail!, /executable is unavailable/);
  rmSync(input.binaryPath);
  assert.equal(beholddStartupReadiness({ ...input, canPrepareConfig }).state, 'unreachable');
  mkdirSync(input.binaryPath);
  assert.equal(beholddStartupReadiness({ ...input, canPrepareConfig }).state, 'unreachable');
});

test('a missing or directory default configuration is unavailable when no overlay can be generated', (t) => {
  const input = fixture(t);
  assert.match(beholddStartupReadiness(input).detail!, /no available startup configuration/);
  mkdirSync(input.defaultConfigPath);
  assert.equal(beholddStartupReadiness(input).state, 'unreachable');
});

test('symlinked executable and configuration files remain usable, and removal is observed on the next inspection', (t) => {
  const input = fixture(t);
  writeFileSync(input.defaultConfigPath, 'models: []\n');
  const binaryLink = join(input.root, 'beholdd-link');
  const configLink = join(input.root, 'config-link');
  symlinkSync(input.binaryPath, binaryLink);
  symlinkSync(input.defaultConfigPath, configLink);
  const links = { ...input, binaryPath: binaryLink, defaultConfigPath: configLink };
  assert.equal(beholddStartupReadiness(links).state, 'startable');
  rmSync(input.defaultConfigPath);
  assert.equal(beholddStartupReadiness(links).state, 'unreachable');
});
