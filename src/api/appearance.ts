import {
  DEFAULT_FONTS,
  fontsEqual,
  normalizeFonts,
  validateFontsPatch,
  type FontSettings,
} from './fonts';

export type AppearanceTheme = 'dark' | 'light';

export interface AppearanceSettings {
  /** The explicit choice, and the fallback whenever the schedule cannot decide. */
  theme: AppearanceTheme;
  secondaryAccent: string;
  /** When set, the clock picks the theme and `theme` records the last manual choice. */
  autoTheme: boolean;
  /** Local wall-clock `HH:MM` boundaries. The light window runs from the first to the second. */
  autoLightFrom: string;
  autoDarkFrom: string;
  /**
   * Whether the prompt sits in the widget band.
   *
   * On, the composer keeps its row and the space either side of it becomes dockable -- a strip
   * that is dead weight on a laptop and acres of nothing on an ultrawide. Off, that row goes away
   * and the composer floats over the conversation instead.
   */
  promptDock: boolean;
  /**
   * Interface, chat and code faces, each a family and a size. Grouped rather than flattened into
   * six keys because they are one decision with three parts, and because the validation that
   * keeps a family name out of the CSS grammar lives with them in fonts.ts.
   */
  fonts: FontSettings;
}

export const DEFAULT_APPEARANCE: Readonly<AppearanceSettings> = Object.freeze({
  theme: 'dark',
  secondaryAccent: '#33b7a6',
  autoTheme: false,
  autoLightFrom: '07:00',
  autoDarkFrom: '19:00',
  promptDock: true,
  fonts: DEFAULT_FONTS,
});

export interface ReadonlyAppearanceAPI {
  /** Cached, synchronous preload snapshot, available before the renderer's first paint. */
  initial: AppearanceSettings;
  get(): Promise<AppearanceSettings>;
  onChanged(callback: (settings: AppearanceSettings) => void): () => void;
}

export interface AppearanceAPI extends ReadonlyAppearanceAPI {
  update(patch: Partial<AppearanceSettings>): Promise<AppearanceSettings>;
}

const isHex = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** A 24-hour local wall-clock time. Nothing wider is accepted from disk or from a patch. */
const isClockTime = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

const APPEARANCE_KEYS = ['theme', 'secondaryAccent', 'autoTheme', 'autoLightFrom', 'autoDarkFrom', 'promptDock', 'fonts'] as const;

export const minutesOfDay = (time: string): number => {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
};

/** Disk and preload fallback only. Updates use the strict validator below. */
export function normalizeAppearance(value: unknown): AppearanceSettings {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const autoLightFrom = isClockTime(input.autoLightFrom) ? input.autoLightFrom : DEFAULT_APPEARANCE.autoLightFrom;
  const autoDarkFrom = isClockTime(input.autoDarkFrom) ? input.autoDarkFrom : DEFAULT_APPEARANCE.autoDarkFrom;
  // Two identical boundaries describe no window at all; fall back rather than freeze on one theme.
  const usable = minutesOfDay(autoLightFrom) !== minutesOfDay(autoDarkFrom);
  return {
    theme: input.theme === 'light' ? 'light' : 'dark',
    secondaryAccent: isHex(input.secondaryAccent) ? input.secondaryAccent.toLowerCase() : DEFAULT_APPEARANCE.secondaryAccent,
    autoTheme: input.autoTheme === true && usable,
    autoLightFrom: usable ? autoLightFrom : DEFAULT_APPEARANCE.autoLightFrom,
    autoDarkFrom: usable ? autoDarkFrom : DEFAULT_APPEARANCE.autoDarkFrom,
    promptDock: input.promptDock === undefined ? DEFAULT_APPEARANCE.promptDock : input.promptDock !== false,
    fonts: normalizeFonts(input.fonts),
  };
}

