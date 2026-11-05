import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { previewRectanglesOverlap } from '../renderer/src/components/chat/PreviewPane';
import { PREVIEW_BROWSERS, PreviewPanel, previewBrowserItems } from '../renderer/src/plugins/preview/PreviewPanel';
import { PreviewPanelProvider } from '../renderer/src/plugins/preview/context';
import type { ConversationPreview } from '../renderer/src/lib/conversation';

const page: ConversationPreview = { id: 'page', kind: 'page', target: 'http://localhost:5173/', title: 'Development app', at: 1 };
const image: ConversationPreview = { id: 'image', kind: 'image', target: 'preview.png', title: 'Screenshot', at: 2, workspace: '/project' };

test('preview browser choices deduplicate targets but preserve distinct image workspaces', () => {
  const other = { ...image, id: 'other', workspace: '/other' };
  assert.deepEqual(previewBrowserItems([page, image, other, { ...image, id: 'duplicate' }], image, 'image'), [image, other]);
  assert.deepEqual(previewBrowserItems([page, image], { ...page, title: 'Selected page' }, 'page'), [{ ...page, title: 'Selected page' }]);
  assert.deepEqual(previewBrowserItems([page, image], { ...page, target: '' }, 'page'), [page]);
});

test('the browser advertises only implemented formats', () => {
  assert.deepEqual(PREVIEW_BROWSERS.map(({ kind, label }) => [kind, label]), [['page', 'Web'], ['image', 'Images']]);
});

test('a hidden preview tool renders no live viewer', () => {
  const markup = renderToStaticMarkup(createElement(PreviewPanelProvider, {
    value: { selected: page, previews: [page, image], workspace: '/project', onSelect: () => {}, onClear: () => {} },
  }, createElement(PreviewPanel, { floating: false, visible: false })));
  assert.equal(markup, '');
});

test('the embedded image browser has no second modal close or outer rounded frame', () => {
  const markup = renderToStaticMarkup(createElement(PreviewPanelProvider, {
    value: { selected: image, previews: [page, image], workspace: '/project', onSelect: () => {}, onClear: () => {} },
  }, createElement(PreviewPanel, { floating: false, visible: true })));
  assert.match(markup, /Preview types/);
  assert.match(markup, /Conversation images/);
  assert.match(markup, /Image thumbnails/);
  assert.match(markup, /Reload image/);
  assert.doesNotMatch(markup, /Close preview|rounded-2xl|shadow-xl/);
});

test('native browser occlusion requires a positive overlapping rectangle', () => {
  const page = { x: 200, y: 100, width: 480, height: 500 };
  assert.equal(previewRectanglesOverlap(page, { x: 300, y: 200, width: 100, height: 100 }), true);
  assert.equal(previewRectanglesOverlap(page, { x: 0, y: 0, width: 200, height: 500 }), false);
  assert.equal(previewRectanglesOverlap(page, { x: 300, y: 200, width: 0, height: 100 }), false);
  assert.equal(previewRectanglesOverlap(page, { x: 700, y: 700, width: 100, height: 100 }), false);
});
