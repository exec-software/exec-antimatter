import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_DEVELOPER_SETTINGS,
  DEFAULT_HARDWARE_ACCELERATION,
  normalize,
  normalizeHardwareAcceleration,
  read,
  save,
  useConfigPath,
} from '../src/main/developerSettings';

test('absent means on, unlike every other switch here', () => {
  // This one restores a capability the engine has by default rather than granting a new one, so a
  // settings file written before it existed must not silently cost that install its WebGL.
  assert.deepEqual(DEFAULT_HARDWARE_ACCELERATION, { enabled: true });
  assert.deepEqual(normalizeHardwareAcceleration(undefined), { enabled: true });
  assert.deepEqual(normalizeHardwareAcceleration({}), { enabled: true });
  assert.deepEqual(normalizeHardwareAcceleration(null), { enabled: true });
  assert.equal(DEFAULT_DEVELOPER_SETTINGS.hardwareAcceleration.enabled, true);
  // Only an explicit false turns it off; a stray truthy value is not an opinion.
  assert.deepEqual(normalizeHardwareAcceleration({ enabled: false }), { enabled: false });
  assert.deepEqual(normalizeHardwareAcceleration({ enabled: 'no' }), { enabled: true });
});

test('a settings file that predates the switch keeps hardware acceleration', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-gpu-'));
  const file = join(root, 'developer.json');
  t.after(() => {
    useConfigPath(join(root, 'unused.json'));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(file, JSON.stringify({
    version: 1,
    autoContinue: { enabled: false, maxContinues: 3, onRoundLimit: true },
    screenCapture: { withoutAsking: true },
    machineWide: { withoutAsking: false },
  }));
  useConfigPath(file);
  assert.equal(read().hardwareAcceleration.enabled, true, 'an older file must not lose WebGL');
});

test('turning it off survives a round trip, which is what the restart reads', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-gpu-'));
  const file = join(root, 'developer.json');
  t.after(() => {
    useConfigPath(join(root, 'unused.json'));
    rmSync(root, { recursive: true, force: true });
  });
  useConfigPath(file);
  // The main process reads this before any window exists to decide disableHardwareAcceleration,
  // so what save() wrote has to be what a cold read sees.
  save({ ...DEFAULT_DEVELOPER_SETTINGS, hardwareAcceleration: { enabled: false } });
  useConfigPath(file);
  assert.equal(read().hardwareAcceleration.enabled, false);
  assert.equal(normalize(read()).hardwareAcceleration.enabled, false);
});
