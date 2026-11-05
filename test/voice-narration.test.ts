import assert from 'node:assert/strict';
import test from 'node:test';
import { nextVoiceNarration, speakableAssistantText, type VoiceNarrationInput } from '../renderer/src/voiceNarration';

const input = (content: string, fields: Partial<VoiceNarrationInput> = {}): VoiceNarrationInput => ({
  messageId: 'answer-1', role: 'assistant', content, streaming: true, ...fields,
});

test('voice speaks concise prose but never code blocks inline code tools or reasoning', () => {
  const text = speakableAssistantText('Ready to test.\n```bash\nsudo private-command\n```\nUse `privateSymbol()` when needed.\n<think>Private chain reasoning</think>\n<analysis>More private thought</analysis>\n<pre>secret shell output</pre>');
  assert.match(text, /Ready to test/);
  assert.doesNotMatch(text, /sudo|private-command|privateSymbol|reasoning|private thought|shell output/i);
  assert.equal(speakableAssistantText('```json\n{"secret":"value"}\n```'), '');
  assert.equal(speakableAssistantText('<think>still thinking, never closed'), '');
  assert.equal(speakableAssistantText('Hidden thought without opener.</think>Only the answer.'), 'Only the answer.');
  assert.equal(speakableAssistantText('    const secret = "value";\n\nDone.'), 'Done.');
});

test('code and links are stripped and all output remains strictly bounded', () => {
  const text = speakableAssistantText('## Finished\nRead [the notes](https://example.com/private?token=secret).\n![sensitive image](https://example.com/image)');
  assert.match(text, /Read the notes/);
  assert.doesNotMatch(text, /https|token|secret|sensitive image/);
  assert.ok(speakableAssistantText('A very long result '.repeat(1000)).length <= 480);
  assert.ok(speakableAssistantText('word '.repeat(1000), 240).length <= 240);
  assert.equal(speakableAssistantText('x'.repeat(128 * 1024 + 1)), '');
  assert.equal(speakableAssistantText('Words.', -10), '');
});

test('unsealed streaming fragments wait until an authoritative tool anchor arrives', () => {
  // A sentence terminator now seals its own prose, so this has to use text that has none:
  // an unfinished clause is still a fragment and must not be spoken on speculation.
  const partial = nextVoiceNarration(undefined, input('I will inspect the project'));
  assert.deepEqual(partial.utterances, []);
  const waiting = nextVoiceNarration(partial.state, input('I will inspect the project', { tools: [{ contentOffset: 100, status: 'running' }] }));
  assert.deepEqual(waiting.utterances, []);
  const content = 'I will inspect the project';
  const sealed = nextVoiceNarration(waiting.state, input(content, { tools: [{ contentOffset: content.length, status: 'running' }] }));
  assert.deepEqual(sealed.utterances.map((entry) => entry.text), [content]);
  assert.equal(sealed.utterances[0].kind, 'commentary');
  const update = nextVoiceNarration(sealed.state, input(content, { tools: [{ contentOffset: content.length, status: 'done' }] }));
  assert.deepEqual(update.utterances, []);
});

test('commentary and final tail speak once despite repeated tool lifecycle and completion frames', () => {
  const lead = 'I will inspect the project.';
  const first = nextVoiceNarration(undefined, input(lead, { tools: [{ contentOffset: lead.length, status: 'pending' }] }));
  const full = `${lead}\n\nThe fix is ready. All tests pass.`;
  const pending = nextVoiceNarration(first.state, input(full, { streaming: false, tools: [{ contentOffset: lead.length, status: 'running' }] }));
  assert.deepEqual(pending.utterances, []);
  const final = nextVoiceNarration(pending.state, input(full, { streaming: false, tools: [{ contentOffset: lead.length, status: 'done' }] }));
  assert.deepEqual(final.utterances.map((entry) => entry.text), ['The fix is ready. All tests pass.']);
  assert.equal(final.utterances[0].kind, 'final');
  assert.deepEqual(nextVoiceNarration(final.state, input(full, { streaming: false })).utterances, []);
});

test('fences spanning tool anchors cannot leak code on a later span', () => {
  const lead = 'Checking now.\n```bash\n';
  const first = nextVoiceNarration(undefined, input(lead, { tools: [{ contentOffset: lead.length, status: 'running' }] }));
  assert.deepEqual(first.utterances.map((entry) => entry.text), ['Checking now.']);
  const content = lead + 'sudo secret-command\n```\n\nDone safely.';
  const final = nextVoiceNarration(first.state, input(content, { streaming: false, tools: [{ contentOffset: lead.length, status: 'done' }] }));
  assert.deepEqual(final.utterances.map((entry) => entry.text), ['Done safely.']);
});

test('rewritten spoken text suppresses replay but unseen prefixes can safely be replaced', () => {
  const first = nextVoiceNarration(undefined, input('Checking now.', { tools: [{ contentOffset: 13 }] }));
  assert.equal(first.utterances.length, 1);
  const replaced = nextVoiceNarration(first.state, input('Entirely rewritten answer.', { streaming: false }));
  assert.equal(replaced.state.suppressed, true);
  assert.deepEqual(replaced.utterances, []);
  const unseen = nextVoiceNarration(undefined, input('Partial unsaid'));
  const safe = nextVoiceNarration(unseen.state, input('Revised before speech.', { streaming: false }));
  assert.equal(safe.utterances[0]?.text, 'Revised before speech.');
});

