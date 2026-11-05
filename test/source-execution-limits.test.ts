import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as recipes from '../src/main/recipes';

// Public projection needs no Electron runtime, store, credential lookup or model request.
type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const nodeModule = require('node:module') as { _load: ModuleLoader };
const originalLoad = nodeModule._load;
nodeModule._load = function load(request, parent, isMain) {
  return request === 'electron'
    ? { app: {}, safeStorage: {} }
    : originalLoad.call(this, request, parent, isMain);
};
let sourceStore: typeof import('../src/main/sourceStore');
try {
  sourceStore = require('../src/main/sourceStore') as typeof import('../src/main/sourceStore');
} finally {
  nodeModule._load = originalLoad;
}

test('public model projection carries server execution caps without exposing private metadata', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-cap-projection-'));
  const previous = recipes.location();
  recipes.useRoot(root);
  t.after(() => { recipes.useRoot(previous); rmSync(root, { recursive: true, force: true }); });
  const source = sourceStore.publicSource({
    id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:6768/v1', apiKey: 'private-key',
    kind: 'beholdd', createdAt: 1, supportsStreaming: true,
    models: [
      { id: 'hag', name: 'HAG', contextWindow: 131_072, contextWindowCurated: true, maxEvaluatedTokens: 128 },
      { id: 'cpu', name: 'CPU', maxEvaluatedTokens: null },
      { id: 'legacy', name: 'Legacy' },
    ],
  });
  assert.deepEqual(source.models, [
    { id: 'hag', name: 'HAG', contextWindow: 131_072, maxEvaluatedTokens: 128, deployment: 'local' },
    { id: 'cpu', name: 'CPU', maxEvaluatedTokens: null, deployment: 'local' },
    { id: 'legacy', name: 'Legacy', deployment: 'local' },
  ]);
  assert.equal(source.credentialConfigured, true);
  assert.equal(Object.hasOwn(source, 'apiKey'), false);
  assert.equal(Object.hasOwn(source.models[0], 'contextWindowCurated'), false);
});
