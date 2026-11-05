import type { ITheme, Terminal } from '@xterm/xterm';
import { getAppearance, subscribeAppearance } from '../../appearance';
import { paletteFor } from '../../theme';

type Appearance = Parameters<typeof paletteFor>[0];

/** ANSI colours have separate light/dark contrast; surfaces and highlights share the app roles. */
export function terminalThemeFor(settings: Appearance): ITheme {
  const palette = paletteFor(settings);
  const ansi = settings.theme === 'dark' ? {
    black: '#141414', red: '#e05252', green: '#33b7a6', yellow: '#e0a23c', blue: '#5a9fd4', magenta: '#c678dd', cyan: '#4fd1bf', white: '#9c9893',
    brightBlack: '#6e6a65', brightRed: '#ff6b6b', brightGreen: '#4fd1bf', brightYellow: '#ffc857', brightBlue: '#7ab8e8', brightMagenta: '#d99ae8', brightCyan: '#7fe3d6', brightWhite: '#ece9e5',
  } : {
    black: '#262320', red: '#a32626', green: '#176e3c', yellow: '#805900', blue: '#245a8a', magenta: '#794299', cyan: '#08736a', white: '#635b53',
    brightBlack: '#70675e', brightRed: '#b02f2f', brightGreen: '#177346', brightYellow: '#8a5c00', brightBlue: '#246699', brightMagenta: '#8a4298', brightCyan: '#087970', brightWhite: '#37312c',
  };
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