test('nonassistant reasoning and failed responses never enter playback', () => {
  for (const fields of [{ role: 'user' }, { role: 'tool' }, { channel: 'analysis' as const }, { channel: 'reasoning' as const }, { failed: true }]) {
    assert.deepEqual(nextVoiceNarration(undefined, input('Never speak this.', { streaming: false, ...fields })).utterances, []);
  }
  const reasoning = nextVoiceNarration(undefined, input('Private hidden reasoning', { channel: 'reasoning' }));
  const final = nextVoiceNarration(reasoning.state, input('Only the answer.', { streaming: false, channel: 'final' }));
  assert.equal(final.utterances[0]?.text, 'Only the answer.');
});

test('tool result and argument payloads cannot be narrated and late anchors do not replay prose', () => {
  const lead = 'First check.';
  const tools = [{ contentOffset: lead.length, status: 'done', result: 'SECRET TOOL OUTPUT', args: 'SECRET ARGUMENTS' }];
  const first = nextVoiceNarration(undefined, input(lead, { tools }));
  assert.deepEqual(first.utterances.map((entry) => entry.text), [lead]);
  const late = nextVoiceNarration(first.state, input(lead, { tools: [...tools, { contentOffset: 5, status: 'done', result: '', args: '' }] }));
  assert.deepEqual(late.utterances, []);
});

test('UTF-16 anchors preserve prose around emoji and commentary count is bounded', () => {
  let content = '';
  const offsets: Array<{ contentOffset: number; status: string }> = [];
  for (let index = 0; index < 10; index++) {
    content += `Check ${index} 🔎 finished.\n`;
    offsets.push({ contentOffset: content.length, status: 'done' });
  }
  const updates = nextVoiceNarration(undefined, input(content, { tools: offsets }));
  assert.equal(updates.utterances.length, 4);
  assert.ok(updates.utterances[0].text.includes('🔎'));
  const final = nextVoiceNarration(updates.state, input(`${content}\nAll work is complete.`, { streaming: false, tools: offsets }));
  assert.deepEqual(final.utterances.map((entry) => entry.text), ['All work is complete.']);
});

test('final-only hydration speaks only the answer tail and legacy anchors use the last paragraph', () => {
  const lead = 'I will inspect files.';
  const content = `${lead}\n\nThe change is complete.`;
  assert.deepEqual(nextVoiceNarration(undefined, input(content, { streaming: false, tools: [{ contentOffset: lead.length, status: 'done' }] })).utterances.map((entry) => entry.text), ['The change is complete.']);
  assert.deepEqual(nextVoiceNarration(undefined, input(content, { streaming: false, tools: [{ status: 'done' }] })).utterances.map((entry) => entry.text), ['The change is complete.']);
});

test('a streaming reply that calls no tools speaks finished sentences instead of waiting for the end', () => {
  // Before sentence flushing, `offsets` came only from tool anchors, so a plain conversational
  // reply emitted nothing at all until completion and then spoke the whole thing at once.
  let step = nextVoiceNarration(undefined, input('Sure, I can help. '));
  assert.deepEqual(step.utterances.map((u) => u.text), ['Sure, I can help.']);
  assert.equal(step.utterances[0]!.kind, 'commentary');

  // A half-written sentence is not a boundary and must stay silent.
  step = nextVoiceNarration(step.state, input('Sure, I can help. Let me chec'));
  assert.deepEqual(step.utterances, []);

  step = nextVoiceNarration(step.state, input('Sure, I can help. Let me check that now. '));
  assert.deepEqual(step.utterances.map((u) => u.text), ['Let me check that now.']);

  // Completion must not replay prose the person already heard.
  const done = nextVoiceNarration(step.state, input('Sure, I can help. Let me check that now.', { streaming: false }));
  assert.deepEqual(done.utterances, []);
});

test('the sentence flush has its own budget, so a long reply does not fall silent after four sentences', () => {
  let step = nextVoiceNarration(undefined, input(''));
  let spoken = 0;
  let content = '';
  for (let i = 1; i <= 8; i += 1) {
    content += `Sentence number ${i} is here. `;
    step = nextVoiceNarration(step.state, input(content));
    spoken += step.utterances.length;
  }
  // MAX_COMMENTARY is 4 and is reserved for tool anchors; flushing must not be capped by it.
  assert.equal(spoken, 8);
  assert.equal(step.state.commentaryCount, 0, 'tool-commentary budget must be untouched');
});

test('a long sentence starts speaking in bounded phrases without truncating or dropping its tail', () => {
  const long = `${'word '.repeat(80).trim()}.`;
  const step = nextVoiceNarration(undefined, input(`${long} `));
  assert.ok(step.utterances.length > 1, 'long sentences no longer wait for full completion');
  assert.ok(step.utterances.every((item) => item.text.length <= 240 && !item.text.endsWith('…')));
  assert.equal(step.utterances.map((item) => item.text).join(' '), long);
  const done = nextVoiceNarration(step.state, input(long, { streaming: false }));
  assert.equal(done.utterances.length, 0, 'completion does not repeat the spoken sentence');
});

test('streaming boundaries wait out decimals, common abbreviations, and unfinished link markup', () => {
  const number = nextVoiceNarration(undefined, input('The version is 3.'));
  assert.deepEqual(number.utterances, []);
  const complete = nextVoiceNarration(number.state, input('The version is 3.5 and Dr. Smith checked it. '));
  assert.deepEqual(complete.utterances.map((item) => item.text), ['The version is 3.5 and Dr. Smith checked it.']);
  assert.deepEqual(nextVoiceNarration(undefined, input('Read [Private target. ')).utterances, []);
});

test('reasoning and code are still never spoken by the sentence flush', () => {
  const step = nextVoiceNarration(undefined, input('<think>Private deliberation here.</think>Public answer. '));
  assert.deepEqual(step.utterances.map((u) => u.text), ['Public answer.']);
  const code = nextVoiceNarration(undefined, input('```bash\nsudo rm -rf /tmp/x.\n```\n'));
  assert.deepEqual(code.utterances, []);
});
