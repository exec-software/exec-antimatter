import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/api/types';
import { conversationTokens } from '../src/api/tokenEstimate';
import { compactionRequest } from '../src/main/compactionRequest';
import { fitWithCompactionNotice, promptBudget } from '../src/main/context';
import { prepareInteractiveRequest } from '../src/main/interactiveRequest';
import type { ModelProfile } from '../src/main/modelProfiles';

const profile: ModelProfile = { modelId: 'small', thinkingLevel: 'default', contextTokens: 2048,
  maxOutputTokens: 512, maxToolCallsPerMessage: 4, contextSource: 'override', outputSource: 'override',
  toolCallSource: 'override', compaction: 'summarize' };
const history: Message[] = [{ id: 'first', role: 'user', content: 'Fix the project and preserve its API.' },
  ...Array.from({ length: 24 }, (_, i): Message => ({ id: `old-${i}`, role: i % 2 ? 'assistant' : 'user', content: `Step ${i}: ${'detail '.repeat(180)}` })),
  { id: 'continue', role: 'user', content: 'Continue on the smaller model.' }];

test('model handoff re-fits expanded history to the new window and preserves the current request', () => {
  const request = { providerId: 'new-source', model: 'small', messages: history };
  const large = { ...profile, modelId: 'large', contextTokens: 65536, maxOutputTokens: 8192 };
  assert.equal(prepareInteractiveRequest(request, history, 'Project instructions.', large, promptBudget(large, [])).fit.compacted, 0);
  const prepared = prepareInteractiveRequest(request, history, 'Project instructions.', profile, promptBudget(profile, []));
  assert.ok(prepared.fit.compacted > 0);
  const summaryRequest = compactionRequest(profile, prepared.fit.dropped)!;
  assert.ok(conversationTokens(summaryRequest.messages) + summaryRequest.maxTokens! <= profile.contextTokens);
  const fitted = fitWithCompactionNotice(prepared.grounded, promptBudget(profile, []), 'The original API remains required. Continue implementing the pending fix.');
  assert.equal(fitted.overflowTokens, 0);
  assert.equal(fitted.messages.at(-1)?.id, 'continue');
  assert.ok(fitted.messages.some((message) => message.content.includes('original API')));
  assert.equal(prepared.request.maxTokens, 512);
  assert.equal(prepared.request.model, 'small');
});

test('summary requests honor hard execution caps and keep previous summaries plus recent unfinished work', () => {
  const compact = { ...profile, contextTokens: 32768, maxEvaluatedTokens: 1024 };
  const request = compactionRequest(compact, [
    { id: 'compaction_previous', role: 'user', content: 'Decision: keep the existing schema.' },
    { id: 'huge-tool', role: 'tool', content: 'log '.repeat(20000) },
    { id: 'latest', role: 'assistant', content: 'Unfinished: add cancellation handling.' },
  ])!;
  assert.ok(conversationTokens(request.messages) + request.maxTokens! < 1024);
  assert.match(request.messages[0].content, /keep the existing schema/);
  assert.match(request.messages[0].content, /add cancellation handling/);
  assert.equal(request.useTools, false);
  assert.equal(compactionRequest({ ...profile, maxEvaluatedTokens: 64 }, history), undefined);
});
