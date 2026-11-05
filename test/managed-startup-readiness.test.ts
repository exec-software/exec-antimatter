import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { managedModelStartupReadiness } from '../src/main/llamaVulkan';

test('an inactive bundled workload is startable only with a readable model and installed executable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'managed-startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const model = join(root, 'model.gguf'); const binary = join(root, 'llama-server');
  writeFileSync(model, 'fixture weights'); writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(managedModelStartupReadiness(model, binary).state, 'startable');
  assert.equal(managedModelStartupReadiness(join(root, 'missing.gguf'), binary).state, 'unreachable');
  assert.equal(managedModelStartupReadiness(null, binary).state, 'unreachable');
  assert.equal(managedModelStartupReadiness(root, binary).state, 'unreachable');
  chmodSync(binary, 0o600);
  assert.equal(managedModelStartupReadiness(model, binary).state, 'unreachable');
  rmSync(binary);
  assert.equal(managedModelStartupReadiness(model, binary).state, 'unreachable');
});
