import { HighlightStyle, LanguageSupport, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { cpp } from '@codemirror/lang-cpp';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { ny } from './nyLanguage';
import { matrix } from './matrixLanguage';
import { normalizeAppearance, resolveTheme } from '../../../src/api/appearance';
import { paletteFor, themeVariantFor } from '../theme';

/**
 * The editor in Clay.
 *
 * Written against the same palette as the rest of the app rather than imported from a theme
 * package, because an editor that does not match the window it is in reads as an embedded
 * foreign thing — which is exactly what it must not feel like here.
 *
 * The shared palette also configures CodeMirror's dark-mode facet and syntax colours. Replacing
 * this extension in a Compartment updates open files without rebuilding their editor state.
 */
type Appearance = Parameters<typeof paletteFor>[0];

const MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export function editorThemeFor(settings: Appearance) {
  const { ink: INK, ink2: INK_2, ink3: INK_3, surface: SURFACE, surface2: SURFACE_2,
    surface3: SURFACE_3, line: LINE, primary: PRIMARY, accent: ACCENT, danger: DANGER,
    warning: AMBER } = paletteFor(settings);
  return EditorView.theme(
  {
    '&': { color: INK, backgroundColor: SURFACE, height: '100%', fontSize: '13px' },
    '.cm-content': { fontFamily: MONO, padding: '8px 0', caretColor: PRIMARY },
    '.cm-scroller': { fontFamily: MONO, lineHeight: '1.55' },
    '&.cm-focused': { outline: 'none' },

    '.cm-cursor, .cm-dropCursor': { borderLeftColor: PRIMARY, borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: `${PRIMARY}38`,
    },
    '.cm-selectionMatch': { backgroundColor: `${ACCENT}2e` },
    '.cm-activeLine': { backgroundColor: SURFACE_2 },

    '.cm-gutters': {
      backgroundColor: SURFACE_2,
      color: INK_3,
      border: 'none',
      borderRight: `1px solid ${LINE}`,
      fontFamily: MONO,
    },
    '.cm-activeLineGutter': { backgroundColor: SURFACE_3, color: INK_2 },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 10px', minWidth: '32px' },

    // The breakpoint column: narrow, and clickable across its whole height.
    '.cm-breakpoint-gutter': { width: '16px', cursor: 'pointer' },
    '.cm-breakpoint-gutter .cm-gutterElement': { paddingLeft: '4px' },
    '.cm-breakpoint-dot': { color: DANGER, fontSize: '11px', lineHeight: '1.55' },
    '.cm-breakpoint-hover': { color: `${DANGER}59`, fontSize: '11px', lineHeight: '1.55' },

    // Where execution is stopped. Loud on purpose: it is the one line that matters.
    '.cm-paused-line': { backgroundColor: `${PRIMARY}29`, boxShadow: `inset 3px 0 0 ${PRIMARY}` },
    '.cm-revealed-line': { animation: 'cm-reveal-flash 1.2s ease-out' },

    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: `${ACCENT}38`,
      color: 'inherit',
      outline: 'none',
    },
    '.cm-nonmatchingBracket': { color: DANGER },

    '.cm-tooltip': {
      backgroundColor: SURFACE_3,
      border: `1px solid ${LINE}`,
      borderRadius: '6px',
      color: INK,
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: `${PRIMARY}2e`, color: INK },
    '.cm-panels': { backgroundColor: SURFACE_2, color: INK, borderTop: `1px solid ${LINE}` },
    '.cm-searchMatch': { backgroundColor: `${AMBER}47` },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: `${PRIMARY}66` },
    '.cm-foldPlaceholder': { backgroundColor: SURFACE_3, border: `1px solid ${LINE}`, color: INK_2 },
  },
  { dark: resolveTheme(normalizeAppearance(settings)) === 'dark' }
  );
}

/**
 * The shared accent carries structure and values; neutral roles keep punctuation and comments
 * in the background. Syntax categories retain distinct hues where that helps reading code.
 */
export function editorHighlightFor(settings: Appearance) {
  const { syntax: s } = themeVariantFor(settings);
  return HighlightStyle.define([
  { tag: [tags.keyword, tags.moduleKeyword, tags.controlKeyword], color: s.keyword },
  { tag: [tags.operatorKeyword, tags.modifier, tags.self, tags.null, tags.atom], color: s.operator },
  { tag: [tags.definitionKeyword, tags.typeName, tags.namespace], color: s.type },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: s.function },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], color: s.variable },
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: s.variable },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: s.string },
  { tag: [tags.number, tags.bool, tags.unit], color: s.number },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: s.comment, fontStyle: 'italic' },
  { tag: [tags.className], color: s.type },
  { tag: [tags.tagName], color: s.keyword },
  { tag: [tags.meta, tags.annotation], color: s.punctuation },
  { tag: [tags.punctuation, tags.bracket, tags.separator], color: s.punctuation },
  { tag: [tags.invalid], color: s.invalid, textDecoration: 'underline wavy' },
  { tag: [tags.heading], color: s.keyword, fontWeight: 'bold' },
  { tag: [tags.link, tags.url], color: s.string, textDecoration: 'underline' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.strong], fontWeight: 'bold' },
  { tag: [tags.strikethrough], textDecoration: 'line-through' },
  ]);
}

export const editorAppearanceFor = (settings: Appearance) => [editorThemeFor(settings), syntaxHighlighting(editorHighlightFor(settings))];

/**
 * The parser for a file, by extension. A file we have no grammar for still opens — it is edited
 * as plain text, which is better than refusing it.
 */
export function languageFor(path: string): LanguageSupport | null {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  switch (extension) {
    case '.ny':
      return ny();
    case '.matrix':
    case '.mat':
      return matrix();
    case '.js':
    case '.mjs':
    case '.cjs':
      return javascript();
    case '.jsx':
      return javascript({ jsx: true });
    case '.ts':
    case '.mts':
    case '.cts':
      return javascript({ typescript: true });
    case '.tsx':
      return javascript({ jsx: true, typescript: true });
    case '.py':
    case '.pyi':
      return python();
    case '.json':
    case '.jsonc':
      return json();
    case '.md':
    case '.markdown':
      return markdown();
    case '.html':
    case '.htm':
    case '.vue':
      return html();
    case '.css':
    case '.scss':
    case '.less':
      return css();
    case '.rs':
      return rust();
    case '.c':
    case '.h':
    case '.cc':
    case '.cpp':
    case '.hpp':
      return cpp();
    default:
      return null;
  }
}

/** A short label for the status bar, including for the files we have no grammar for. */
export function languageName(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const names: Record<string, string> = {
    js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JSX',
    ts: 'TypeScript', tsx: 'TSX', py: 'Python', json: 'JSON', md: 'Markdown',
    html: 'HTML', css: 'CSS', scss: 'SCSS', rs: 'Rust', c: 'C', h: 'C', cpp: 'C++',
    hpp: 'C++', sh: 'Shell', yaml: 'YAML', yml: 'YAML', toml: 'TOML', sql: 'SQL',
    go: 'Go', rb: 'Ruby', php: 'PHP', lua: 'Lua', txt: 'Text', ny: 'Ny', matrix: 'Matrix', mat: 'Matrix', nil: 'NIL',
  };
  return names[extension] ?? (extension && !path.slice(1).includes('.') ? 'Text' : extension.toUpperCase() || 'Text');
}
