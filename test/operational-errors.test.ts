import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOperationalError, operationalError, separateOperationalError } from '../src/api/operationalErrors';
import { sanitizeConversationRequest, visibleRequestMessages } from '../src/api/requestMessages';
import type { Message } from '../src/api/types';
import { chatDiagnostics } from '../renderer/src/lib/chatDiagnostics';
import { restoreDeliveredVoiceHistory } from '../src/main/voice/history';
import type { VoiceGuidance } from '../src/api/voice';

test('operational diagnostics are bounded private metadata and never become assistant words', () => {
  const diagnostic = operationalError("Error invoking remote method 'chat:start-stream': Error: Model is offline", 42);
  assert.deepEqual(diagnostic, { kind: 'operational-error', message: 'Model is offline', at: 42 });
  assert.equal(operationalError('x'.repeat(8_000), 42).message.length, 4_000);
  assert.equal(normalizeOperationalError({ kind: 'operational-error', message: 'x', at: Infinity }), undefined);
  assert.equal(normalizeOperationalError({ kind: 'other', message: 'x', at: 1 }), undefined);
  const farFuture = normalizeOperationalError({ kind: 'operational-error', message: 'x', at: 1e100 });
  assert.equal(farFuture?.at, 8_640_000_000_000_000);
  assert.doesNotThrow(() => new Date(farFuture!.at).toISOString());
  const history = [
    { id: 'user', role: 'user' as const, content: 'Explain this error', meta: { createdAt: 1 } },
    { id: 'partial', role: 'assistant' as const, content: 'Here is the useful partial answer.',
      meta: { failed: true, operationalError: diagnostic } },
    { id: 'empty', role: 'assistant' as const, content: '', meta: { failed: true, operationalError: diagnostic } },
  ];
  assert.deepEqual(visibleRequestMessages(history), [
    { id: 'user', role: 'user', content: 'Explain this error' },
    { id: 'partial', role: 'assistant', content: 'Here is the useful partial answer.' },
  ]);
  assert.equal(history[1].meta.operationalError, diagnostic, 'audit metadata remains available locally');
});

test('legacy failed zero-token placeholders and exact host footers migrate without guessing error prose', () => {
  const failed = { id: 'failed', role: 'assistant', content: 'Error: HTTP 503: model not loaded',
    meta: { failed: true, chunks: 0, createdAt: 1, finishedAt: 8 } };
  const clean = separateOperationalError(failed);
  assert.equal(clean.content, '');
  assert.equal(clean.meta.operationalError?.message, 'HTTP 503: model not loaded');
  assert.equal(clean.meta.operationalError?.at, 8);
  assert.equal(failed.content, 'Error: HTTP 503: model not loaded', 'migration does not mutate its source');
  const partial = { role: 'assistant', content: 'Model output\n\nError: The host could not finish this turn. You can retry after reconnecting.',
    meta: { failed: true, chunks: 1, firstTokenAt: 2 } };
  assert.equal(separateOperationalError(partial).content, 'Model output');
  for (const message of [
    { ...failed, role: 'user' },
    { ...failed, role: 'tool' },
    { ...failed, meta: { failed: false, chunks: 0 } },
    { ...failed, meta: { failed: true, chunks: 1, firstTokenAt: 2 } },
    { ...failed, meta: { failed: true } },
    { ...failed, content: 'The program raises Error: missing input.' },
    { ...partial, content: 'A real partial answer\n\nError: a domain-specific explanation from the model' },
  ]) assert.equal(separateOperationalError(message), message);
});

test('host sanitation excludes legacy diagnostics from resumed history while preserving tool protocol', () => {
  const stored = [
    { id: 'failure', role: 'assistant', content: '', meta: { failed: true, operationalError: operationalError('Offline', 2) } },
    { id: 'partial', role: 'assistant', content: 'Useful prefix', meta: { failed: true,
      operationalError: operationalError('The source became unavailable.', 3) } },
  ];
  const messages: Message[] = [
    { id: 'user', role: 'user', content: 'Error: Offline' },
    { id: 'failure', role: 'assistant', content: 'Error: Offline' },
    { id: 'partial', role: 'assistant', content: 'Useful prefix\n\nError: The source became unavailable.' },
    { id: 'tool-call', role: 'assistant', content: '', toolCalls: [{ id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { id: 'tool-result', role: 'tool', content: 'Error: file missing', toolCallId: 'call' },
    { id: 'last', role: 'user', content: 'Continue' },
  ];
  const cleaned = sanitizeConversationRequest(messages, stored);
  assert.deepEqual(cleaned.map((message) => message.id), ['user', 'partial', 'tool-call', 'tool-result', 'last']);
  assert.equal(cleaned[0].content, 'Error: Offline');
  assert.equal(cleaned[1].content, 'Useful prefix');
  assert.equal(cleaned[2].toolCalls?.[0].id, 'call');
  assert.equal(cleaned[3].content, 'Error: file missing');
  assert.ok(cleaned.every((message) => !('meta' in message)));
  assert.deepEqual(sanitizeConversationRequest([{ ...messages[2], content: 'Edited assistant prose' }], stored),
    [{ ...messages[2], content: 'Edited assistant prose' }], 'mismatched text does not borrow stored error provenance');
});

test('the separate diagnostic audit restores metadata, bounds rendering and never invents errors from prose', () => {
  const messages = [
    { id: 'user', role: 'user', content: 'Error: my program failed', meta: { operationalError: operationalError('Ignored', 1) } },
    { id: 'real', role: 'assistant', content: 'Error: is an ordinary string in this program.' },
    ...[1, 2, 3].map((at) => ({ id: `failure-${at}`, role: 'assistant', content: '',
      meta: { operationalError: operationalError(`Failed ${at}`, at) } })),
  ];
  assert.deepEqual(chatDiagnostics(messages, 2), { total: 3, entries: [
    { id: 'failure-3', message: 'Failed 3', at: 3 },
    { id: 'failure-2', message: 'Failed 2', at: 2 },
  ] });
  assert.deepEqual(chatDiagnostics(JSON.parse(JSON.stringify(messages))), chatDiagnostics(messages), 'saved diagnostics restore without timers or an active run');
});

test('failed empty responses retain delivered spoken user guidance until fallback history expands it', () => {
  const guidance: VoiceGuidance = { id: 'spoken-note', text: 'Use the smaller file instead.', at: 4,
    contentOffset: 0, status: 'delivered' };
  const visible = [
    { id: 'user', role: 'user' as const, content: 'Inspect the project.' },
    { id: 'empty', role: 'assistant' as const, content: '', meta: { failed: true,
      operationalError: operationalError('Source offline', 5), voiceGuidance: [guidance] } },
    { id: 'next', role: 'user' as const, content: 'Continue.' },
  ];
  const incoming = visibleRequestMessages(visible);
  assert.deepEqual(incoming.map((message) => message.id), ['user', 'empty', 'next']);
  const beforeRecovery = sanitizeConversationRequest(incoming, visible, { preserveVoiceGuidance: true });
  const restored = restoreDeliveredVoiceHistory(beforeRecovery, new Map([['empty', [guidance]]]));
  const modelHistory = sanitizeConversationRequest(restored, visible);
  assert.deepEqual(modelHistory.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: 'Inspect the project.' },
    { role: 'user', content: 'Use the smaller file instead.' },
    { role: 'user', content: 'Continue.' },
  ]);
  assert.ok(!modelHistory.some((message) => message.content.includes('offline')));
});
