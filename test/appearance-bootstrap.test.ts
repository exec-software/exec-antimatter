import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { appearanceBootstrapCss } from '../src/preload/appearance';
import { themeVariables } from '../renderer/src/theme';

test('preload first-paint CSS uses the saved palette before renderer defaults arrive', () => {
  const settings = { theme: 'light' as const, secondaryAccent: '#aa88cc' };
  const css = appearanceBootstrapCss(settings);
  assert.ok(css.startsWith('html:root{'));
  assert.ok(css.endsWith('color-scheme:light;}'));
  for (const [name, value] of Object.entries(themeVariables(settings))) assert.ok(css.includes(`${name}:${value};`));
  assert.doesNotMatch(css, /!important|\bbody\b|background-color:|(?:^|[;{])background:/,
    'inline live colors must win and the avatar must stay transparent');
  assert.ok(css.length < 8192, 'the preload injects only a bounded role palette');
});

test('first-paint CSS cannot carry raw stored CSS or selector injection', () => {
  const injected = appearanceBootstrapCss({ theme: 'light;}body{display:none', secondaryAccent: '#33b7a6;}body{background:url(https://example.test)' });
  assert.ok(injected.endsWith('color-scheme:dark;}'));
  assert.doesNotMatch(injected, /body|display|https|url\(/);
  assert.equal(injected, appearanceBootstrapCss(null));
});

test('both app and avatar preloads install only author-origin fallback styling', () => {
  for (const name of ['index.ts', 'avatar.ts']) {
    const source = readFileSync(join(process.cwd(), 'src', 'preload', name), 'utf8');
    assert.match(source, /webFrame\.insertCSS\(appearanceBootstrapCss\(initialAppearance\), \{ cssOrigin: 'author' \}\)/);
    assert.ok(source.indexOf('insertCSS') < source.indexOf('exposeInMainWorld'));
  }
});
