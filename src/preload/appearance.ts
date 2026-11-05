import { normalizeAppearance, resolveTheme } from '../api/appearance';
import { themeVariables } from '../../renderer/src/theme';

/**
 * An author-origin first-paint fallback, inserted before the renderer module or its CSS arrives.
 * `html:root` beats the stylesheet's default `:root`; live inline root styles still win. Only
 * variables and color-scheme are set, preserving the companion window's transparent background.
 */
export function appearanceBootstrapCss(value: unknown): string {
  const settings = normalizeAppearance(value);
  const now = new Date();
  const declarations = Object.entries(themeVariables(settings, now)).map(([name, color]) => `${name}:${color};`).join('');
  return `html:root{${declarations}color-scheme:${resolveTheme(settings, now)};}`;
}
