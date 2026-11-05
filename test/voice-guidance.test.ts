import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageBody } from '../renderer/src/components/chat/MessageBody';
import { buildVoiceTranscriptParts, mergeVoiceGuidance, settleRestoredVoiceGuidance, voiceGuidanceStatusLabel, type VoiceTranscriptPart } from '../renderer/src/lib/conversationVoice';
import { buildTranscriptParts } from '../renderer/src/lib/transcript';
import type { ToolActivity, VoiceGuidance } from '../renderer/src/types';

const guidance = (id: string, contentOffset: number, extra: Partial<VoiceGuidance> = {}): VoiceGuidance => ({
  id, text: `Guidance ${id}`, at: 10, contentOffset, status: 'queued', ...extra,
});
const tool = (callId: string, contentOffset?: number): ToolActivity => ({
  callId, requestId: 'answer', serverId: 'tools', serverName: 'Tools', toolName: 'read_file',
  args: '{}', tier: 'read', status: 'done', contentOffset,
});
const simple = (parts: VoiceTranscriptPart[]) => parts.map((part) => part.kind === 'text' ? ['text', part.text]
  : part.kind === 'voice' ? ['voice', part.guidance.id, part.offset, part.guidance.status]
  : ['tools', part.tools.map((entry) => entry.callId), part.offset]);

test('voice guidance interleaves prose and tools at exact anchors without extra message rows', () => {
  const parts = buildVoiceTranscriptParts('Before.After.Done.', [tool('read', 7), tool('write', 13)], [guidance('change', 10)]);
  assert.deepEqual(simple(parts), [
    ['text', 'Before.'], ['tools', ['read'], 7], ['text', 'Aft'], ['voice', 'change', 10, 'queued'],
    ['text', 'er.'], ['tools', ['write'], 13], ['text', 'Done.'],
  ]);
  assert.equal(parts.filter((part) => part.kind === 'text').map((part) => part.text).join(''), 'Before.After.Done.');
});

test('same-offset guidance follows in-flight tool and preserves first-received utterance order', () => {
  const parts = buildVoiceTranscriptParts('Working.Answer.', [tool('read', 8), tool('list', 8)], [guidance('a', 8), guidance('b', 8)]);
  assert.deepEqual(simple(parts), [
    ['text', 'Working.'], ['tools', ['read', 'list'], 8], ['voice', 'a', 8, 'queued'], ['voice', 'b', 8, 'queued'], ['text', 'Answer.'],
  ]);
});

test('guidance acknowledgement cannot duplicate move overwrite or regress a delivered utterance', () => {
  const first = guidance('one', 5, { text: 'Please include tests.', at: 7 });
  const queued = mergeVoiceGuidance([], first);
  const delivered = mergeVoiceGuidance(queued, guidance('one', 99, { text: 'Changed echo.', at: 99, status: 'delivered' }));
  assert.deepEqual(delivered, [{ ...first, status: 'delivered' }]);
  assert.deepEqual(mergeVoiceGuidance(delivered, first), delivered);
  assert.deepEqual(mergeVoiceGuidance(delivered, { ...first, status: 'undelivered' }), delivered);
  assert.equal(queued[0].status, 'queued', 'merge is immutable');
  assert.equal(mergeVoiceGuidance([{ ...first, status: 'undelivered' }], { ...first, status: 'delivered' })[0].status, 'delivered');
});

test('restored queues are explicitly unconfirmed and never appear to be live approvals', () => {
  const restored = settleRestoredVoiceGuidance([guidance('a', 0), guidance('b', 0, { status: 'delivered' })]);
  assert.deepEqual(restored.map((entry) => entry.status), ['undelivered', 'delivered']);
  assert.equal(voiceGuidanceStatusLabel('queued', true), 'Queued for next step');
  assert.equal(voiceGuidanceStatusLabel('queued', false), 'Delivery not confirmed');
  assert.equal(voiceGuidanceStatusLabel('undelivered', true), 'Delivery not confirmed');
  assert.equal(voiceGuidanceStatusLabel('delivered', false), 'Delivered to agent');
});

