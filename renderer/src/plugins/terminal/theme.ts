import type { ITheme, Terminal } from '@xterm/xterm';
import { getAppearance, subscribeAppearance } from '../../appearance';
import { paletteFor, themeVariantFor } from '../../theme';

type Appearance = Parameters<typeof paletteFor>[0];

/** ANSI colours have separate light/dark contrast; surfaces and highlights share the app roles. */
export function terminalThemeFor(settings: Appearance): ITheme {
  const palette = paletteFor(settings);
  const ansi = themeVariantFor(settings).terminal;
  return {
    ...ansi,
    background: palette.surface0, foreground: palette.ink,
    cursor: palette.primary, cursorAccent: palette.surface0,
    selectionBackground: `${palette.accent}40`,
    selectionInactiveBackground: `${palette.accent}28`,
  };
}

interface AppearanceSource {
  read(): Appearance;
  subscribe(listener: (settings: Appearance) => void): () => void;
}

/** Setting xterm's theme repaints existing cells; never recreate the PTY, screen, or scrollback. */
export function followTerminalAppearance(
  terminal: Pick<Terminal, 'options'>,
  source: AppearanceSource = { read: getAppearance, subscribe: subscribeAppearance },
): () => void {
  terminal.options.theme = terminalThemeFor(source.read());
  return source.subscribe((settings) => { terminal.options.theme = terminalThemeFor(settings); });
}
