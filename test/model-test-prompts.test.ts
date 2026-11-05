import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyModelTestPrompt, MODEL_TEST_CATEGORIES, MODEL_TEST_PROMPTS } from '../renderer/src/components/developer/modelTestPrompts';
import { ModelTestPromptsPanel } from '../renderer/src/components/developer/ModelTestPromptsPanel';

test('model test library has eight complete, uniquely identified prompts ordered from small to integrated projects', () => {
  assert.equal(MODEL_TEST_PROMPTS.length, 8);
  assert.equal(new Set(MODEL_TEST_PROMPTS.map((item) => item.id)).size, 8);
  assert.equal(new Set(MODEL_TEST_PROMPTS.map((item) => item.title)).size, 8);
  assert.deepEqual(MODEL_TEST_PROMPTS.map((item) => item.category), MODEL_TEST_CATEGORIES.flatMap((category) => [category.id, category.id]));
  for (const item of MODEL_TEST_PROMPTS) {
    assert.ok(item.prompt.length > 2000, `${item.id} is a complete project request, not just a title`);
    assert.match(item.prompt, /user-selected scratch workspace/);
    assert.match(item.prompt, /Preserve existing work/);
    assert.match(item.prompt, /Do not deploy, publish, push commits, or install global packages/);
    assert.match(item.prompt, /read real credentials/);
    assert.match(item.prompt, /Use at most two specialist agents/);
    assert.match(item.prompt, /tools actually available/);
    assert.match(item.prompt, /tests actually run and their results/);
    assert.match(item.prompt, /Do not claim a preview was viewed or a test passed unless you observed it/);
    assert.ok(item.focus.length >= 3);
  }
});

test('copy writes the exact complete prompt once and never a shortened card description', async () => {
  const writes: string[] = [];
  const item = MODEL_TEST_PROMPTS[0];
  assert.equal(await copyModelTestPrompt(item, { writeText: async (text) => { writes.push(text); } }), true);
  assert.deepEqual(writes, [item.prompt]);
  assert.notEqual(writes[0], item.description);
});

test('missing or denied clipboard returns the manual-copy path without throwing or executing anything', async () => {
  assert.equal(await copyModelTestPrompt(MODEL_TEST_PROMPTS[0]), false);
  assert.equal(await copyModelTestPrompt(MODEL_TEST_PROMPTS[0], { writeText: async () => { throw new Error('clipboard denied'); } }), false);
});

test('prompt library renders native foldable groups, accessible copy controls, and selectable complete text', () => {
  const html = renderToStaticMarkup(createElement(ModelTestPromptsPanel));
  assert.equal((html.match(/<details\b/g) ?? []).length, 12);
  assert.equal((html.match(/<textarea\b/g) ?? []).length, 8);
  assert.equal((html.match(/readonly=""/g) ?? []).length, 8);
  assert.equal((html.match(/aria-label="Copy full prompt:/g) ?? []).length, 8);
  assert.equal((html.match(/aria-label="Select full prompt:/g) ?? []).length, 8);
  assert.equal((html.match(/role="status"/g) ?? []).length, 8);
  assert.match(html, /does not run tools, install/);
  assert.match(html, /create chats, or send messages/);
  assert.doesNotMatch(html, /Send prompt|Run project|Start agent/);
});
