# Workspace themes

Open **Settings → Appearance** to choose Antimatter, Gruvbox, Solarized, GitHub, Monokai, or Emacs. Each palette supplies dark and light colors for the application, editor syntax, and terminal. Scheduled light/dark switching uses the selected palette. Font choices remain independent.

These are Antimatter adaptations, not official theme packages. The palette families are inspired by [Gruvbox](https://github.com/morhetz/gruvbox), [Solarized](https://ethanschoonover.com/solarized/), [GitHub's Primer colors](https://github.com/primer/primitives), the classic Monokai palette, and Emacs's default light and Wombat dark colors. No editor theme code is imported. Antimatter's default continues to use Displacer's Clay tokens.

**Use palette accents** preserves a theme's primary and secondary colors. Turn it off, or apply an accent swatch, to override those colors. Custom accents are adjusted for readable contrast against the palette's surfaces.

## Create or exchange a theme

Expand **Custom themes** and select **Edit a copy**. This produces a complete, editable JSON template from the active theme. **Validate and apply** checks the entire document before saving. **Export current theme** downloads a portable JSON file; **Import JSON** installs one. Invalid documents leave the current appearance unchanged.

The version 1 document contains exactly `version`, `id`, `name`, `dark`, and `light`. IDs use lowercase letters, digits, and hyphens (starting with a letter, up to 64 characters); names contain 1–80 readable characters. Both variants contain these objects:

| Object | Required color roles |
| --- | --- |
| `ui` | `surface`, `surface2`, `surface3`, `surface0`, `raised`, `line`, `lineSoft`, `ink`, `ink2`, `ink3`, `primary`, `primaryStrong`, `onPrimary`, `accent`, `accentStrong`, `onAccent`, `danger`, `onDanger`, `success`, `warning`, `info` |
| `syntax` | `keyword`, `operator`, `type`, `function`, `variable`, `string`, `number`, `comment`, `punctuation`, `invalid` |
| `terminal` | `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, and their `brightBlack`–`brightWhite` counterparts |

Colors must be six-digit hex strings such as `#282828`. Imports are limited to 24 KB. Unknown fields and versions, CSS expressions, executable hooks, and external resource URLs are rejected. Future schema versions can add new roles without interpreting old files differently. The schema and validator live in `src/api/themes.ts`.

Theme updates repaint existing editors and terminals without replacing their text, undo history, running commands, or scrollback. Custom themes control their own contrast; check both variants before sharing.
