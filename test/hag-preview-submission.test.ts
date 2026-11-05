import assert from 'node:assert/strict';
import test from 'node:test';
import { HAG_MODEL_ID, HAG_SOURCE_ID } from '../src/api/hag';
import { hagPreviewHistoryProblem, hagPreviewSubmissionProblem } from '../renderer/src/lib/hagPreview';
import { submitComposerDraft } from '../renderer/src/lib/composerSubmission';
import { conversationRequestMessages } from '../renderer/src/lib/requestMessages';
import type { Message, ToolActivity } from '../renderer/src/types';

const user: Message = { id: 'new-user', role: 'user', content: 'Say hello.' };
const attachment = { id: 'file', name: 'notes.txt', content: 'File contents', size: 13 };
const tool: ToolActivity = { callId: 'call', requestId: 'answer', serverId: 'files', serverName: 'Files',
  toolName: 'read_file', tier: 'read', args: '{}', status: 'done', result: 'File contents' };

test('HAG catches old attachment and tool history before visible request conversion erases their metadata', () => {
  for (const history of [
    [{ id: 'old-user', role: 'user' as const, content: 'Read this.', attachments: [attachment] }],
    [{ id: 'old-assistant', role: 'assistant' as const, content: 'I read it.', meta: { createdAt: 1, tools: [tool] } }],
    [{ id: 'custom-system', role: 'system' as const, content: 'Use a custom instruction.' }],
  ]) {
    const snapshot = JSON.stringify(history);
    // This is why checking only the transport messages is insufficient after a restart.
    assert.equal('attachments' in conversationRequestMessages(history, user)[0], false);
    assert.equal('meta' in conversationRequestMessages(history, user)[0], false);
    assert.match(hagPreviewHistoryProblem(HAG_SOURCE_ID, history)!, /Start a new short text chat/);
    assert.match(hagPreviewSubmissionProblem(HAG_SOURCE_ID, HAG_MODEL_ID, history, user)!, /existing conversation is unchanged/);
    assert.equal(JSON.stringify(history), snapshot);
  }
});

test('a refused HAG draft stays unsent with all its text and files', () => {
  for (const draft of [
    { text: 'Keep this draft', attachments: [attachment] },
    { text: 'A'.repeat(2048), attachments: [] },
  ]) {
    let refusal: string | undefined;
    const result = submitComposerDraft(draft, (text, attachments) => {
      refusal = hagPreviewSubmissionProblem(HAG_SOURCE_ID, HAG_MODEL_ID, [], { ...user, content: text, attachments });
      return !refusal;
    });
    assert.ok(refusal); assert.equal(result.accepted, false); assert.deepEqual(result.nextDraft, draft);
  }
});

test('short text HAG exchanges pass preflight and ordinary sources retain full draft behavior', () => {
  assert.equal(hagPreviewSubmissionProblem(HAG_SOURCE_ID, HAG_MODEL_ID, [
    { id: 'first', role: 'user', content: 'Hello.' }, { id: 'answer', role: 'assistant', content: 'Hi.' },
  ], user), undefined);
  const fileHistory: Message[] = [{ ...user, attachments: [attachment] }];
  assert.equal(hagPreviewHistoryProblem('local-openmythos-27b', fileHistory), undefined);
  assert.equal(hagPreviewSubmissionProblem('local-openmythos-27b', 'openmythos-27b', fileHistory, { ...user, content: 'A'.repeat(2048) }), undefined);
});
