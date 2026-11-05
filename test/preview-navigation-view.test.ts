import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewGrid } from '../renderer/src/components/chat/PreviewGrid';
import { previewAddress, previewFailureAdvice } from '../renderer/src/lib/previewNavigation';

test('the preview address bar handles website and local development server addresses', () => {
  assert.equal(previewAddress(' localhost:5173 '), 'http://localhost:5173/');
  assert.equal(previewAddress('127.0.0.1:3000/hello?test=1'), 'http://127.0.0.1:3000/hello?test=1');
  assert.equal(previewAddress('[::1]:3000'), 'http://[::1]:3000/');
  assert.equal(previewAddress('192.0.2.2:8080'), 'http://192.0.2.2:8080/');
  assert.equal(previewAddress('example.com'), 'https://example.com/');
  assert.equal(previewAddress('https://example.com/path'), 'https://example.com/path');
  assert.equal(previewAddress('http://intranet/'), 'http://intranet/');
});

test('the address bar rejects privileged URLs, credentials, and ambiguous input', () => {
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hello', 'ftp://example.com']) {
    assert.throws(() => previewAddress(value), /http and https/);
  }
  assert.throws(() => previewAddress(''), /Enter a website/);
  assert.throws(() => previewAddress('a search query'), /valid address/);
  assert.throws(() => previewAddress('something'), /full website/);
  assert.throws(() => previewAddress('https://user:pass@example.com'), /username and password/);
  assert.throws(() => previewAddress(`https://example.com/${'x'.repeat(4096)}`), /too long/);
});

test('preview failures explain the difference between local servers and website sessions', () => {
  assert.match(previewFailureAdvice('http://127.0.0.1:5173'), /Start the development server/);
  assert.match(previewFailureAdvice('http://localhost:5173'), /Electron projects/);
  assert.match(previewFailureAdvice('http://[::1]:5173'), /development server/);
  assert.match(previewFailureAdvice('https://example.com'), /does not share browser logins/);
});

test('the preview rail has a manual entry point even without any model-produced previews', () => {
  const markup = renderToStaticMarkup(createElement(PreviewGrid, {
    previews: [], limit: 4, expanded: false, onExpandedChange: () => undefined,
    onOpenPreview: () => undefined, openPreviewIdentity: null,
  }));
  assert.match(markup, /Open website/);
  assert.match(markup, /local development server/);
});
