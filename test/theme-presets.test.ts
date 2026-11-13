import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeAppearance, validateAppearancePatch } from '../src/api/appearance';
import { THEME_PRESETS, validateThemeDefinition } from '../src/api/themes';
import { AppearanceSettingsStore, appearanceBackground } from '../src/main/appearance';
import { contrastRatio, paletteFor, themeVariantFor } from '../renderer/src/theme';
import { terminalThemeFor } from '../renderer/src/plugins/terminal/theme';

test('each editor palette has complete independent dark/light UI, syntax and ANSI colors', () => {
  const surfaces = new Set<string>();
  for (const theme of THEME_PRESETS) {
    assert.deepEqual(validateThemeDefinition(theme), theme);
    surfaces.add(theme.dark.ui.surface);
    for (const mode of ['dark', 'light'] as const) {
      const settings = normalizeAppearance({ theme: mode, themePreset: theme.id, useThemeAccent: true });
      assert.deepEqual(paletteFor(settings), theme[mode].ui);
      assert.deepEqual(themeVariantFor(settings).syntax, theme[mode].syntax);
      assert.equal(appearanceBackground(settings), theme[mode].ui.surface);
      assert.equal(terminalThemeFor(settings).red, theme[mode].terminal.red);
      assert.ok(contrastRatio(theme[mode].ui.ink, theme[mode].ui.surface) >= 4.5, `${theme.name} ${mode} text must be readable`);
      assert.ok(contrastRatio(theme[mode].ui.ink2, theme[mode].ui.surface2) >= 4.5, `${theme.name} ${mode} secondary text must be readable`);
    }
  }
  assert.equal(surfaces.size, THEME_PRESETS.length);
});

test('custom themes round trip intact without CSS injection or unknown fields', () => {
  const theme = structuredClone(THEME_PRESETS[1]); theme.id = 'custom-sample'; theme.name = 'Custom sample';
  theme.dark.ui.surface = '#123456'; theme.dark.syntax.string = '#abcdef'; theme.dark.terminal.magenta = '#fedcba';
  const settings = normalizeAppearance({ themePreset: 'custom', customTheme: theme, useThemeAccent: true });
  assert.equal(paletteFor(settings).surface, '#123456');
  assert.equal(themeVariantFor(settings).syntax.string, '#abcdef');
  assert.equal(terminalThemeFor(settings).magenta, '#fedcba');
  for (const invalid of ['red', '#fff', 'var(--accent)', '#123456; color:red', 'url(https://example.test)']) {
    const bad = structuredClone(theme); bad.dark.ui.surface = invalid;
    assert.throws(() => validateThemeDefinition(bad), /hex color/);
    assert.equal(normalizeAppearance({ themePreset: 'custom', customTheme: bad }).themePreset, 'antimatter');
  }
  assert.throws(() => validateThemeDefinition({ ...theme, css: 'body {}' }), /exactly/);
  assert.throws(() => validateThemeDefinition({ ...theme, version: 2 }), /version/);
  assert.throws(() => validateAppearancePatch({ themePreset: 'download-me' }), /supported/);
  assert.throws(() => validateAppearancePatch({ customTheme: {} }));
});

test('custom theme snapshots are detached and identical updates do not write again', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'theme-store-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'appearance.json');
  const store = new AppearanceSettingsStore(file);
  store.update({ themePreset: 'custom', customTheme: THEME_PRESETS[2], useThemeAccent: true });
  const copy = store.get(); copy.customTheme!.dark.ui.surface = '#000000';
  assert.notEqual(store.get().customTheme!.dark.ui.surface, '#000000');
  const reloaded = new AppearanceSettingsStore(file, () => { throw new Error('unnecessary write'); });
  assert.deepEqual(reloaded.update({ customTheme: structuredClone(THEME_PRESETS[2]) }), store.get());
});

test('scheduled themes resolve syntax, terminal and initial window backgrounds together', () => {
  const settings = normalizeAppearance({ theme: 'dark', autoTheme: true, autoLightFrom: '00:00', autoDarkFrom: '23:59', themePreset: 'github', useThemeAccent: true });
  const midday = new Date(2026, 0, 1, 12, 0);
  assert.equal(paletteFor(settings, midday).surface, THEME_PRESETS[3].light.ui.surface);
  assert.equal(themeVariantFor(settings, midday).terminal.blue, THEME_PRESETS[3].light.terminal.blue);
  assert.equal(appearanceBackground(settings, midday), THEME_PRESETS[3].light.ui.surface);
});