/** Reject unsupported properties and CSS expressions instead of silently accepting a partial edit. */
export function validateAppearancePatch(value: unknown): Partial<AppearanceSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Appearance settings must be an object.');
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Appearance settings must be a plain object.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !(APPEARANCE_KEYS as readonly string[]).includes(key))) throw new Error('Unknown appearance setting.');
  const patch: Partial<AppearanceSettings> = {};
  if (Object.hasOwn(input, 'theme')) {
    if (input.theme !== 'dark' && input.theme !== 'light') throw new Error('Choose the dark or light theme.');
    patch.theme = input.theme;
  }
  if (Object.hasOwn(input, 'secondaryAccent')) {
    if (!isHex(input.secondaryAccent)) throw new Error('The accent must be a six-digit hex color.');
    patch.secondaryAccent = input.secondaryAccent.toLowerCase();
  }
  if (Object.hasOwn(input, 'autoTheme')) {
    if (typeof input.autoTheme !== 'boolean') throw new Error('Automatic switching is on or off.');
    patch.autoTheme = input.autoTheme;
  }
  if (Object.hasOwn(input, 'promptDock')) {
    if (typeof input.promptDock !== 'boolean') throw new Error('The widget band is on or off.');
    patch.promptDock = input.promptDock;
  }
  if (Object.hasOwn(input, 'fonts')) {
    // A partial font patch is not meaningful: the panel always sends all three roles, and
    // accepting one role alone would make "what is the other two" a question with no answer here.
    patch.fonts = validateFontsPatch(input.fonts);
  }
  for (const key of ['autoLightFrom', 'autoDarkFrom'] as const) {
    if (!Object.hasOwn(input, key)) continue;
    if (!isClockTime(input[key])) throw new Error('Use a 24-hour time between 00:00 and 23:59.');
    patch[key] = input[key] as string;
  }
  return patch;
}

/** The theme actually in force. Schedules are evaluated in the user's local wall-clock time. */
export function resolveTheme(settings: AppearanceSettings, now: Date = new Date()): AppearanceTheme {
  if (!settings.autoTheme) return settings.theme;
  const light = minutesOfDay(settings.autoLightFrom);
  const dark = minutesOfDay(settings.autoDarkFrom);
  if (light === dark) return settings.theme;
  const current = now.getHours() * 60 + now.getMinutes();
  // A light window that ends before it starts simply wraps past midnight.
  const inLight = light < dark ? current >= light && current < dark : current >= light || current < dark;
  return inLight ? 'light' : 'dark';
}

/**
 * The next instant the resolved theme changes, so the main process can sleep until exactly then
 * instead of polling. Null when no schedule is active.
 */
export function nextThemeBoundary(settings: AppearanceSettings, now: Date = new Date()): Date | null {
  if (!settings.autoTheme) return null;
  const light = minutesOfDay(settings.autoLightFrom);
  const dark = minutesOfDay(settings.autoDarkFrom);
  if (light === dark) return null;
  // Built from local calendar parts so a boundary stays at its wall-clock time across a DST shift.
  const at = (minutes: number, dayOffset: number): Date => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 0, 0, 0, 0);
    date.setMinutes(minutes);
    return date;
  };
  const upcoming = [at(light, 0), at(dark, 0), at(light, 1), at(dark, 1)]
    .filter((candidate) => candidate.getTime() > now.getTime())
    .sort((first, second) => first.getTime() - second.getTime());
  return upcoming[0] ?? null;
}

/**
 * Whether two settings describe the same appearance.
 *
 * Every field but `fonts` is a scalar, and comparing those by identity is correct. `fonts` is
 * not, so a blanket `===` over the keys would make any two normalizations unequal and turn every
 * no-op update into a disk write. Compared per key so adding the next nested field is a visible
 * decision rather than a silent regression.
 */
export function appearanceEquals(a: AppearanceSettings, b: AppearanceSettings): boolean {
  return (Object.keys(DEFAULT_APPEARANCE) as (keyof AppearanceSettings)[]).every((key) =>
    key === 'fonts' ? fontsEqual(a.fonts, b.fonts) : a[key] === b[key]);
}
