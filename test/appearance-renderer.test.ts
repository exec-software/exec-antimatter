import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { colors } from '../vendor/displacer/tokens/index';
import { DEFAULT_APPEARANCE, resolveTheme, type AppearanceAPI, type AppearanceSettings } from '../src/api/appearance';
import { accentPresets, contrastRatio, paletteFor, themeVariables } from '../renderer/src/theme';
import { getAppearance, initializeAppearance, saveAppearance, subscribeAppearance } from '../renderer/src/appearance';
import { AppearancePanel } from '../renderer/src/components/settings/AppearancePanel';
import { AgentGlyph, agentColor } from '../renderer/src/components/chat/AgentGlyph';

test('dark and light use Clay neutral surfaces with the selected accent for every primary action', () => {
  const dark = paletteFor(DEFAULT_APPEARANCE);
  assert.equal(dark.surface, colors.clay.bg.page);
  assert.equal(dark.primary, dark.accent);
  assert.equal(dark.accent, colors.clay.accent.default);
  assert.equal(dark.accentStrong, colors.clay.accent.hover);
  const light = paletteFor({ ...DEFAULT_APPEARANCE, theme: 'light' });
  assert.equal(light.surface, colors['clay-light'].bg.page, 'the light base is the library theme, not a local copy');
  assert.equal(light.ink, colors['clay-light'].fg.default);
  assert.equal(light.surface0, colors['clay-light'].fg.inverse);
  assert.notEqual(light.primary, colors.light.primary.default, 'do not reuse the unrelated library light brand');
  assert.notEqual(light.accent, dark.accent, 'light needs a darker tone of the chosen hue');
  for (const background of [light.surface, light.surface2, light.surface3, light.surface0, light.raised]) {
    for (const color of [light.ink, light.ink2, light.ink3, light.primary, light.primaryStrong, light.accent, light.accentStrong]) {
      assert.ok(contrastRatio(color, background) >= 4.5, `${color} on ${background}`);
    }
  }
});

test('presets and extreme custom accents recolor primary actions while preserving readable status colors', () => {
  for (const theme of ['dark', 'light'] as const) {
    const base = paletteFor({ ...DEFAULT_APPEARANCE, theme });
    const everyPreset = [...accentPresets('dark'), ...accentPresets('light')].map((p) => p.color);
    for (const secondaryAccent of [...everyPreset, '#000000', '#ffffff', '#eeeeee', '#333333', '#ff0000', '#0000ff', '#00ff00', '#ffff00']) {
      const p = paletteFor({ theme, secondaryAccent });
      for (const bg of [p.surface, p.surface2, p.surface3, p.surface0, p.raised]) {
        assert.ok(contrastRatio(p.accent, bg) >= 4.5, `${theme} ${secondaryAccent} on ${bg}`);
        assert.ok(contrastRatio(p.accentStrong, bg) >= 4.5);
      }
      for (const key of ['danger', 'success', 'warning', 'info', 'onDanger'] as const) assert.equal(p[key], base[key]);
      assert.equal(p.primary, p.accent);
      assert.equal(p.primaryStrong, p.accentStrong);
      assert.equal(p.onPrimary, p.onAccent);
      assert.ok(contrastRatio(p.onAccent, p.accent) >= 4.5);
      for (const color of [p.primary, p.primaryStrong]) assert.ok(contrastRatio(p.onPrimary, color) >= 4.5);
      assert.ok(contrastRatio(p.onDanger, p.danger) >= 4.5);
    }
  }
});

test('Displacer, Tailwind and auxiliary-window aliases agree and accept only normalized colors', () => {
  const values = themeVariables({ theme: 'light', secondaryAccent: 'url(https://example.invalid)' });
  assert.deepEqual(values, themeVariables({ ...DEFAULT_APPEARANCE, theme: 'light' }));
  assert.equal(values['--accent'], values['--color-accent']);
  assert.equal(values['--surface'], values['--color-surface']);
  assert.equal(values['--primary'], values['--color-accent']);
  assert.equal(values['--color-primary-strong'], values['--color-accent-strong']);
  assert.equal(values['--ds-primary'], values['--ds-accent']);
  for (const [key, value] of Object.entries(values)) assert.match(value, key.startsWith('--ds-') ? /^#[0-9a-f]{6}$/ : /^\d+ \d+ \d+$/);
});

function renderer(t: { after(fn: () => void): void }) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const values = new Map<string, string>();
  const root = { style: { colorScheme: '', setProperty: (key: string, value: string) => values.set(key, value) }, dataset: {} as Record<string, string> };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: root } });
  let settings: AppearanceSettings = { ...DEFAULT_APPEARANCE };
  let fail = false;
  let listener: ((next: AppearanceSettings) => void) | undefined;
  let removed = 0;
  const api: AppearanceAPI = {
    initial: settings,
    get: async () => settings,
    update: async (patch) => { if (fail) throw new Error('disk full'); settings = { ...settings, ...patch }; listener?.(settings); return settings; },
    onChanged: (next) => { listener = next; return () => { listener = undefined; removed++; }; },
  };
  const initialize = () => initializeAppearance(api);
  const cleanup = initialize();
  t.after(() => { cleanup(); if (before) Object.defineProperty(globalThis, 'document', before); else Reflect.deleteProperty(globalThis, 'document'); });
  return { root, values, api, cleanup, initialize, get removed() { return removed; }, fail: () => { fail = true; }, emit: (next: AppearanceSettings) => { settings = next; listener?.(next); } };
}

