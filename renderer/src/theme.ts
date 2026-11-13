import { colors } from '../../vendor/displacer/tokens/index.js';
import { normalizeAppearance, resolveTheme, type AppearanceSettings, type AppearanceTheme } from '../../src/api/appearance';
import { DEFAULT_FONTS, FONT_ROLES, fontStack, type FontSettings } from '../../src/api/fonts';

import { themeDefinitionFor, type ThemeVariant } from '../../src/api/themes';
export type { ThemePalette } from '../../src/api/themes';
import type { ThemePalette } from '../../src/api/themes';

/**
 * The same six hues per theme, each seeded at a tone that already clears AA on that theme's
 * surfaces. Every seed is a fixed point of `readableAccent`, so the swatch the panel paints is
 * exactly the color the app applies. A hue tuned for charcoal rarely survives a white page, which
 * is why these are not one shared list.
 */
const ACCENT_PRESETS_BY_THEME = {
  dark: [
    { name: 'Classic orange', color: colors.clay.primary.default },
    { name: 'Reactor teal', color: colors.clay.accent.default },
    { name: 'Cobalt', color: '#629cf5' },
    { name: 'Violet', color: '#aa8cf4' },
    { name: 'Rose', color: '#e887a7' },
    { name: 'Amber', color: '#dba844' },
  ],
  light: [
    { name: 'Classic orange', color: colors['clay-light'].primary.default },
    { name: 'Reactor teal', color: colors['clay-light'].accent.default },
    { name: 'Cobalt', color: '#3c5f95' },
    { name: 'Violet', color: '#665492' },
    { name: 'Rose', color: '#874e61' },
    { name: 'Amber', color: '#765b25' },
  ],
} as const satisfies Record<AppearanceTheme, readonly { name: string; color: string }[]>;

export const accentPresets = (theme: AppearanceTheme): readonly { name: string; color: string }[] =>
  ACCENT_PRESETS_BY_THEME[theme];

export function rgb(hex: string): [number, number, number] {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error('Expected a six-digit hex color.');
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}
export const triplet = (hex: string): string => rgb(hex).join(' ');
const mix = (hex: string, target: string, amount: number) => {
  const other = rgb(target);
  return '#' + rgb(hex).map((part, index) => Math.round(part + (other[index] - part) * amount).toString(16).padStart(2, '0')).join('');
};
const luminance = (hex: string) => rgb(hex).map((part) => {
  const s = part / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}).reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index], 0);
export function contrastRatio(first: string, second: string): number {
  const [a, b] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** Keep the chosen hue, adjusting its tone only when text/icons would disappear on the surface. */
function readableAccent(seed: string, backgrounds: string[], light: boolean): string {
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(seed, light ? '#000000' : '#ffffff', step / 100);
    if (backgrounds.every((background) => contrastRatio(candidate, background) >= 4.5
      && contrastRatio(candidate, mix(background, candidate, 0.1)) >= 4.5)) return candidate;
  }
  return light ? '#000000' : '#ffffff';
}

/** Anything settings-shaped; missing fields fall back, so a preview can ask for one lightness. */
export type PaletteInput = Partial<AppearanceSettings>;

export function paletteFor(input: PaletteInput, now?: Date): ThemePalette {
  const settings = normalizeAppearance(input);
  const theme = resolveTheme(settings, now);
  const light = theme === 'light';
  const brand = colors[light ? 'clay-light' : 'clay'];
  const base = { ...themeDefinitionFor(settings)[theme].ui };
  if (settings.useThemeAccent) return base;
  const backgrounds = [base.surface, base.surface2, base.surface3, base.surface0, base.raised];
  const accent = readableAccent(settings.secondaryAccent, backgrounds, light);
  // The theme's own accent already has a hand-tuned emphasis tone; only derive one for other hues.
  const accentStrong = settings.secondaryAccent === brand.accent.default ? brand.accent.hover
    : readableAccent(mix(accent, light ? '#000000' : '#ffffff', 0.16), backgrounds, light);
  const onAccent = contrastRatio(accent, '#ffffff') > contrastRatio(accent, '#0f0f0f') ? '#ffffff' : '#0f0f0f';
  const onDanger = contrastRatio(base.danger, '#ffffff') > contrastRatio(base.danger, '#0f0f0f') ? '#ffffff' : '#0f0f0f';
  return { ...base, primary: accent, primaryStrong: accentStrong, onPrimary: onAccent, accent, accentStrong, onAccent, onDanger };
}

export function themeVariantFor(input: PaletteInput, now?: Date): ThemeVariant {
  const settings = normalizeAppearance(input);
  const variant = themeDefinitionFor(settings)[resolveTheme(settings, now)];
  const ui = paletteFor(settings, now);
  // The original accent setting also colors syntax structure and strings. Preset themes retain
  // their explicit syntax roles so importing a full theme remains lossless.
  const syntax = settings.themePreset === 'antimatter' && !settings.useThemeAccent
    ? { ...variant.syntax, keyword: ui.primary, type: ui.accentStrong, string: ui.accent } : variant.syntax;
  return { ...variant, ui, syntax };
}

/** One palette drives Displacer roles, Tailwind aliases and the standalone About/avatar windows. */
/**
 * The font half of the custom properties. Separate from the palette because it does not depend
 * on the theme or the clock: a face does not change at dusk.
 *
 * Sizes are emitted as px strings and the families as full stacks, so every consumer is a plain
 * `var()` with no arithmetic. `fontStack` has already refused any family name that could close
 * the declaration, which is what makes interpolating one here safe.
 */
export function fontVariables(fonts: FontSettings = DEFAULT_FONTS): Record<string, string> {
  const values: Record<string, string> = {};
  for (const role of FONT_ROLES) {
    values[`--font-${role}`] = fontStack(role, fonts[role].family);
    values[`--font-${role}-size`] = `${fonts[role].size}px`;
  }
  return values;
}

export function themeVariables(settings: PaletteInput, now?: Date): Record<string, string> {
  const p = paletteFor(settings, now);
  const aliases: Record<string, string> = {
    surface: p.surface, 'surface-2': p.surface2, 'surface-3': p.surface3, 'surface-0': p.surface0,
    line: p.line, 'line-soft': p.lineSoft, ink: p.ink, 'ink-2': p.ink2, 'ink-3': p.ink3,
    primary: p.primary, 'primary-strong': p.primaryStrong, 'on-primary': p.onPrimary,
    accent: p.accent, 'accent-strong': p.accentStrong, 'on-accent': p.onAccent,
    danger: p.danger, 'on-danger': p.onDanger, success: p.success, warning: p.warning, info: p.info,
  };
  const values: Record<string, string> = {
    '--ds-bg-page': p.surface, '--ds-bg-surface': p.surface2, '--ds-bg-surface-alt': p.surface3, '--ds-bg-raised': p.raised,
    '--ds-fg-default': p.ink, '--ds-fg-muted': p.ink2, '--ds-fg-subtle': p.ink3, '--ds-fg-inverse': p.surface0,
    '--ds-border': p.line, '--ds-border-muted': p.lineSoft, '--ds-border-focus': p.primary,
    '--ds-primary': p.primary, '--ds-primary-hover': p.primaryStrong, '--ds-accent': p.accent, '--ds-accent-hover': p.accentStrong,
    '--ds-success': p.success, '--ds-warning': p.warning, '--ds-error': p.danger, '--ds-info': p.info,
  };
  for (const [name, value] of Object.entries(aliases)) {
    values[`--color-${name}`] = triplet(value);
    values[`--${name}`] = triplet(value);
  }
  return values;
}
