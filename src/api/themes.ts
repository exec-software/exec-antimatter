import { colors } from '../../vendor/displacer/tokens/index.js';

export const UI_THEME_KEYS = ['surface', 'surface2', 'surface3', 'surface0', 'raised', 'line', 'lineSoft', 'ink', 'ink2', 'ink3', 'primary', 'primaryStrong', 'onPrimary', 'accent', 'accentStrong', 'onAccent', 'danger', 'onDanger', 'success', 'warning', 'info'] as const;
export const SYNTAX_THEME_KEYS = ['keyword', 'operator', 'type', 'function', 'variable', 'string', 'number', 'comment', 'punctuation', 'invalid'] as const;
export const TERMINAL_THEME_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
export type ThemePalette = Record<typeof UI_THEME_KEYS[number], string>;
export interface ThemeVariant {
  ui: ThemePalette;
  syntax: Record<typeof SYNTAX_THEME_KEYS[number], string>;
  terminal: Record<typeof TERMINAL_THEME_KEYS[number], string>;
}
/** Versioned, portable data only: no CSS expressions, executable hooks, URLs, or local paths. */
export interface ThemeDefinition {
  version: 1;
  id: string;
  name: string;
  dark: ThemeVariant;
  light: ThemeVariant;
}
export const THEME_PRESET_IDS = ['antimatter', 'gruvbox', 'solarized', 'github', 'monokai', 'emacs'] as const;
export type ThemePresetId = typeof THEME_PRESET_IDS[number];

function clay(mode: 'dark' | 'light'): ThemeVariant {
  const t = colors[mode === 'dark' ? 'clay' : 'clay-light'];
  const dark = mode === 'dark';
  const ansi = dark
    ? ['141414', 'e05252', '33b7a6', 'e0a23c', '5a9fd4', 'c678dd', '4fd1bf', '9c9893', '6e6a65', 'ff6b6b', '4fd1bf', 'ffc857', '7ab8e8', 'd99ae8', '7fe3d6', 'ece9e5']
    : ['262320', 'a32626', '176e3c', '805900', '245a8a', '794299', '08736a', '635b53', '70675e', 'b02f2f', '177346', '8a5c00', '246699', '8a4298', '087970', '37312c'];
  const ui = {
    surface: t.bg.page, surface2: t.bg.surface, surface3: t.bg['surface-alt'], surface0: t.fg.inverse, raised: t.bg.raised,
    line: t.border.default, lineSoft: t.border.muted, ink: t.fg.default, ink2: t.fg.muted, ink3: t.fg.subtle,
    primary: t.primary.default, primaryStrong: t.primary.hover, onPrimary: dark ? '#141414' : '#ffffff',
    accent: t.accent.default, accentStrong: t.accent.hover, onAccent: dark ? '#141414' : '#ffffff',
    danger: t.semantic.error, onDanger: dark ? '#141414' : '#ffffff', success: t.semantic.success, warning: t.semantic.warning, info: t.semantic.info,
  };
  return { ui, syntax: { keyword: ui.primary, operator: dark ? '#ff8b4d' : '#a34112', type: ui.accentStrong, function: dark ? '#7ab8e8' : '#245a8a', variable: ui.ink, string: ui.accent, number: ui.warning, comment: ui.ink3, punctuation: ui.ink2, invalid: ui.danger }, terminal: Object.fromEntries(TERMINAL_THEME_KEYS.map((key, i) => [key, `#${ansi[i]}`])) as ThemeVariant['terminal'] };
}

// These are Antimatter adaptations of the familiar editor palettes, not imported editor themes.
function variant(mode: 'dark' | 'light', base: string[], hues: string[]): ThemeVariant {
  const [surface, surface2, surface3, surface0, raised, line, ink, ink2, ink3] = base.map((v) => `#${v}`);
  const [red, green, yellow, blue, magenta, cyan] = hues.map((v) => `#${v}`);
  const on = mode === 'dark' ? '#101010' : '#ffffff';
  const ui: ThemePalette = { surface, surface2, surface3, surface0, raised, line, lineSoft: line, ink, ink2, ink3,
    primary: blue, primaryStrong: cyan, onPrimary: on, accent: green, accentStrong: cyan, onAccent: on,
    danger: red, onDanger: on, success: green, warning: yellow, info: blue };
  const ansi = [surface0, red, green, yellow, blue, magenta, cyan, ink2, ink3, red, green, yellow, blue, magenta, cyan, ink];
  return { ui, syntax: { keyword: magenta, operator: red, type: yellow, function: blue, variable: ink, string: green, number: cyan, comment: ink3, punctuation: ink2, invalid: red }, terminal: Object.fromEntries(TERMINAL_THEME_KEYS.map((key, i) => [key, ansi[i]])) as ThemeVariant['terminal'] };
}

