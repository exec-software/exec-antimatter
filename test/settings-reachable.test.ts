import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_DEVELOPER_SETTINGS } from '../src/main/developerSettings';
import { WhiteboardPanel } from '../renderer/src/components/developer/WhiteboardPanel';

/**
 * Every switch has to be reachable from the interface.
 *
 * This exists because the whiteboard shipped with a flag, a store, tools, a page and a Desk
 * entry, and nothing anywhere that could turn it on — so the only way to see the feature was to
 * hand-edit developer.json, and the advice given was to visit a Settings page that did not exist.
 * A flag with no control is indistinguishable from a broken feature.
 */

/** Flags that gate something a person can see, and must therefore be switchable in Settings. */
const SETTINGS_FLAGS = ['hardwareAcceleration', 'fileHistory', 'whiteboard'] as const;

/** `autoContinue` is deliberately absent: it is turn behaviour and lives on the Developer page. */
const DEVELOPER_PAGE_FLAGS = ['autoContinue', 'screenCapture', 'machineWide'] as const;

test('every developer flag is either in Settings or on the Developer page', () => {
  const known = new Set<string>([...SETTINGS_FLAGS, ...DEVELOPER_PAGE_FLAGS]);
  for (const key of Object.keys(DEFAULT_DEVELOPER_SETTINGS)) {
    assert.ok(known.has(key), `${key} is a developer setting with nowhere to change it; add a panel or list it here`);
  }
});

test('each Settings flag has a section mounted on the page', () => {
  // Read the page rather than render it: the sections own their own IPC reads, and what matters
  // here is that they are mounted at all.
  const page = readFileSync('renderer/src/components/settings/SettingsPage.tsx', 'utf8');
  const sections: Record<(typeof SETTINGS_FLAGS)[number], string> = {
    hardwareAcceleration: 'HardwareAccelerationSection',
    fileHistory: 'FileHistorySection',
    whiteboard: 'WhiteboardSection',
  };
  for (const flag of SETTINGS_FLAGS) {
    const section = sections[flag];
    assert.match(page, new RegExp(`import \\{ ${section} \\}`), `${flag} has no ${section} import`);
    assert.match(page, new RegExp(`<${section} />`), `${flag}'s ${section} is imported but never rendered`);
  }
});

test('the whiteboard toggle says what it switches on, including where to find it', () => {
  const markup = renderToStaticMarkup(createElement(WhiteboardPanel, {
    value: { enabled: false }, onChange: () => {}, disabled: false,
  }));
  assert.match(markup, /type="checkbox"/);
  // Naming the Desk matters: the feature appears somewhere other than where it is switched on.
  assert.match(markup, /Desk/);
  assert.match(markup, /experimental/);
  // Honest about being unfinished rather than implying it is dangerous.
  assert.match(markup, /drawing, images and grouping are not built/);
});
