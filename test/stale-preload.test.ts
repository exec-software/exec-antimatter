import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelLibrary } from '../renderer/src/components/hub/ModelLibrary';
import { WhiteboardPage } from '../renderer/src/components/whiteboard/WhiteboardPage';
import type { ProviderConfig } from '../renderer/src/types';

/**
 * A renderer can be newer than the preload it runs against.
 *
 * vite hot-reloads renderer code while Electron keeps the preload it started with, so a
 * namespace added during a session is simply absent until Electron restarts. Reaching into it
 * throws and React unmounts the subtree, which presents as "clicking the model selection crashes
 * the renderer" — a failure that lands nowhere near its cause. Both pages must degrade instead.
 */

const source: ProviderConfig = {
  id: 'engine', name: 'Engine', kind: 'beholdd', baseUrl: 'http://127.0.0.1:6767/v1',
  supportsStreaming: true, models: [{ id: 'solo', name: 'Solo' }],
} as ProviderConfig;

/** The shape an older preload exposes: providers exist, the new methods do not. */
function stalePreload() {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    electronAPI: { providers: { list: async () => [] }, developer: { get: async () => ({}) } },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return () => { (globalThis as { window?: unknown }).window = previous; };
}

test('the Model Library renders against a preload with no order API', (t) => {
  t.after(stalePreload());
  // The crash was an effect calling providers.orderGet, which did not exist. Render must survive;
  // the library simply has no stored arrangement, which is the behaviour before ordering existed.
  const markup = renderToStaticMarkup(createElement(ModelLibrary, {
    providers: [source], providerId: 'engine', modelId: 'solo',
    onUseModel: () => {}, onOpenSettings: () => {},
  }));
  assert.match(markup, /role="tree"/);
  assert.match(markup, /title="solo"/);
});

test('the whiteboard names the stale build instead of rendering a dead surface', (t) => {
  t.after(stalePreload());
  const markup = renderToStaticMarkup(createElement(WhiteboardPage, {
    threadId: 'thread-1', threadTitle: 'Planning', onLeave: () => {},
  }));
  // The fix is restarting Antimatter, and nobody guesses that from an empty board.
  assert.match(markup, /older main process/);
  assert.match(markup, /Restart Antimatter/);
  assert.doesNotMatch(markup, /Whiteboard surface/);
});