const definition = (id: ThemePresetId, name: string, dark: ThemeVariant, light: ThemeVariant): ThemeDefinition => ({ version: 1, id, name, dark, light });
export const THEME_PRESETS: readonly ThemeDefinition[] = [
  definition('antimatter', 'Antimatter', clay('dark'), clay('light')),
  definition('gruvbox', 'Gruvbox',
    variant('dark', ['282828', '1d2021', '32302f', '1d2021', '3c3836', '665c54', 'ebdbb2', 'd5c4a1', 'a89984'], ['fb4934', 'b8bb26', 'fabd2f', '83a598', 'd3869b', '8ec07c']),
    variant('light', ['fbf1c7', 'f2e5bc', 'ebdbb2', 'fff8dc', 'f9edc3', 'bdae93', '3c3836', '504945', '7c6f64'], ['9d0006', '667300', '8f5b00', '076678', '8f3f71', '427b58'])),
  definition('solarized', 'Solarized',
    variant('dark', ['002b36', '00212b', '073642', '001e27', '073642', '31515a', '93a1a1', '839496', '748b91'], ['ff756e', 'a2ad00', 'd5a400', '55a9e8', 'd28bd2', '3fc6bb']),
    variant('light', ['fdf6e3', 'eee8d5', 'e6dfcc', 'fffbef', 'f6efdc', 'c3c8b8', '073642', '4f6268', '657b83'], ['c52928', '677800', '8c6b00', '206fa2', '95519d', '167e78'])),
  definition('github', 'GitHub',
    variant('dark', ['0d1117', '010409', '161b22', '010409', '21262d', '30363d', 'e6edf3', 'b1bac4', '8b949e'], ['ff7b72', '7ee787', 'e3b341', '79c0ff', 'd2a8ff', 'a5d6ff']),
    variant('light', ['ffffff', 'f6f8fa', 'eaeef2', 'ffffff', 'ffffff', 'd0d7de', '1f2328', '424a53', '57606a'], ['cf222e', '116329', '7d4e00', '0550ae', '8250df', '09696d'])),
  definition('monokai', 'Monokai',
    variant('dark', ['272822', '1e1f1c', '34352f', '1e1f1c', '3e3d32', '555648', 'f8f8f2', 'd6d6c9', 'a6a692'], ['ff6188', 'a9dc76', 'ffd866', '78dce8', 'ab9df2', '78dce8']),
    variant('light', ['faf9f5', 'f0eee6', 'e7e5db', 'ffffff', 'f5f3ed', 'cbc8ba', '272822', '4d4f44', '6c6d60'], ['b8184c', '436915', '806000', '166f7c', '6940a8', '126f6a'])),
  definition('emacs', 'Emacs',
    variant('dark', ['242424', '1b1b1b', '303030', '171717', '363636', '555555', 'f6f3e8', 'd4d0c8', 'a0a0a0'], ['e5786d', '95e454', 'e9c062', '8ac6f2', 'ca9bd8', '93e0e3']),
    variant('light', ['ffffff', 'f2f2f2', 'e5e5e5', 'ffffff', 'f8f8f8', 'b8b8b8', '202020', '404040', '656565'], ['b22222', '006400', '865900', '0000cd', 'a020a0', '006e80'])),
];

function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be an object.`);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(input, key))) throw new Error(`${label} requires exactly: ${keys.join(', ')}.`);
  return input;
}
function colorRoles<K extends string>(value: unknown, keys: readonly K[], label: string): Record<K, string> {
  const input = object(value, keys, label);
  return Object.fromEntries(keys.map((key) => {
    if (typeof input[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(input[key] as string)) throw new Error(`${label}.${key} must be a six-digit hex color.`);
    return [key, (input[key] as string).toLowerCase()];
  })) as Record<K, string>;
}
export function validateThemeDefinition(value: unknown): ThemeDefinition {
  const input = object(value, ['version', 'id', 'name', 'dark', 'light'], 'Theme');
  if (input.version !== 1) throw new Error('Unsupported theme version. Use version 1.');
  if (typeof input.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.id)) throw new Error('Theme id must use lowercase letters, numbers, and hyphens.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\u0000-\u001f\u007f]/.test(input.name)) throw new Error('Theme name must be 1–80 readable characters.');
  const readVariant = (key: 'dark' | 'light'): ThemeVariant => {
    const part = object(input[key], ['ui', 'syntax', 'terminal'], key);
    return { ui: colorRoles(part.ui, UI_THEME_KEYS, `${key}.ui`), syntax: colorRoles(part.syntax, SYNTAX_THEME_KEYS, `${key}.syntax`), terminal: colorRoles(part.terminal, TERMINAL_THEME_KEYS, `${key}.terminal`) };
  };
  return { version: 1, id: input.id, name: input.name.trim(), dark: readVariant('dark'), light: readVariant('light') };
}
export function themeDefinitionFor(settings: { themePreset?: string; customTheme?: ThemeDefinition | null }): ThemeDefinition {
  return settings.themePreset === 'custom' && settings.customTheme ? settings.customTheme
    : THEME_PRESETS.find((theme) => theme.id === settings.themePreset) ?? THEME_PRESETS[0];
}