test('first paint, live events, durable saves and cleanup use the same palette', async (t) => {
  const box = renderer(t);
  assert.equal(box.root.dataset.theme, 'dark');
  const seen: string[] = [];
  const unsubscribe = subscribeAppearance((next) => seen.push(next.theme));
  t.after(unsubscribe);
  await saveAppearance({ theme: 'light', secondaryAccent: '#aa8cf4' });
  assert.equal(box.root.style.colorScheme, 'light');
  assert.equal(box.root.dataset.dsTheme, 'clay-light');
  assert.equal(box.values.get('--color-accent'), themeVariables(getAppearance())['--color-accent']);
  assert.deepEqual(seen, ['light']);
  box.cleanup();
  assert.equal(box.removed, 1);
  box.emit({ ...DEFAULT_APPEARANCE });
  assert.equal(getAppearance().theme, 'light');
  await assert.rejects(saveAppearance({ theme: 'dark' }), /unavailable/);
});

test('failed saves preserve the displayed and persisted preference', async (t) => {
  const box = renderer(t);
  box.emit({ theme: 'light', secondaryAccent: '#aa8cf4' });
  const before = getAppearance();
  box.fail();
  await assert.rejects(saveAppearance({ theme: 'dark' }), /disk full/);
  assert.deepEqual(getAppearance(), before);
  assert.equal(box.root.dataset.theme, 'light');
});

test('agent identity hues adapt to light surfaces without changing their dark marks', (t) => {
  const box = renderer(t);
  for (let index = 0; index < 8; index++) {
    const agentId = `agent-${index}`;
    const dark = renderToStaticMarkup(createElement(AgentGlyph, { agentId }));
    assert.ok(dark.includes(`color:${agentColor(agentId)};`));
  }
  box.emit({ ...DEFAULT_APPEARANCE, theme: 'light' });
  for (let index = 0; index < 8; index++) {
    const agentId = `agent-${index}`;
    const light = renderToStaticMarkup(createElement(AgentGlyph, { agentId }));
    const expected = paletteFor({ theme: 'light', secondaryAccent: agentColor(agentId) });
    assert.ok(light.includes(`color:${expected.accent};`));
    assert.ok(contrastRatio(expected.accent, expected.surface3) >= 4.5);
  }
});

test('a late startup read or older save reply cannot overwrite a newer live event', async (t) => {
  const box = renderer(t);
  let resolveRead!: (next: AppearanceSettings) => void;
  box.api.get = () => new Promise((resolve) => { resolveRead = resolve; });
  const cleanup = box.initialize(); t.after(cleanup);
  const light = { ...DEFAULT_APPEARANCE, theme: 'light', secondaryAccent: '#aa8cf4' } as const;
  box.emit(light);
  resolveRead({ ...DEFAULT_APPEARANCE });
  await Promise.resolve();
  assert.deepEqual(getAppearance(), light);
  let resolveSave!: (next: AppearanceSettings) => void;
  box.api.update = () => new Promise((resolve) => { resolveSave = resolve; });
  const saving = saveAppearance({ theme: 'dark' });
  box.emit({ ...light, secondaryAccent: '#dba844' });
  resolveSave({ ...DEFAULT_APPEARANCE });
  await saving;
  assert.deepEqual(getAppearance(), { ...light, secondaryAccent: '#dba844' });
});

test('appearance settings are discoverable, labelled, and default to dark without system-theme inference', () => {
  const cleanup = initializeAppearance();
  try {
    const html = renderToStaticMarkup(createElement(AppearancePanel));
    assert.match(html, /Appearance/);
    assert.match(html, /aria-label="Dark theme"[^>]*checked=""/);
    assert.match(html, /aria-label="Light theme"/);
    assert.match(html, /Accent color/);
    assert.match(html, /aria-label="Accent hex value"/);
    assert.match(html, /Reset to dark &amp; teal/);
    assert.doesNotMatch(html, /System theme/, 'the theme is never inferred from the operating system');
    assert.match(html, /role="switch"[^>]*aria-checked="false"/, 'automatic switching is off until asked for');
    assert.match(html, /Switch automatically by time of day/);
    assert.doesNotMatch(html, /aria-label="Light from"/, 'the schedule fields stay hidden while the switch is off');
  } finally { cleanup(); }
});

