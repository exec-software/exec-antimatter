/**
 * Font configuration, split the way JetBrains splits it: the interface is one choice, the text
 * you read is another, and code is a third.
 *
 * Three roles rather than one, because they fail differently. A display face on the interface is
 * a style decision; the same face on code is a bug — ambiguous `l1I` and `0O` in a diff, and no
 * fixed advance to align on. Keeping `mono` separate means the interface can be anything at all
 * without taking code blocks and the terminal with it.
 *
 * A family name chosen here ends up inside a CSS custom property, so it is validated as a
 * *value*, not merely as a string: anything that could close the declaration and start another
 * is refused rather than escaped. See `isFamilyName`.
 */

export type FontRole = 'ui' | 'chat' | 'mono';

export const FONT_ROLES: readonly FontRole[] = Object.freeze(['ui', 'chat', 'mono']);

/** The sentinel for "whatever this machine would use", which is not a family name at all. */
export const SYSTEM_FAMILY = '';

export interface FontChoice {
  /** A family name, or `SYSTEM_FAMILY` for the platform default. */
  family: string;
  /** Pixels. */
  size: number;
}

export type FontSettings = Record<FontRole, FontChoice>;

/** Pixel bounds. Below 9 the interface stops being clickable; above 28 it stops fitting. */
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 28;

export const DEFAULT_FONTS: Readonly<FontSettings> = Object.freeze({
  ui: Object.freeze({ family: SYSTEM_FAMILY, size: 13 }),
  chat: Object.freeze({ family: SYSTEM_FAMILY, size: 15 }),
  mono: Object.freeze({ family: SYSTEM_FAMILY, size: 13 }),
}) as Readonly<FontSettings>;

export interface BundledFont {
  family: string;
  label: string;
  /** What it is for, so the picker does not offer a stencil face for code. */
  roles: readonly FontRole[];
  note: string;
}

/**
 * Fonts shipped in the application, so neither choice depends on what a machine happens to have
 * installed. Both are redistributable; see renderer/src/assets/fonts/README.md for the terms.
 */
export const BUNDLED_FONTS: readonly BundledFont[] = Object.freeze([
  Object.freeze({
    family: 'C64 Keyboard',
    label: 'C64 Keyboard',
    roles: Object.freeze(['ui', 'chat', 'mono'] as FontRole[]),
    note: 'Full ASCII and Latin-1. No Cyrillic or CJK — those fall back.',
  }),
  Object.freeze({
    family: 'USSR Stencil',
    label: 'USSR Stencil',
    roles: Object.freeze(['ui'] as FontRole[]),
    note: 'The wordmark face. A stencil, so it is poor at paragraph length.',
  }),
]) as readonly BundledFont[];

/**
 * A CSS `font-family` name, conservatively.
 *
 * The CSS grammar would allow more, and escaping could carry more still, but this value is
 * interpolated into a custom property and the only safe answer to "could this terminate the
 * declaration" is for the character never to arrive. Letters, digits, spaces and `-_.+` cover
 * every real family name ("DejaVu Sans Mono", "Noto Sans CJK JP", "IBM Plex Sans Condensed").
 * Quotes, semicolons, braces, parentheses, backslashes, angle brackets and controls do not.
 */
export function isFamilyName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value === SYSTEM_FAMILY) return true;
  if (value.length > 64) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9 \-_.+]*$/.test(value)) return false;
  // A name that is only separators is not a name, and double spaces are a sign of a mangled one.
  return value.trim() === value && !value.includes('  ');
}

const isSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= MIN_FONT_SIZE && value <= MAX_FONT_SIZE;

/** Per-role fallbacks, appended after the chosen family so a missing glyph still renders. */
const FALLBACKS: Record<FontRole, string> = {
  ui: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  chat: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: 'ui-monospace, "JetBrains Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace',
};

/**
 * The `font-family` value for a role. The chosen family is quoted — safe because `isFamilyName`
 * has already refused any name containing a quote or backslash — and the role's fallbacks follow
 * it, so an interface in a 7 KB pixel font still has something to draw a Cyrillic name with.
 */
export function fontStack(role: FontRole, family: string): string {
  if (!isFamilyName(family) || family === SYSTEM_FAMILY) return FALLBACKS[role];
  return `"${family}", ${FALLBACKS[role]}`;
}

/** Disk and preload fallback: anything unrecognised degrades to the default, never throws. */
export function normalizeFonts(value: unknown): FontSettings {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const out = {} as FontSettings;
  for (const role of FONT_ROLES) {
    const entry = input[role];
    const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    out[role] = {
      family: isFamilyName(record.family) ? record.family : DEFAULT_FONTS[role].family,
      size: isSize(record.size) ? record.size : DEFAULT_FONTS[role].size,
    };
  }
  return out;
}

/**
 * A patch from the renderer. Unlike `normalizeFonts` this refuses bad input rather than
 * smoothing it over, so a rejected family is reported instead of silently becoming the default.
 */
export function validateFontsPatch(value: unknown): FontSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Font settings must be an object.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !(FONT_ROLES as readonly string[]).includes(key))) {
    throw new Error('Fonts are configured for the interface, chat and code only.');
  }
  const out = {} as FontSettings;
  for (const role of FONT_ROLES) {
    const entry = Object.hasOwn(input, role) ? input[role] : DEFAULT_FONTS[role];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Each font needs a family and a size.');
    const record = entry as Record<string, unknown>;
    if (!isFamilyName(record.family)) {
      throw new Error('A font family may contain letters, digits, spaces and - _ . + only.');
    }
    if (!isSize(record.size)) {
      throw new Error(`A font size must be a whole number of pixels between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}.`);
    }
    out[role] = { family: record.family, size: record.size };
  }
  return out;
}

export interface SystemFontFamily {
  family: string;
  /** True where fontconfig reports a fixed advance, so the code picker can lead with them. */
  monospace: boolean;
}

export interface SystemFontsAPI {
  /** Installed families, or an empty list where they cannot be enumerated. */
  list(): Promise<SystemFontFamily[]>;
}

/**
 * Value equality. Needed because `FontSettings` is the first nested object in
 * `AppearanceSettings`, and the identity comparison that served the flat scalars would report
 * "changed" on every read — writing the store on every no-op update.
 */
export function fontsEqual(a: FontSettings, b: FontSettings): boolean {
  return FONT_ROLES.every((role) => a[role].family === b[role].family && a[role].size === b[role].size);
}
