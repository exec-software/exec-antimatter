import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEVELOPER_SETTINGS_EVENT,
  announceDeveloperSettings,
  onDeveloperSettingsChanged,
} from '../renderer/src/lib/developerSettingsChanged';

/**
 * Ticking a box has to reach whatever is showing it.
 *
 * The sidebar reads the whiteboard flag to decide whether the Desk lists it, and read it once on
 * mount: the setting was written and nothing told the rail, so the entry only appeared after a
 * reload. The setting worked and the seam did not, which is the third time that shape of bug has
 * shipped — hence a test for the wiring rather than for either end of it.
 */

/** A listener-only stand-in for `window`, since this runs outside a DOM. */
function fakeWindow() {
  const listeners = new Map<string, Set<() => void>>();
  const target = {
    addEventListener: (type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => listeners.get(type)?.delete(listener),
    dispatchEvent: (event: { type: string }) => {
      for (const listener of listeners.get(event.type) ?? []) listener();
      return true;
    },
  };
  (globalThis as { window?: unknown }).window = target;
  (globalThis as { Event?: unknown }).Event = class { constructor(public type: string) {} };
  return { count: (type: string) => listeners.get(type)?.size ?? 0 };
}

test('an announcement reaches every listener, and unsubscribing is complete', (t) => {
  const probe = fakeWindow();
  t.after(() => { delete (globalThis as { window?: unknown }).window; });

  let first = 0;
  let second = 0;
  const stopFirst = onDeveloperSettingsChanged(() => { first += 1; });
  const stopSecond = onDeveloperSettingsChanged(() => { second += 1; });
  announceDeveloperSettings();
  assert.deepEqual([first, second], [1, 1]);

  stopFirst();
  announceDeveloperSettings();
  // The one that unsubscribed must stop hearing, and the other must not.
  assert.deepEqual([first, second], [1, 2]);
  stopSecond();
  assert.equal(probe.count(DEVELOPER_SETTINGS_EVENT), 0, 'a left-behind listener outlives the component');
});

test('every section that writes developer settings announces it', () => {
  // A section that writes and stays quiet leaves the sidebar stale until a reload, which is
  // exactly the bug this guards. Checked as source because each section owns its own IPC.
  for (const name of [
    'WhiteboardSection',
    'FileHistorySection',
    'HardwareAccelerationSection',
    'MachineWideSection',
    'ScreenCaptureSection',
  ]) {
    const source = readFileSync(`renderer/src/components/settings/${name}.tsx`, 'utf8');
    assert.match(source, /announceDeveloperSettings\(\)/, `${name} writes a setting without announcing it`);
  }
});

test('the sidebar re-reads on the announcement rather than only on mount', () => {
  const rail = readFileSync('renderer/src/components/layout/LeftRail.tsx', 'utf8');
  assert.match(rail, /onDeveloperSettingsChanged\(/);
});
