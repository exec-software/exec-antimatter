import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProviderManager } from '../src/api/providers';
import type { Message } from '../src/api/types';
import { fitToBudget, promptBudget } from '../src/main/context';
import { resolveSourceProfile, storeLocation, useConfigPath } from '../src/main/modelProfiles';
import { mergeProbedModels, probeSource } from '../src/main/probe';
import { systemPrompt } from '../src/main/prompt';
import { validateNewSource } from '../src/main/sourceInput';
import * as recipes from '../src/main/recipes';

// Exercise the real public projection without starting Electron or opening its private stores.
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

test('Beholdd discovery constrains planning and refuses oversized grounding before source preparation', async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'antimatter-beholdd-planning-'));
  const previousProfiles = storeLocation();
  const previousRecipes = recipes.location();
  recipes.useRoot(join(temporary, 'recipes'));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    useConfigPath(previousProfiles);
    recipes.useRoot(previousRecipes);
    rmSync(temporary, { recursive: true, force: true });
  });
  useConfigPath(join(temporary, 'profiles.json'));

  const endpoint = 'http://beholdd-planning.test/v1';
  const modelId = 'qwen3-hag';
  let advertisedCap: number | null = 128;
  let catalogReads = 0;
  let prepared = 0;
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === endpoint + '/models') {
      assert.notEqual(init?.method, 'POST');
      catalogReads += 1;
      return Response.json({ data: [{
        id: modelId, context_length: 131_072,
        execution_limits: { max_evaluated_tokens: advertisedCap },
      }] });
    }
    assert.equal(String(input), endpoint + '/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const body = init?.body;
    assert.equal(typeof body, 'string');
    sent.push(JSON.parse(body as string) as Record<string, unknown>);
    return Response.json({
      model: modelId,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });
  }) as typeof fetch;

  const discovered = await probeSource(endpoint);
  assert.equal(discovered.ok, true);
  const configured = validateNewSource({
    id: 'beholdd-planning', name: 'Bounded Beholdd', baseUrl: endpoint, apiKey: '',
    kind: 'beholdd', supportsStreaming: true,
    models: discovered.models,
  }, new Set());
  assert.equal(configured.models[0].maxEvaluatedTokens, 128, 'initial Add Source validation retains the discovered cap');
  const models = mergeProbedModels(configured.models, discovered.models);
  const publicModels = sourceStore.publicSource({ ...configured, models }).models;
  assert.equal(publicModels[0].maxEvaluatedTokens, 128);
  assert.equal(publicModels[0].contextWindow, 131_072, 'the reported context remains a separate fact');
  const profileFor = (model: typeof models[number]) => resolveSourceProfile([model], configured.id, model.id);
  const profile = profileFor(models[0]);
  assert.equal(profile.contextTokens, 128);
  assert.equal(profile.maxOutputTokens, 32);
  const budget = promptBudget(profile, []);
  assert.ok(budget > 0 && budget < 128, 'the prompt budget does not regain the old 512-token floor');
  const small: Message[] = [{ id: 'user', role: 'user', content: 'Hello.' }];
  const fit = fitToBudget(small, budget);
  assert.equal(fit.overflowTokens, 0);
  assert.deepEqual(fit.messages, small);

  const manager = ProviderManager.fromConfigs([{ ...configured, models }]);
  manager.usePrepareProvider(async (id) => {
    assert.equal(id, configured.id);
    assert.equal(manager.busy(id), true);
    prepared += 1;
  });
  const provider = manager.getProvider(configured.id)!;
  const request = { providerId: configured.id, model: modelId, temperature: 0,
    messages: fit.messages, maxTokens: profile.maxOutputTokens };
  assert.equal(await provider.chat(request), 'ok');
  assert.equal(prepared, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].max_tokens, 32);
  assert.deepEqual(sent[0].messages, [{ role: 'user', content: 'Hello.' }]);
  assert.equal(manager.anyBusy(), false);

  // Keep the actual editor grounding and current question. C128 cannot carry both; neither
  // fitting nor a direct provider call may quietly discard them to manufacture a valid request.
  const grounded: Message[] = [{ id: 'system', role: 'system', content: systemPrompt({
    workspace: '/workspace', workspaceConfirmed: true, mode: 'ask', tools: [], maxOutputTokens: 32,
  }) }, ...small];
  const overflow = fitToBudget(grounded, budget);
  assert.ok(overflow.overflowTokens > 0);
  assert.deepEqual(overflow.messages, grounded);
  await assert.rejects(provider.chat({ ...request, messages: overflow.messages }), /128-token execution limit.*context_length_exceeded/);
  await assert.rejects(provider.stream({ ...request, messages: overflow.messages }, () => {
    assert.fail('a refused stream must not call back');
  }), /context_length_exceeded/);
  assert.equal(prepared, 1, 'a refused plan cannot trigger managed source preparation');
  assert.equal(sent.length, 1, 'a refused plan cannot send a completion request');
  assert.equal(manager.anyBusy(), false);

  advertisedCap = null;
  const refreshed = await probeSource(endpoint);
  assert.equal(refreshed.ok, true);
  const uncappedModels = mergeProbedModels(models, refreshed.models);
  assert.equal(uncappedModels[0].maxEvaluatedTokens, null);
  const uncapped = profileFor(uncappedModels[0]);
  assert.equal(uncapped.contextTokens, 131_072);
  assert.equal(uncapped.maxOutputTokens, 32_768);
  assert.equal(uncapped.maxEvaluatedTokens, undefined);
  manager.addConfig({ ...configured, models: uncappedModels });
  assert.equal(await manager.getProvider(configured.id)!.chat({
    providerId: configured.id, model: modelId, messages: small,
  }), 'ok');
  assert.equal(sent[1].max_tokens, 4096, 'explicit null restores the existing uncapped provider default');
  assert.equal(prepared, 2);
  assert.equal(catalogReads, 2);
  assert.equal(sent.length, 2);
  assert.equal(manager.anyBusy(), false);
});
