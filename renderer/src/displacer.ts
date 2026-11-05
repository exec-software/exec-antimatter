import { DEFAULT_APPEARANCE, normalizeAppearance, resolveTheme, type AppearanceSettings } from '../../src/api/appearance';
import { fontVariables, themeVariables } from './theme';

/**
 * Bridges Displacer's default theme into the existing React/Tailwind shell.
 *
 * Components may use either the native `--ds-*` roles or Antimatter's historical
 * `--color-*` aliases; both now come from the library's one canonical token object.
 */
export function applyDisplacerTokens(input: AppearanceSettings = DEFAULT_APPEARANCE): void {
  const settings = normalizeAppearance(input);
  const now = new Date();
  const theme = resolveTheme(settings, now);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeVariables(settings, now))) root.style.setProperty(name, value);
  // Fonts ride the same apply, so a face change lands in one paint like a theme change does.
  for (const [name, value] of Object.entries(fontVariables(settings.fonts))) root.style.setProperty(name, value);
  root.style.colorScheme = theme;
  root.dataset.theme = theme;
  root.dataset.dsTheme = theme === 'light' ? 'clay-light' : 'clay';
  // Distinguishes "light because the clock says so" from "light because you chose it".
  root.dataset.themeSource = settings.autoTheme ? 'schedule' : 'manual';
}
