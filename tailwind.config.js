import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const configDir = dirname(fileURLToPath(import.meta.url));
const withAlpha = (variable) => `rgb(var(${variable}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    join(configDir, 'renderer/src/index.html'),
    join(configDir, 'renderer/src/**/*.{js,ts,jsx,tsx}'),
  ],
  theme: {
    extend: {
      /*
        The configurable faces, so every existing `font-sans` / `font-mono` follows the setting
        without being touched. `font-chat` is the reading face and is applied where prose is
        rendered rather than globally -- the interface should not inherit it.

        var() fallbacks are spelled out because these utilities are also used by the standalone
        windows (about, avatar), which paint before the renderer sets any custom property.
      */
      fontFamily: {
        sans: 'var(--font-ui, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif)',
        chat: 'var(--font-chat, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif)',
        mono: 'var(--font-mono, ui-monospace, "JetBrains Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace)',
      },
      colors: {
        surface: {
          DEFAULT: withAlpha('--color-surface'),
          2: withAlpha('--color-surface-2'),
          3: withAlpha('--color-surface-3'),
          0: withAlpha('--color-surface-0'),
        },
        line: {
          DEFAULT: withAlpha('--color-line'),
          soft: withAlpha('--color-line-soft'),
        },
        ink: {
          DEFAULT: withAlpha('--color-ink'),
          2: withAlpha('--color-ink-2'),
          3: withAlpha('--color-ink-3'),
        },
        primary: {
          DEFAULT: withAlpha('--color-primary'),
          strong: withAlpha('--color-primary-strong'),
        },
        accent: {
          DEFAULT: withAlpha('--color-accent'),
          strong: withAlpha('--color-accent-strong'),
        },
        danger: withAlpha('--color-danger'),
        success: withAlpha('--color-success'),
        warning: withAlpha('--color-warning'),
        info: withAlpha('--color-info'),
        'on-primary': withAlpha('--color-on-primary'),
        'on-accent': withAlpha('--color-on-accent'),
        'on-danger': withAlpha('--color-on-danger'),
      },
    },
  },
  plugins: [],
};
