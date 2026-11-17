import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelTree, type TreeEntry } from '../renderer/src/components/hub/ModelTree';
import type { Model, ProviderConfig } from '../renderer/src/types';

const source = (id: string, name: string): ProviderConfig =>
  ({ id, name, baseUrl: `http://${id}.invalid/v1`, kind: 'llama-cpp', models: [], supportsStreaming: true }) as ProviderConfig;

const model = (id: string, name: string): Model => ({ id, name }) as Model;

const entries: TreeEntry[] = [
  { source: source('local', 'beholdd GPU (Vulkan)'), model: model('laguna-s-2.1', 'Laguna S 2.1') },
  { source: source('mimic', 'Laguna S 2.1 (mimic, hosted)'), model: model('laguna-s-21-118b-iq4', 'Laguna S 2.1 118B') },
];

const render = (props: Partial<Parameters<typeof ModelTree>[0]> = {}) =>
  renderToStaticMarkup(createElement(ModelTree, {
    entries,
    selection: null,
    onSelect: () => {},
    current: { providerId: 'local', modelId: 'laguna-s-2.1' },
    resident: new Set<string>(),
    ...props,
  }));

test('the root of the tree is the model, with its source beneath rather than beside', () => {
  const markup = render();
  assert.match(markup, /Laguna S 2\.1/);
  assert.match(markup, /beholdd GPU \(Vulkan\)/);
  // A tree, announced as one, so it is navigable rather than merely indented.
  assert.match(markup, /role="tree"/);
  assert.match(markup, /aria-label="Model Library"/);
  assert.equal(markup.match(/role="treeitem"/g)?.length, entries.length);
});

test('collapsed roots ask the main process for nothing', () => {
  // Workloads load on expand. A library holds more models than anyone opens, and a collapsed row
  // that still costs an IPC round trip is the kind of thing that only shows up on a big catalog.
  // No electronAPI is stubbed here at all: if the tree read one while collapsed, this would throw.
  const markup = render();
  assert.doesNotMatch(markup, /Reading workloads/);
  assert.doesNotMatch(markup, /aria-expanded="true"/);
});

test('the model answering this chat is marked, and so is anything resident', () => {
  const markup = render({ resident: new Set(['local:laguna-s-2.1']) });
  assert.match(markup, /in this chat/);
  assert.match(markup, /loaded/);
  // The hosted twin is neither, so the marks identify one row rather than decorating every row.
  assert.equal(markup.match(/in this chat/g)?.length, 1);
  assert.equal(markup.match(/>loaded</g)?.length, 1);
});

test('selecting a model marks that row selected without expanding the whole library', () => {
  const markup = render({ selection: { sourceId: 'mimic', modelId: 'laguna-s-21-118b-iq4' } });
  assert.match(markup, /aria-selected="true"/);
  assert.equal(markup.match(/aria-selected="true"/g)?.length, 1);
});

test('an empty library says what to do instead of rendering an empty tree', () => {
  const markup = render({ entries: [] });
  assert.doesNotMatch(markup, /role="tree"/);
  assert.match(markup, /Manage connections/);
});
