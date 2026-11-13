import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/api/types';
import type { ModelProfile } from '../src/main/modelProfiles';
import { summarizeIdleConversation } from '../src/main/idleCompactionSummary';
import { conversationTokens, isCompactionNotice } from '../src/main/context';

const profile: ModelProfile = { modelId: 'fixture', contextTokens: 16000, maxOutputTokens: 1000, contextSource: 'override', outputSource: 'override', compaction: 'summarize' };
function history(): Message[] {
  return [{ id: 'system', role: 'system', content: 'Preserve project instructions.' },
    ...Array.from({ length: 20 }, (_, index): Message => ({ id: `turn-${index}`, role: index % 2 ? 'assistant' : 'user', content: `Turn ${index}: ` + 'source context and concrete file names. '.repeat(160) })),
    { id: 'latest', role: 'user', content: 'Continue the remaining implementation.' }];
}
test('idle summarization compacts hidden context with bounded tool-free requests and keeps original objects intact', async () => {
  const messages = history(); const before = structuredClone(messages); let calls = 0;
  const result = await summarizeIdleConversation(messages, profile, async (request) => {
    calls++; assert.equal(request.useTools, false); assert.ok(request.maxTokens! <= 512); assert.equal(request.model, 'fixture');
    assert.ok(conversationTokens(request.messages) < profile.contextTokens); return 'The implementation updates source files; finish tests and packaging.';
  }, new AbortController().signal);
  assert.equal(calls, 1); assert.ok(result); assert.ok(result.compactedMessages > 0);
  assert.ok(result.payload.some(isCompactionNotice)); assert.ok(result.payload.some((entry) => entry.id === 'system'));
  assert.ok(result.payload.some((entry) => entry.id === 'latest')); assert.ok(conversationTokens(result.payload) < conversationTokens(messages));
  assert.deepEqual(messages, before);
});
test('empty, cancelled, failed and nonbeneficial summaries never replace history', async () => {
  const messages = history(); const before = structuredClone(messages);
  assert.equal(await summarizeIdleConversation(messages, profile, async () => '   ', new AbortController().signal), null);
  const controller = new AbortController();
  assert.equal(await summarizeIdleConversation(messages, profile, async () => { controller.abort(); return 'Too late'; }, controller.signal), null);
  await assert.rejects(summarizeIdleConversation(messages, profile, async () => { throw new Error('Source offline'); }, new AbortController().signal), /offline/);
  assert.equal(await summarizeIdleConversation(messages, profile, async () => 'oversized summary '.repeat(20000), new AbortController().signal), null);
  assert.deepEqual(messages, before);
});
test('small histories and mandatory context overflow do not call inference', async () => {
  let calls = 0; const chat = async () => { calls++; return 'summary'; };
  assert.equal(await summarizeIdleConversation([{ id: 'small', role: 'user', content: 'Hi' }], profile, chat, new AbortController().signal), null);
  assert.equal(await summarizeIdleConversation([{ id: 'system', role: 'system', content: 'mandatory '.repeat(20000) }], profile, chat, new AbortController().signal), null);
  assert.equal(calls, 0);
});
