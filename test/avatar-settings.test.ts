import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AvatarSettingsStore, avatarPosition, normalizeAvatar } from '../src/main/avatar/settings';

test('desktop companion is opt-in and validates kinds and coordinates', () => {
  assert.deepEqual(normalizeAvatar(null), { enabled: false, kind: 'atom', x: null, y: null });
  assert.deepEqual(normalizeAvatar({ enabled: 'yes', kind: '<script>', x: NaN, y: Infinity }), { enabled: false, kind: 'atom', x: null, y: null });
});
test('companion follows work areas and recovers a disconnected monitor', () => {
  const state = normalizeAvatar({ x: 5000, y: 5000 });
  assert.deepEqual(avatarPosition(state, [{ x: 0, y: 0, width: 1000, height: 800 }]), { x: 820, y: 592 });
  assert.deepEqual(avatarPosition(normalizeAvatar({ x: -400, y: 500 }), [{ x: -1000, y: 0, width: 1000, height: 800 }]), { x: -400, y: 500 });
});
test('companion selection, visibility and position persist without turning it on implicitly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antimatter-avatar-'));
  try {
    const store = new AvatarSettingsStore(join(dir, 'avatar.json'));
    store.update({ kind: 'cat', x: 50, y: 60 });
    assert.equal(store.get().enabled, false);
    store.update({ enabled: true });
    assert.deepEqual(new AvatarSettingsStore(join(dir, 'avatar.json')).get(), { enabled: true, kind: 'cat', x: 50, y: 60 });
  } finally { rmSync(dir, { recursive: true }); }
});
