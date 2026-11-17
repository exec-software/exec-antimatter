import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { modelDeployment, sourceDeployment } from '../src/api/modelDeployment';
import { filterLibraryEntries, profileDeployment } from '../renderer/src/components/hub/libraryFilters';
import { ModelCard, ModelLibrary } from '../renderer/src/components/hub/ModelLibrary';
import type { OrchestrationProfileInfo, ProviderConfig } from '../renderer/src/types';

const local: ProviderConfig = {
  id: 'engine', name: 'Engine', kind: 'beholdd', baseUrl: 'http://127.0.0.1:6768/v1',
  credentialConfigured: false, supportsStreaming: true,
  models: [
    { id: 'solo', name: 'Solo' },
    { id: 'sharded', name: 'Sharded', deployment: 'distributed' },
    { id: 'hidden', name: 'Hidden', hidden: true },
  ],
};
const provider: ProviderConfig = {
  ...local, id: 'byok', name: 'My provider', kind: 'openai',
  // A local proxy in front of a hosted provider still belongs under Provider.
  models: [{ id: 'gpt-model', name: 'GPT model' }],
};
const profile = (mode?: OrchestrationProfileInfo['mode'], model = 'solo'): OrchestrationProfileInfo => ({
  id: 'routing', name: 'Routing', description: '', mode,
  roles: { default: { provider: null, model } }, path: '/routing.yaml', builtin: false,
});

test('classification uses explicit category and distributed recipes before endpoint heuristics', () => {
  assert.equal(sourceDeployment({ baseUrl: 'http://[::1]:6768/v1' }), 'local');
  assert.equal(sourceDeployment({ baseUrl: 'https://gateway.example/v1' }), 'provider');
  assert.equal(modelDeployment(local, local.models[0], true), 'distributed');
  assert.equal(modelDeployment(provider, provider.models[0], true), 'provider');
  assert.equal(modelDeployment(local, { deployment: 'provider' }, true), 'provider');
});

test('the three filters are mutually exclusive and hidden models require explicit inclusion', () => {
  const sources = [local, provider];
  const ids = (category: 'local' | 'distributed' | 'provider', query = '', hidden = false) =>
    filterLibraryEntries(sources, category, query, hidden).map(({ model }) => model.id);
  assert.deepEqual(ids('local'), ['solo']);
  assert.deepEqual(ids('distributed'), ['sharded']);
  assert.deepEqual(ids('provider'), ['gpt-model']);
  assert.deepEqual(ids('provider', 'solo'), []);
  assert.deepEqual(ids('local', '', true), ['solo', 'hidden']);
  assert.deepEqual(ids('distributed', '', true), ['sharded']);
});

test('untagged profiles do not leak into unrelated categories', () => {
  assert.equal(profileDeployment(profile('local'), [local]), 'local');
  assert.equal(profileDeployment(profile(undefined), [local]), 'local');
  assert.equal(profileDeployment(profile(undefined, 'sharded'), [local]), 'distributed');
  assert.equal(profileDeployment(profile(undefined, 'gpt-model'), [local, provider]), 'provider');
  assert.equal(profileDeployment(profile(undefined, 'missing'), [local]), null);
  assert.equal(profileDeployment(profile(undefined), [local, { ...provider, models: [{ id: 'solo', name: 'Also solo' }] }]), null);
  assert.equal(profileDeployment({ ...profile(), roles: {
    default: { provider: 'engine', model: 'solo' }, code: { provider: 'lan', model: 'solo' },
  } }, [local, { ...local, id: 'lan', baseUrl: 'http://192.0.2.10:8000/v1' }]), 'distributed');
});

test('model cards expose rename, settings, and reversible visibility management', () => {
  const card = (hidden = false) => renderToStaticMarkup(createElement(ModelCard, {
    source: local, model: { ...local.models[0], hidden }, selected: false,
    onUse: () => undefined, actionLabel: 'Use in this chat', selectedLabel: 'Selected',
  }));
  assert.match(card(), />\s*Rename</);
  assert.match(card(), />Edit settings</);
  assert.match(card(), />Hide</);
  assert.match(card(true), />Restore</);
});

test('library category applies before selected-model ranking and lists only matching models', () => {
  const markup = renderToStaticMarkup(createElement(ModelLibrary, {
    providers: [local, provider], providerId: 'byok', modelId: 'gpt-model',
    onUseModel: () => undefined, onOpenSettings: () => undefined,
  }));
  // The library is a tree now, so the filter is checked on its rows rather than on rendered
  // cards: a card only exists once a node is selected, and nothing is selected on first paint.
  assert.match(markup, /role="tree"/);
  assert.match(markup, /title="gpt-model"/);
  // The local source's models are the ones that must be absent under the Provider category.
  assert.doesNotMatch(markup, /title="solo"/);
  assert.doesNotMatch(markup, /title="sharded"/);
  assert.doesNotMatch(markup, /title="hidden"/);
  // The chat's own model is still findable without opening anything.
  assert.match(markup, /in this chat/);
  assert.match(markup, /aria-label="Filter model library"/);
  assert.doesNotMatch(markup, />All stacks<|>Single<|>Remote</);
});

test('the library is three peer tabs, not one column that implies containment', () => {
  const markup = renderToStaticMarkup(createElement(ModelLibrary, {
    providers: [local, provider], providerId: 'byok', modelId: 'gpt-model',
    onUseModel: () => undefined, onOpenSettings: () => undefined,
  }));
  assert.match(markup, /role="tablist"/);
  for (const label of ['>Models<', '>Sources<', '>Orchestration<']) assert.match(markup, new RegExp(label));
  // Models is the landing tab, and only its panel is mounted.
  assert.match(markup, /id="library-panel-models"/);
  assert.doesNotMatch(markup, /id="library-panel-sources"/);
  assert.doesNotMatch(markup, /id="library-panel-orchestration"/);
  // ADR 0001's actual complaint: orchestration sat under the model list and read as belonging to
  // it. On a separate tab it cannot, so the section must not render beside the tree at all.
  assert.doesNotMatch(markup, /Orchestration profiles/);
  // The tree and its filter belong to the Models tab and are still there on first paint.
  assert.match(markup, /role="tree"/);
  assert.match(markup, /aria-label="Filter model library"/);
  // Exactly one tab is selected, so nothing renders as two places at once.
  assert.equal(markup.match(/role="tab" id="library-tab-[a-z]+" aria-selected="true"/g)?.length, 1);
});
