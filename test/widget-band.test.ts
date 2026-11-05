import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_APPEARANCE, normalizeAppearance, validateAppearancePatch } from '../src/api/appearance';
import { honeycombRows } from '../renderer/src/plugins/WidgetBand';
import { BAND_ARRANGEMENTS, BAND_SIDES, isBandSide } from '../renderer/src/plugins/types';
import { DOCK_LIMITS, BAND_HEIGHT_LIMITS } from '../renderer/src/plugins/layout';
import { AppearancePanel } from '../renderer/src/components/settings/AppearancePanel';
import { initializeAppearance } from '../renderer/src/appearance';

test('a honeycomb interlocks its rows and never loses or invents a tile', () => {
  assert.deepEqual(honeycombRows(0, 3), []);
  assert.deepEqual(honeycombRows(1, 3), [1]);
  assert.deepEqual(honeycombRows(3, 3), [3]);
  assert.deepEqual(honeycombRows(4, 3), [3, 1]);
  assert.deepEqual(honeycombRows(5, 3), [3, 2]);
  assert.deepEqual(honeycombRows(6, 3), [3, 2, 1]);
  assert.deepEqual(honeycombRows(8, 3), [3, 2, 3]);

  for (let perRow = 1; perRow <= 5; perRow++) {
    for (let count = 0; count <= 40; count++) {
      const rows = honeycombRows(count, perRow);
      assert.equal(rows.reduce((sum, row) => sum + row, 0), count, `${count}/${perRow} must place every tile`);
      assert.ok(rows.every((row) => row >= 1), 'an empty course would leave a visible gap');
      assert.ok(rows.every((row) => row <= Math.max(1, perRow)), 'no course may exceed the full width');
      // Courses alternate full and short so the tiles nest; only the last may be cut off early.
      for (const [index, row] of rows.entries()) {
        if (index === rows.length - 1) continue;
        const expected = index % 2 === 0 ? Math.max(1, perRow) : Math.max(1, perRow - 1);
        assert.equal(row, expected, `course ${index} of ${count}/${perRow}`);
      }
    }
  }
  // A single-column band has no room to stagger, so it degenerates to a plain stack.
  assert.deepEqual(honeycombRows(4, 1), [1, 1, 1, 1]);
});

test('the band sides are anchors with their own limits, and are not sized like a dock', () => {
  assert.deepEqual([...BAND_SIDES], ['band-left', 'band-right']);
  for (const side of BAND_SIDES) {
    assert.ok(isBandSide(side));
    assert.ok(DOCK_LIMITS[side], 'a band side still needs limits so a stored size cannot run away');
  }
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) assert.equal(isBandSide(edge), false);
  assert.ok(BAND_HEIGHT_LIMITS.min > 0 && BAND_HEIGHT_LIMITS.max > BAND_HEIGHT_LIMITS.min);
  assert.deepEqual([...BAND_ARRANGEMENTS], ['vertical', 'horizontal', 'grid', 'hex']);
});

test('the band is an appearance preference, defaulting on and validated like the rest', () => {
  assert.equal(DEFAULT_APPEARANCE.promptDock, true);
  assert.equal(normalizeAppearance(null).promptDock, true);
  assert.equal(normalizeAppearance({ promptDock: false }).promptDock, false);
  // Only an explicit false turns it off, so a corrupt value cannot silently hide the band.
  for (const odd of ['false', 0, null, 'no', {}, 1, true]) {
    assert.equal(normalizeAppearance({ promptDock: odd }).promptDock, true, `${JSON.stringify(odd)} is not false`);
  }
  assert.deepEqual(validateAppearancePatch({ promptDock: false }), { promptDock: false });
  assert.deepEqual(validateAppearancePatch({ promptDock: true }), { promptDock: true });
  for (const invalid of [{ promptDock: 'yes' }, { promptDock: 1 }, { promptDock: null }]) {
    assert.throws(() => validateAppearancePatch(invalid), /on or off/);
  }
});

test('the band toggle is discoverable in the theme section and explains both states', () => {
  const cleanup = initializeAppearance();
  try {
    const html = renderToStaticMarkup(createElement(AppearancePanel));
    assert.match(html, /Widget band beside the prompt/);
    // Two switches now: the schedule and the band. Both must report their state.
    assert.equal((html.match(/role="switch"/g) ?? []).length, 2);
    // The band's own switch, specifically, and on by default.
    assert.match(html, /role="switch"[^>]*aria-checked="true"[^>]*aria-labelledby="prompt-dock-label"/);
    assert.match(html, /honeycomb/, 'the arrangements are named where the setting is turned on');
    assert.match(html, /floats over the conversation/, 'and so is what turning it off does');
  } finally { cleanup(); }
});
