import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message, ToolCall } from '../src/api/types';
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

test('a folded working session keeps the calls it made, their paths, and the result each belongs to', () => {
  const large: ModelProfile = { ...profile, modelId: 'large', contextTokens: 131072, maxOutputTokens: 8192 };
  const call = (id: string, name: string, args: string): ToolCall =>
    ({ id, type: 'function', function: { name, arguments: args } });
  // The shape that was being lost: an assistant turn whose content is empty because the work is
  // the call, answered by a result that only makes sense once it is attributed.
  const session: Message[] = [
    { id: 'u', role: 'user', content: 'Index the project.' },
    { id: 'a1', role: 'assistant', content: '', toolCalls: [call('c1', 'read_file', '{"path":"nibz/matrix/physics.matrix"}')] },
    { id: 't1', role: 'tool', toolCallId: 'c1', content: 'paragraph fragment receives mesh as Mesh, count as integer' },
    { id: 'a2', role: 'assistant', content: '', toolCalls: [call('c2', 'run_command', '{"command":"./devel/test-matrix.sh"}')] },
    { id: 't2', role: 'tool', toolCallId: 'c2', content: 'all checks pass' },
    // One bulky argument must not spend the whole allowance on itself.
    { id: 'a3', role: 'assistant', content: '', toolCalls: [call('c3', 'write_file', `{"path":"nibz/matrix/dismemberment.matrix","content":"${'x'.repeat(60000)}"}`)] },
    { id: 't3', role: 'tool', toolCallId: 'c3', content: 'y'.repeat(60000) },
  ];
  const shown = compactionRequest(large, session)!.messages[0].content;
  for (const kept of ['read_file', 'run_command', 'write_file', 'physics.matrix', 'test-matrix.sh',
                      'dismemberment.matrix', 'all checks pass']) {
    assert.ok(shown.includes(kept), `the summarizer was never shown ${kept}`);
  }
  assert.match(shown, /read_file result: paragraph fragment/);
  // The old symptom: an assistant turn serialized as a header with nothing under it.
  assert.doesNotMatch(shown, /assistant: *\n\n/);
  assert.match(shown, /^assistant:\ncalls read_file\(/m);
  assert.ok(shown.length < 8000, `one call's arguments crowded out the session: ${shown.length} characters`);
});
