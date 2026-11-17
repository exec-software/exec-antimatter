import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyLibraryOrder, reorderLibrary } from '../src/api/libraryOrder';
import { DEFAULT_LIBRARY_ORDER, normalizeLibraryOrder, read, save, useConfigPath } from '../src/main/libraryOrder';
import { ModelTree, type TreeEntry } from '../renderer/src/components/hub/ModelTree';
import type { Model, ProviderConfig } from '../renderer/src/types';

const key = (value: string) => value;

test('a stored position wins; everything unplaced keeps the ranking it arrived with', () => {
  const items = ['a', 'b', 'c', 'd'];
  // Only c is placed, so it leads and the rest stay in their incoming order rather than being
  // reshuffled — that incoming order is the chat-model-first, resident-next ranking.
  assert.deepEqual(applyLibraryOrder(items, key, ['c']), ['c', 'a', 'b', 'd']);
  assert.deepEqual(applyLibraryOrder(items, key, ['d', 'b']), ['d', 'b', 'a', 'c']);
  // A stored key for a model that is gone, hidden or filtered out must not disturb the rest.
  assert.deepEqual(applyLibraryOrder(items, key, ['zz', 'b']), ['b', 'a', 'c', 'd']);
  assert.deepEqual(applyLibraryOrder(items, key, []), items);
});

test('a drop is computed from the visible rows, so it means what it looks like', () => {
  const visible = ['a', 'b', 'c'];
  assert.deepEqual(reorderLibrary(visible, 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(reorderLibrary(visible, 'a', 'c'), ['b', 'a', 'c']);
  // Null means the end.
  assert.deepEqual(reorderLibrary(visible, 'a', null), ['b', 'c', 'a']);
  // Dropping a row on itself changes nothing.
  assert.deepEqual(reorderLibrary(visible, 'b', 'b'), ['a', 'b', 'c']);
  // A target that is not on screen falls to the end rather than throwing the list away.
  assert.deepEqual(reorderLibrary(visible, 'a', 'gone'), ['b', 'c', 'a']);
  // A moved row that is not visible leaves the arrangement alone.
  assert.deepEqual(reorderLibrary(visible, 'nope', 'a'), ['a', 'b', 'c']);
});

test('a stored order is bounded and deduplicated, because it decides a sort', () => {
  assert.deepEqual(normalizeLibraryOrder(undefined), DEFAULT_LIBRARY_ORDER);
  assert.deepEqual(normalizeLibraryOrder({ order: 'nope' }), DEFAULT_LIBRARY_ORDER);
  // A duplicate would make the sort depend on which copy was seen first.
  assert.deepEqual(normalizeLibraryOrder({ order: ['a', 'a', 'b'] }).order, ['a', 'b']);
  assert.deepEqual(normalizeLibraryOrder({ order: ['  a  ', 7, null, 'b'] }).order, ['a', 'b']);
  assert.equal(normalizeLibraryOrder({ order: ['x'.repeat(600)] }).order.length, 0);
  assert.equal(normalizeLibraryOrder({ order: Array.from({ length: 5_000 }, (_, i) => `k${i}`) }).order.length, 2_000);
});

test('the order survives a round trip, since the renderer reads it back on open', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-order-'));
  t.after(() => {
    useConfigPath(join(root, 'unused.json'));
    rmSync(root, { recursive: true, force: true });
  });
  const file = join(root, 'library-order.json');
  useConfigPath(file);
  assert.deepEqual(read(), DEFAULT_LIBRARY_ORDER);
  save({ order: ['engine:solo', 'byok:gpt-model'] });
  useConfigPath(file);
  assert.deepEqual(read().order, ['engine:solo', 'byok:gpt-model']);
});

const source = (id: string, name: string): ProviderConfig =>
  ({ id, name, baseUrl: `http://${id}.invalid/v1`, kind: 'llama-cpp', models: [], supportsStreaming: true }) as ProviderConfig;
const entries: TreeEntry[] = [
  { source: source('local', 'beholdd'), model: ({ id: 'laguna-s-2.1', name: 'Laguna S 2.1' }) as Model },
];
const render = (props: Partial<Parameters<typeof ModelTree>[0]> = {}) =>
  renderToStaticMarkup(createElement(ModelTree, {
    entries, selection: null, onSelect: () => {},
    current: { providerId: 'local', modelId: 'laguna-s-2.1' },
    resident: new Set<string>(), ...props,
  }));

test('rename and drag appear only when the caller can actually persist them', () => {
  // A control that silently does nothing is worse than no control, so both are opt-in.
  const readOnly = render();
  assert.doesNotMatch(readOnly, /aria-label="Rename Laguna S 2\.1"/);
  assert.doesNotMatch(readOnly, /draggable="true"/);

  const editable = render({ onRename: () => {}, onReorder: () => {} });
  assert.match(editable, /aria-label="Rename Laguna S 2\.1"/);
  assert.match(editable, /draggable="true"/);

  // Each is independent: reordering without renaming must not offer a pencil.
  const draggableOnly = render({ onReorder: () => {} });
  assert.match(draggableOnly, /draggable="true"/);
  assert.doesNotMatch(draggableOnly, /aria-label="Rename Laguna S 2\.1"/);
});
