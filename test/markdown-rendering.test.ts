import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '../renderer/src/components/chat/MarkdownContent';

test('renders transcript prose as structured GFM instead of a pre-wrapped wall', () => {
  const content = [
    '## Result',
    '',
    'A **clear** answer with `inline()` code and [a link](https://example.com).',
    '',
    '- first',
    '- second',
    '',
    '| File | State |',
    '| --- | --- |',
    '| app.ts | done |',
  ].join('\n');
  const markup = renderToStaticMarkup(createElement(MarkdownContent, { content }));

  assert.match(markup, /<h2[^>]*>Result<\/h2>/);
  assert.match(markup, /<strong[^>]*>clear<\/strong>/);
  assert.match(markup, /<code[^>]*>inline\(\)<\/code>/);
  assert.match(markup, /<a[^>]*href="https:\/\/example\.com"[^>]*target="_blank"/);
  assert.match(markup, /<ul[^>]*>[\s\S]*<li[^>]*>first<\/li>/);
  assert.match(markup, /<table[^>]*>.*<th[^>]*>File<\/th>/);
});

test('raw HTML is not injected into a transcript', () => {
  const markup = renderToStaticMarkup(
    createElement(MarkdownContent, { content: '<script>danger()</script>\n\nSafe.' })
  );

  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /Safe\./);
});