test('future anchors retain relative chronology until late text arrives including UTF-16 emoji', () => {
  const items = [guidance('later', 12), guidance('earlier', 8)];
  const short = buildVoiceTranscriptParts('A🔎', [tool('middle', 10)], items);
  assert.deepEqual(simple(short), [
    ['text', 'A🔎'], ['voice', 'earlier', 3, 'queued'], ['tools', ['middle'], 3], ['voice', 'later', 3, 'queued'],
  ]);
  const content = 'A🔎 and some more.';
  const complete = buildVoiceTranscriptParts(content, [tool('middle', 10)], items);
  assert.equal(complete.filter((part) => part.kind === 'text').map((part) => part.text).join(''), content);
  assert.equal(items[0].contentOffset, 12, 'display clamping must not mutate authoritative anchor');
  assert.equal(complete.filter((part) => part.kind === 'voice')[0].offset, 8);
});

test('duplicate metadata ids collapse while original guidance text remains inert user text', () => {
  const literal = '<script>bad()</script> [Approve](permission://all)';
  const parts = buildVoiceTranscriptParts('Answer', [], [guidance('a', 0, { text: literal }), guidance('a', 9, { status: 'delivered' })]);
  assert.deepEqual(simple(parts), [['voice', 'a', 0, 'delivered'], ['text', 'Answer']]);
  assert.equal(parts[0].kind === 'voice' && parts[0].guidance.text, literal);
});

test('malformed guidance is ignored and retained event count is bounded', () => {
  const bad: Partial<VoiceGuidance>[] = [{ id: '' }, { text: '' }, { text: 'x'.repeat(12_001) }, { contentOffset: -1 }, { contentOffset: 0.5 }, { contentOffset: NaN }, { at: Infinity }, { status: 'approved' as never }];
  for (const extra of bad) {
    assert.deepEqual(buildVoiceTranscriptParts('Answer', [], [guidance('bad', 0, extra)]), buildTranscriptParts('Answer'));
  }
  const many = Array.from({ length: 270 }, (_, index) => guidance(`v${index}`, 0));
  const bounded = many.reduce<VoiceGuidance[]>((entries, entry) => mergeVoiceGuidance(entries, entry), []);
  assert.equal(bounded.length, 256);
  assert.equal(mergeVoiceGuidance(bounded, { ...bounded[255], status: 'delivered' })[255].status, 'delivered');
});

test('ordinary turns and legacy tool grouping remain unchanged', () => {
  const tools = [tool('positioned', 3), tool('legacy')];
  assert.deepEqual(buildVoiceTranscriptParts('Answer', tools), buildTranscriptParts('Answer', tools));
  const parts = buildVoiceTranscriptParts('Answer', tools, [guidance('a', 4)]);
  const last = parts.at(-1);
  assert.equal(last?.kind === 'tools' && last.legacy, true);
  assert.equal(parts.filter((part) => part.kind === 'text').map((part) => part.text).join(''), 'Answer');
});

test('transcript renders spoken guidance visibly as escaped human text without authorization controls', () => {
  const markup = renderToStaticMarkup(createElement(MessageBody, {
    isActive: false,
    message: {
      id: 'answer', role: 'assistant', content: 'Before.After.',
      meta: { createdAt: 1, voiceGuidance: [guidance('speech', 7, { text: '<script>bad()</script> [Approve](permission://all)' })] },
    },
  }));
  assert.match(markup, /aria-label="Your spoken guidance"/);
  assert.match(markup, /You · voice/);
  assert.match(markup, /Delivery not confirmed/);
  assert.match(markup, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script|href="permission|<button[^>]*>Approve/);
  assert.ok(markup.indexOf('Before.') < markup.indexOf('Your spoken guidance'));
  assert.ok(markup.indexOf('Your spoken guidance') < markup.indexOf('After.'));
});