test('each theme offers its own accent seeds, already readable and left untouched by the palette', () => {
  for (const theme of ['dark', 'light'] as const) {
    const presets = accentPresets(theme);
    assert.equal(presets.length, 6);
    assert.deepEqual(presets.map((p) => p.name), accentPresets(theme === 'dark' ? 'light' : 'dark').map((p) => p.name),
      'both themes name the same six hues');
    const tones = presets.map((preset) => {
      const p = paletteFor({ theme, secondaryAccent: preset.color });
      for (const bg of [p.surface, p.surface2, p.surface3, p.surface0, p.raised]) {
        assert.ok(contrastRatio(p.accent, bg) >= 4.5, `${theme} ${preset.name} on ${bg}`);
      }
      // Selecting a preset must light that preset up: storing the seed and re-deriving the tone
      // has to land on the same color the panel painted on the chip.
      assert.equal(paletteFor({ theme, secondaryAccent: p.accent }).accent, p.accent,
        `${theme} ${preset.name} must settle in one step`);
      return p.accent;
    });
    assert.equal(new Set(tones).size, tones.length, `${theme} presets must not collapse onto one tone`);
  }
  // The two themes must not share a literal palette, or one of them would be unreadable.
  for (const [dark, light] of accentPresets('dark').map((p, i) => [p, accentPresets('light')[i]] as const)) {
    assert.notEqual(dark.color, light.color, `${dark.name} needs a tone per theme`);
  }
  // Clay Light's own brand roles are what the first two presets offer.
  assert.equal(accentPresets('light')[0].color, colors['clay-light'].primary.default);
  assert.equal(accentPresets('light')[1].color, colors['clay-light'].accent.default);
  assert.equal(accentPresets('dark')[0].color, colors.clay.primary.default);
  assert.equal(accentPresets('dark')[1].color, colors.clay.accent.default);
});

test('the default teal lands on Clay Light\u2019s accent, so the shipped accent needs no light override', () => {
  const light = paletteFor({ ...DEFAULT_APPEARANCE, theme: 'light' });
  assert.equal(light.accent, colors['clay-light'].accent.default);
  const dark = paletteFor(DEFAULT_APPEARANCE);
  assert.equal(dark.accent, colors.clay.accent.default);
});

test('a scheduled palette follows the clock while a preview keeps asking for one lightness', () => {
  const scheduled = { ...DEFAULT_APPEARANCE, theme: 'dark' as const, autoTheme: true, autoLightFrom: '07:00', autoDarkFrom: '19:00' };
  const noon = new Date(2026, 3, 14, 12);
  const night = new Date(2026, 3, 14, 23);
  assert.equal(paletteFor(scheduled, noon).surface, colors['clay-light'].bg.page);
  assert.equal(paletteFor(scheduled, night).surface, colors.clay.bg.page);
  assert.equal(themeVariables(scheduled, noon)['--color-surface'], themeVariables({ ...DEFAULT_APPEARANCE, theme: 'light' })['--color-surface']);
  assert.notDeepEqual(themeVariables(scheduled, noon), themeVariables(scheduled, night));
  // A preview passes no schedule, so it renders the lightness it names even at the wrong hour.
  assert.equal(paletteFor({ theme: 'light', autoTheme: false }, night).surface, colors['clay-light'].bg.page);
});

test('a scheduled flip repaints the document even though the stored settings never changed', async (t) => {
  const box = renderer(t);
  const scheduled: AppearanceSettings = { ...DEFAULT_APPEARANCE, autoTheme: true, autoLightFrom: '00:00', autoDarkFrom: '23:59' };
  box.emit(scheduled);
  // 00:00–23:59 is light for all but the final minute, so this is deterministic outside it.
  const expected = resolveTheme(scheduled, new Date());
  assert.equal(box.root.dataset.theme, expected);
  assert.equal(box.root.dataset.dsTheme, expected === 'light' ? 'clay-light' : 'clay');
  assert.equal(box.root.dataset.themeSource, 'schedule', 'the document records why it is this lightness');
  box.emit({ ...DEFAULT_APPEARANCE, theme: expected });
  assert.equal(box.root.dataset.themeSource, 'manual');
  // Re-broadcasting identical settings must still hand the listeners a fresh object to render.
  const seen: string[] = [];
  const unsubscribe = subscribeAppearance(() => seen.push(box.root.dataset.theme!));
  t.after(unsubscribe);
  box.emit({ ...DEFAULT_APPEARANCE, theme: expected });
  assert.equal(seen.length, 1, 'a boundary nudge carrying unchanged settings still notifies');
});

test('the schedule fields and live status appear once automatic switching is on', () => {
  const cleanup = initializeAppearance();
  try {
    const html = renderToStaticMarkup(createElement(AppearancePanel));
    assert.doesNotMatch(html, /aria-label="Light from"/);
  } finally { cleanup(); }
  const box = renderer({ after: () => { /* torn down below */ } } as never);
  try {
    box.emit({ ...DEFAULT_APPEARANCE, autoTheme: true, autoLightFrom: '07:00', autoDarkFrom: '19:00' });
    const html = renderToStaticMarkup(createElement(AppearancePanel));
    assert.match(html, /role="switch"[^>]*aria-checked="true"/);
    assert.match(html, /aria-label="Light from"[^>]*value="07:00"/);
    assert.match(html, /aria-label="Dark from"[^>]*value="19:00"/);
    assert.match(html, /Now (dark|light)\./);
    assert.match(html, /Switches to (dark|light) in /);
    assert.match(html, /Accent presets for the (dark|light) theme/);
  } finally { box.cleanup(); }
});
