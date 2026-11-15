import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_REINTERPRET_INPUT_BYTES,
  REINTERPRET_SYSTEM_PROMPT,
  cleanReinterpretedPrompt,
  normalizeReinterpretRequest,
  reinterpretMessages,
} from '../src/api/promptReinterpret';

test('A reinterpret request must carry a prompt, a source and a model', () => {
  assert.deepEqual(
    normalizeReinterpretRequest({ text: '  Rewrite this.  ', providerId: ' source ', modelId: ' model ' }),
    { text: 'Rewrite this.', providerId: 'source', modelId: 'model' }
  );
  assert.throws(() => normalizeReinterpretRequest(null), /Choose a prompt/);
  assert.throws(() => normalizeReinterpretRequest({ text: ' ', providerId: 's', modelId: 'm' }), /The prompt is missing/);
  assert.throws(() => normalizeReinterpretRequest({ text: 'x', modelId: 'm' }), /model source is missing/);
  assert.throws(() => normalizeReinterpretRequest({ text: 'x', providerId: 's' }), /model is missing/);
  assert.throws(
    () => normalizeReinterpretRequest({ text: 'x'.repeat(MAX_REINTERPRET_INPUT_BYTES + 1), providerId: 's', modelId: 'm' }),
    /larger than 64 KiB/
  );
});

test('The rewrite is a two-message, tool-free instruction that names the agent workflow', () => {
  const messages = reinterpretMessages('Add a dark mode toggle.');
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user']);
  assert.equal(messages[1].content, 'Add a dark mode toggle.');
  assert.match(REINTERPRET_SYSTEM_PROMPT, /Return only the rewritten prompt/);
  assert.match(REINTERPRET_SYSTEM_PROMPT, /\{\{field\}\}/);
  assert.match(REINTERPRET_SYSTEM_PROMPT, /Run the relevant tests/);
  assert.match(REINTERPRET_SYSTEM_PROMPT, /preview_image/);
  assert.match(REINTERPRET_SYSTEM_PROMPT, /web_search/);
  assert.ok(messages.every((message) => !message.toolCalls));
});

test('Only one outer code fence is unwrapped; a prompt may keep its own fences', () => {
  assert.equal(cleanReinterpretedPrompt('```markdown\n## Goal\n\nShip it.\n```'), '## Goal\n\nShip it.');
  assert.equal(cleanReinterpretedPrompt('```\n## Goal\n\nShip it.\n```\n'), '## Goal\n\nShip it.');
  assert.equal(cleanReinterpretedPrompt('\uFEFF  ## Goal\n\nShip it.  '), '## Goal\n\nShip it.');
  const inner = '## Goal\n\nUse:\n\n```ts\nconst x = 1;\n```';
  assert.equal(cleanReinterpretedPrompt(inner), inner);
  assert.equal(cleanReinterpretedPrompt(''), '');
});
