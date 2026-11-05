import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  BUNDLED_FONTS,
  DEFAULT_FONTS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  SYSTEM_FAMILY,
  fontStack,
  isFamilyName,
  normalizeFonts,
  validateFontsPatch,
} from '../src/api/fonts';
import { normalizeAppearance, validateAppearancePatch } from '../src/api/appearance';
import { parseFcList } from '../src/main/systemFonts';

test('real family names are accepted', () => {
  for (const name of ['Inter', 'DejaVu Sans Mono', 'C64 Keyboard', 'Noto Sans CJK JP',
    'IBM Plex Sans Condensed', 'SF Mono', 'Fira Code', 'Source Code Pro', 'Cascadia Mono PL',
    'Helvetica-Bold', 'Roboto_Slab', 'Font.Awesome', 'Segoe UI Symbol', 'M+ 1c']) {
    assert.equal(isFamilyName(name), true, `${name} should be a valid family`);
  }
  assert.equal(isFamilyName(SYSTEM_FAMILY), true, 'the system sentinel is valid');
});

/**
 * The whole reason this validator exists. A family name is interpolated into a CSS custom
 * property, so anything that could end the declaration must never be stored in the first place.
 */
test('a family name that could escape the CSS declaration is refused', () => {
  for (const attack of [
    'Inter"; } body { display: none } .x {',
    'Inter; color: red',
    'Inter} body{display:none',
    'Inter\\"',
    "Inter'",
    'Inter)',
    'url(evil.woff2)',
    'Inter/*comment*/',
    'Inter<script>',
    'Inter\nbody{}',
    'Inter\u0000',
    'Inter\t',
    'var(--x)',
    '-moz-fixed',          // leading punctuation
    ' Inter',              // untrimmed
    'Inter ',
    'Inter  Bold',         // doubled space, a sign of a mangled name
    'A'.repeat(65),        // over length
  ]) {
    assert.equal(isFamilyName(attack), false, `${JSON.stringify(attack)} must be refused`);
  }
  assert.equal(isFamilyName(42), false);
  assert.equal(isFamilyName(null), false);
  assert.equal(isFamilyName({}), false);
});

test('a stack quotes the chosen family and always keeps a fallback', () => {
  const ui = fontStack('ui', 'C64 Keyboard');
  assert.ok(ui.startsWith('"C64 Keyboard",'), ui);
  assert.ok(ui.includes('sans-serif'), 'a missing glyph must still have somewhere to go');
  const mono = fontStack('mono', 'Fira Code');
  assert.ok(mono.startsWith('"Fira Code",'), mono);
  assert.ok(mono.includes('monospace'), mono);
  // The system sentinel contributes no family of its own, only the role's fallbacks — which do
  // legitimately contain a quoted name of their own ("Segoe UI"), so the check is that nothing
  // was prepended rather than that no quote appears anywhere.
  assert.equal(fontStack('ui', SYSTEM_FAMILY).startsWith('ui-sans-serif'), true);
  // A refused name must not reach the stylesheet even if it somehow got this far.
  assert.equal(fontStack('ui', 'Inter; }'), fontStack('ui', SYSTEM_FAMILY));
});

test('normalizing is lenient and never throws', () => {
  assert.deepEqual(normalizeFonts(undefined), DEFAULT_FONTS);
  assert.deepEqual(normalizeFonts('nonsense'), DEFAULT_FONTS);
  assert.deepEqual(normalizeFonts({ ui: { family: 'Inter; }', size: 9000 } }).ui, DEFAULT_FONTS.ui);
  // A good field beside a bad one survives.
  const mixed = normalizeFonts({ chat: { family: 'Inter', size: 999 } });
  assert.equal(mixed.chat.family, 'Inter');
  assert.equal(mixed.chat.size, DEFAULT_FONTS.chat.size);
});

test('a patch reports a bad value rather than quietly defaulting it', () => {
  const good = { ui: { family: 'Inter', size: 14 }, chat: { family: '', size: 16 }, mono: { family: 'Fira Code', size: 12 } };
  assert.deepEqual(validateFontsPatch(good), good);
  assert.throws(() => validateFontsPatch({ ui: { family: 'Inter; }', size: 14 } }), /letters, digits/);
  assert.throws(() => validateFontsPatch({ ui: { family: 'Inter', size: MIN_FONT_SIZE - 1 } }), /between/);
  assert.throws(() => validateFontsPatch({ ui: { family: 'Inter', size: MAX_FONT_SIZE + 1 } }), /between/);
  assert.throws(() => validateFontsPatch({ ui: { family: 'Inter', size: 13.5 } }), /whole number/);
  assert.throws(() => validateFontsPatch({ sidebar: { family: 'Inter', size: 13 } }), /interface, chat and code/);
  assert.throws(() => validateFontsPatch(null), /must be an object/);
  // An omitted role falls back to its default rather than being left undefined.
  assert.deepEqual(validateFontsPatch({ ui: { family: 'Inter', size: 14 } }).mono, DEFAULT_FONTS.mono);
});

test('appearance carries fonts through both the lenient and the strict path', () => {
  assert.deepEqual(normalizeAppearance({}).fonts, DEFAULT_FONTS);
  // A corrupt fonts blob on disk must not take the rest of appearance down with it.
  const recovered = normalizeAppearance({ theme: 'light', fonts: 'garbage' });
  assert.equal(recovered.theme, 'light');
  assert.deepEqual(recovered.fonts, DEFAULT_FONTS);

  const patch = validateAppearancePatch({ fonts: { ui: { family: 'C64 Keyboard', size: 13 }, chat: { family: '', size: 15 }, mono: { family: '', size: 13 } } });
  assert.equal(patch.fonts?.ui.family, 'C64 Keyboard');
  assert.throws(() => validateAppearancePatch({ fonts: { ui: { family: 'x"; }', size: 13 } } }), /letters, digits/);
});

test('every bundled font is a name the validator accepts, and declares its roles', () => {
  assert.ok(BUNDLED_FONTS.length > 0);
  for (const font of BUNDLED_FONTS) {
    assert.equal(isFamilyName(font.family), true, `${font.family} must be storable`);
    assert.ok(font.roles.length > 0, `${font.family} must be offered for something`);
    assert.ok(font.note.length > 0, `${font.family} should say what it is`);
  }
  // The stencil is a display face; offering it for code would be a bug, not a preference.
  assert.deepEqual(BUNDLED_FONTS.find((f) => f.family === 'USSR Stencil')?.roles, ['ui']);
});

test('fc-list output is deduplicated, sorted, and stripped of unusable names', () => {
  const families = parseFcList([
    'DejaVu Sans',
    'DejaVu Sans',                       // repeated, as fc-list does per style
    'Noto Sans CJK JP,Noto Sans CJK JP', // aliases: only the first is taken
    'Cantarell',
    'Bad"Name',                          // would break the CSS declaration
    '',                                  // blank line
    'DejaVu Sans Mono',
  ].join('\n'), new Set(['DejaVu Sans Mono']));

  assert.deepEqual(families.map((f) => f.family),
    ['Cantarell', 'DejaVu Sans', 'DejaVu Sans Mono', 'Noto Sans CJK JP']);
  assert.equal(families.find((f) => f.family === 'DejaVu Sans Mono')?.monospace, true);
  assert.equal(families.find((f) => f.family === 'Cantarell')?.monospace, false);
  assert.equal(families.some((f) => f.family.includes('"')), false, 'an unusable name must be dropped');
});
