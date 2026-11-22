import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_DEVELOPER_SETTINGS } from '../src/main/developerSettings';
import { WhiteboardPanel } from '../renderer/src/components/developer/WhiteboardPanel';
import { GuardrailsPanel } from '../renderer/src/components/developer/GuardrailsPanel';
import { DEFAULT_GUARDRAILS } from '../src/main/guardrails';

/**
 * Every switch has to be reachable from the interface.
 *
 * This exists because the whiteboard shipped with a flag, a store, tools, a page and a Desk
 * entry, and nothing anywhere that could turn it on — so the only way to see the feature was to
 * hand-edit developer.json, and the advice given was to visit a Settings page that did not exist.
 * A flag with no control is indistinguishable from a broken feature.
 */

/** Flags that gate something a person can see, and must therefore be switchable in Settings. */
const SETTINGS_FLAGS = ['hardwareAcceleration', 'fileHistory', 'whiteboard', 'guardrails'] as const;

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
    guardrails: 'GuardrailsSection',
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

test('the guardrails panel names every rail it can switch, and what each one ends the turn as', () => {
  const markup = renderToStaticMarkup(createElement(GuardrailsPanel, {
    value: DEFAULT_GUARDRAILS, onChange: () => {}, disabled: false,
  }));
  // One control per stored rail: a rail with no switch here is a rail nobody can find.
  const controls = markup.match(/type="checkbox"/g)?.length ?? 0;
  assert.equal(controls, Object.keys(DEFAULT_GUARDRAILS).length,
    'every guardrail needs its own checkbox on the panel');
  // The stop reason is what a carbon records, so the page uses the same words the transcript does.
  for (const reason of ['limit', 'stalled', 'flooding', 'no-progress']) {
    assert.match(markup, new RegExp(reason), `the panel should name the ${reason} stop reason`);
  }
  // Nothing alarming while the shipped rails are all on.
  assert.doesNotMatch(markup, /runs until it answers or you press stop/);
});

test('turning every stop condition off says plainly what is left', () => {
  const off = {
    ...DEFAULT_GUARDRAILS,
    turnBudget: { enabled: false, limit: 2048 },
    repeatedCalls: { enabled: false, limit: 3 },
    batchOverrun: { enabled: false, limit: 3 },
    completionClaims: { enabled: false, limit: 3 },
    repeatedValidation: { enabled: false, limit: 3 },
  };
  const markup = renderToStaticMarkup(createElement(GuardrailsPanel, {
    value: off, onChange: () => {}, disabled: false,
  }));
  // A page that lets someone remove every guard has to say so where they removed it.
  assert.match(markup, /nothing here will end a looping turn/);
});
