import assert from 'node:assert/strict';
import test from 'node:test';

import type { Message, ToolDefinition } from '../src/api/types';
import {
  compactionDigest,
  compactionNotice,
  conversationTokens,
  fitToBudget,
  fitWithCompactionNotice,
  isCompactionNotice,
  promptBudget,
  toolDefinitionTokens,
} from '../src/main/context';
import type { ModelProfile } from '../src/main/modelProfiles';

const profile: ModelProfile = {
  modelId: 'test',
  contextTokens: 10_000,
  maxOutputTokens: 1_000,
  contextSource: 'override',
  outputSource: 'override',
  compaction: 'summarize',
};

const definition = (description: string): ToolDefinition => ({
  type: 'function',
  function: {
    name: 'run_command',
    description,
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command to run.' } },
      required: ['command'],
    },
  },
});

test('prompt budget reserves the actual serialized tool definitions', () => {
  const small = [definition('Run one command.')];
  const large = [definition('Run one command.'.repeat(400)), definition('Read one file.'.repeat(400))];

  assert.ok(toolDefinitionTokens(large) > toolDefinitionTokens(small));
  assert.ok(promptBudget(profile, large) < promptBudget(profile, small));
  assert.equal(
    promptBudget(profile, large),
    Math.max(512, Math.floor((profile.contextTokens - profile.maxOutputTokens - toolDefinitionTokens(large)) * 0.9))
  );
});

test('C128 prompt estimates reserve output without the ordinary 512-token floor', () => {
  const capped = { ...profile, contextTokens: 128, maxEvaluatedTokens: 128, maxOutputTokens: 32 };
  assert.equal(promptBudget(capped, []), 86);
  assert.equal(promptBudget(capped, false), 86);
  assert.equal(promptBudget(capped, true), 86, 'legacy boolean tools do not claim serialized size');
  assert.equal(promptBudget({ ...capped, contextTokens: 8_192 }, []), 86, 'the server cap also bounds stale larger windows');
  assert.equal(promptBudget({ ...capped, contextTokens: 64 }, []), 28);
  assert.equal(promptBudget({ ...capped, maxOutputTokens: 127 }, []), 0);
  assert.equal(promptBudget({ ...capped, maxOutputTokens: 128 }, []), 0);
  assert.equal(promptBudget({ ...capped, maxOutputTokens: 129 }, []), 0);
  assert.equal(promptBudget({ ...capped, contextTokens: 1, maxEvaluatedTokens: 1, maxOutputTokens: 1 }, []), 0);
});

test('capped budgets account for actual tool definitions and expose mandatory overflow', () => {
  const capped = { ...profile, contextTokens: 128, maxEvaluatedTokens: 128, maxOutputTokens: 32 };
  const tools = [definition('Run one command.')];
  const expected = Math.max(0, Math.floor((128 - 32 - toolDefinitionTokens(tools)) * 0.9));
  assert.equal(promptBudget(capped, tools), expected);
  assert.ok(expected < promptBudget(capped, []));
  const budget = promptBudget(capped, [definition('Large tool instructions. '.repeat(100))]);
  assert.equal(budget, 0);
  const mandatory: Message[] = [
    { id: 'system', role: 'system', content: 'Keep the safety instructions.' },
    { id: 'current', role: 'user', content: 'Answer this request.' },
  ];
  const fit = fitToBudget(mandatory, budget);
  assert.deepEqual(fit.messages, mandatory);
  assert.equal(fit.overflowTokens, conversationTokens(mandatory));
  assert.ok(fit.overflowTokens > 0);
});

test('absent or malformed execution caps preserve the uncapped prompt budget', () => {
  const small = { ...profile, contextTokens: 128, maxOutputTokens: 32 };
  for (const cap of [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(promptBudget({ ...small, maxEvaluatedTokens: cap }, []), 512);
  }
  assert.equal(promptBudget(profile, []), 8_100);
});

const toolCall = (id: string) => ({
  id,
  type: 'function' as const,
  function: { name: 'antimatter__read_file', arguments: '{"path":"README.md"}' },
});

test('fit keeps a multi-call assistant request paired with all of its tool results', () => {
  const head: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Do the work.' },
  ];
  const exchange: Message[] = [
    { id: 'calls', role: 'assistant', content: '', toolCalls: [toolCall('a'), toolCall('b')] },
    { id: 'a', role: 'tool', toolCallId: 'a', name: 'read_file', content: 'first result' },
    { id: 'b', role: 'tool', toolCallId: 'b', name: 'read_file', content: 'second result' },
  ];
  const messages: Message[] = [
    ...head,
    { id: 'old', role: 'user', content: 'old '.repeat(2_000) },
    ...exchange,
  ];
  const budget = conversationTokens([...head, ...exchange]);
  const fit = fitToBudget(messages, budget);

  assert.deepEqual(fit.messages.map((message) => message.id), ['system', 'task', 'calls', 'a', 'b']);
  assert.equal(fit.estimatedTokens, conversationTokens(fit.messages));
  assert.equal(fit.overflowTokens, 0);
});

test('a preferred four-message tail never forces the fitted request over budget', () => {
  const head: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Do the work.' },
  ];
  const last: Message = { id: 'latest', role: 'assistant', content: 'latest result' };
  const messages: Message[] = [
    ...head,
    { id: 'one', role: 'user', content: 'one '.repeat(800) },
    { id: 'two', role: 'assistant', content: 'two '.repeat(800) },
    { id: 'three', role: 'user', content: 'three '.repeat(800) },
    last,
  ];
  const budget = conversationTokens([...head, last]);
  const fit = fitToBudget(messages, budget);

  assert.deepEqual(fit.messages.map((message) => message.id), ['system', 'task', 'latest']);
  assert.equal(fit.minimumRecentMet, false);
  assert.ok(fit.estimatedTokens <= budget);
});

test('an opening that cannot fit is preserved and reports its unavoidable overflow', () => {
  const messages: Message[] = [
    { id: 'system', role: 'system', content: 'system '.repeat(300) },
    { id: 'task', role: 'user', content: 'task '.repeat(300) },
  ];
  const fit = fitToBudget(messages, 32);

  assert.deepEqual(fit.messages, messages);
  assert.equal(fit.estimatedTokens, conversationTokens(messages));
  assert.equal(fit.overflowTokens, fit.estimatedTokens - 32);
});

test('the newest complete group is never silently dropped to satisfy the budget', () => {
  const messages: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Build it.' },
    { id: 'old', role: 'assistant', content: 'old '.repeat(1_000) },
    { id: 'current', role: 'user', content: 'current '.repeat(1_000) },
  ];
  const budget = conversationTokens(messages.slice(0, 2));
  const fit = fitToBudget(messages, budget);

  assert.deepEqual(fit.messages.map((message) => message.id), ['system', 'task', 'current']);
  assert.ok(fit.overflowTokens > 0);
  assert.equal(fit.estimatedTokens, conversationTokens(fit.messages));
});

test('a previous compaction summary stays in the preserved opening', () => {
  const summary = compactionNotice(20, 'The project was scaffolded and tests passed.');
  const messages: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Build it.' },
    summary,
    { id: 'old', role: 'assistant', content: 'old '.repeat(1_000) },
    { id: 'latest', role: 'user', content: 'Continue.' },
  ];
  const budget = conversationTokens([messages[0], messages[1], summary, messages[4]]);
  const fit = fitToBudget(messages, budget);

  assert.ok(fit.messages.includes(summary));
  assert.equal(fit.headCount, 3);
});

test('accumulated summaries stay bounded and cannot crowd out the current request', () => {
  const summaries = Array.from({ length: 20 }, (_, index) =>
    compactionNotice(5, `summary ${index} `.repeat(20))
  );
  const messages: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Build it.' },
    ...summaries,
    { id: 'old', role: 'assistant', content: 'old '.repeat(2_000) },
    { id: 'latest', role: 'user', content: 'Apply the current correction.' },
  ];
  const budget = conversationTokens([messages[0], messages[1], summaries.at(-1)!, messages.at(-1)!]);
  const fit = fitToBudget(messages, budget);

  assert.ok(fit.messages.some((message) => message.id === 'latest'));
  assert.ok(fit.messages.filter(isCompactionNotice).length <= 1);
  assert.equal(fit.overflowTokens, 0);
  assert.ok(fit.estimatedTokens <= budget);
});

test('an optional summary cannot push a compacted request back over budget', () => {
  const messages: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Build it.' },
    { id: 'old', role: 'assistant', content: 'old '.repeat(2_000) },
    { id: 'recent-user', role: 'user', content: 'Continue.' },
    { id: 'recent-answer', role: 'assistant', content: 'Working.' },
  ];
  const generic = compactionNotice(1);
  const budget = conversationTokens([messages[0], messages[1], generic, messages[3], messages[4]]);
  const fit = fitWithCompactionNotice(messages, budget, 'oversized summary '.repeat(1_000));

  assert.equal(fit.overflowTokens, 0);
  assert.ok(fit.estimatedTokens <= budget);
  assert.ok(fit.messages.some((message) => isCompactionNotice(message)));
  assert.equal(fit.messages.some((message) => message.content.includes('oversized summary')), false);
});

test('a summary that displaces real tail history falls back to the smaller generic marker', () => {
  const recent: Message[] = [
    { id: 'recent-1', role: 'user', content: 'one '.repeat(40) },
    { id: 'recent-2', role: 'assistant', content: 'two '.repeat(40) },
    { id: 'recent-3', role: 'user', content: 'three '.repeat(40) },
  ];
  const messages: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Build it.' },
    { id: 'old', role: 'assistant', content: 'old '.repeat(2_000) },
    ...recent,
  ];
  const generic = compactionNotice(1);
  const budget = conversationTokens([messages[0], messages[1], generic, ...recent]);
  const fit = fitWithCompactionNotice(messages, budget, 'SUMMARY '.repeat(50));

  assert.deepEqual(
    fit.messages.filter((message) => message.id.startsWith('recent-')).map((message) => message.id),
    recent.map((message) => message.id)
  );
  assert.ok(fit.messages.some((message) => isCompactionNotice(message)));
  assert.equal(fit.messages.some((message) => message.content.includes('SUMMARY SUMMARY')), false);
  assert.equal(fit.overflowTokens, 0);
});

test('a later compaction consolidates earlier summaries and keeps marker ids unique', () => {
  const old = compactionNotice(20, 'IMPORTANT SUMMARY');
  const messages: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Build it.' },
    old,
    { id: 'old', role: 'assistant', content: 'old '.repeat(2_000) },
    { id: 'latest', role: 'user', content: 'Continue.' },
  ];
  const consolidated = 'IMPORTANT SUMMARY; NEW SUMMARY';
  const newMarker = compactionNotice(1, consolidated);
  const budget = conversationTokens([messages[0], messages[1], old, newMarker, messages[4]]);
  const fit = fitWithCompactionNotice(messages, budget, consolidated);
  const notices = fit.messages.filter(isCompactionNotice);

  assert.equal(notices.length, 1);
  assert.notEqual(notices[0].id, old.id);
  assert.match(notices[0].content, /IMPORTANT SUMMARY; NEW SUMMARY/);
  assert.equal(new Set(fit.messages.map((message) => message.id)).size, fit.messages.length);
  assert.equal(fit.overflowTokens, 0);
});

test('a compaction marker is omitted when the mandatory opening leaves it no room', () => {
  const opening: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Build it.' },
  ];
  const latest: Message = { id: 'latest', role: 'user', content: 'Continue.' };
  const fit = fitWithCompactionNotice(
    [...opening, { id: 'old', role: 'assistant', content: 'old '.repeat(2_000) }, latest],
    conversationTokens([...opening, latest])
  );

  assert.deepEqual(fit.messages, [...opening, latest]);
  assert.equal(fit.compacted, 1);
  assert.equal(fit.overflowTokens, 0);
});

test('an optional summary never displaces the latest user request', () => {
  const messages: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Build it.' },
    { id: 'old', role: 'assistant', content: 'old '.repeat(2_000) },
    { id: 'latest', role: 'user', content: 'Please make this exact final adjustment. '.repeat(8) },
  ];
  const generic = compactionNotice(1);
  const budget = conversationTokens([messages[0], messages[1], generic, messages[3]]);
  const fit = fitWithCompactionNotice(messages, budget, 'S'.repeat(100));

  assert.ok(fit.messages.some((message) => message.id === 'latest'));
  assert.equal(fit.overflowTokens, 0);
  assert.equal(fit.messages.some((message) => message.content.includes('S'.repeat(100))), false);
});

test('a generic marker never displaces the latest fitted protocol group', () => {
  const messages: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Build it.' },
    { id: 'old', role: 'assistant', content: 'old '.repeat(2_000) },
    { id: 'latest', role: 'user', content: 'Continue.' },
  ];
  const budget = conversationTokens([messages[0], messages[1], messages[3]]);
  const fit = fitWithCompactionNotice(messages, budget);

  assert.deepEqual(fit.messages.map((message) => message.id), ['system', 'task', 'latest']);
  assert.equal(fit.compacted, 1);
  assert.equal(fit.overflowTokens, 0);
});

const call = (name: string, args: Record<string, unknown>) => ({
  id: `call_${name}`,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

test('a digest names the calls leaving the window, so their effect is not read as undone', () => {
  const digest = compactionDigest([
    {
      id: 'a',
      role: 'assistant',
      content: 'Pulling the SDK down.',
      toolCalls: [call('run_command', { command: 'git clone https://github.com/steinbergmedia/vst3sdk.git vst3sdk' })],
    },
    { id: 'r', role: 'tool', toolCallId: 'call_run_command', content: 'Cloning into vst3sdk...' },
    {
      id: 'b',
      role: 'assistant',
      content: 'Checking it.',
      toolCalls: [call('list_directory', { path: '/home/u/beatinary/vst3sdk' })],
    },
  ]);

  assert.ok(digest);
  assert.match(digest!, /run_command git clone https:\/\/github\.com\/steinbergmedia\/vst3sdk\.git vst3sdk/);
  assert.match(digest!, /list_directory \/home\/u\/beatinary\/vst3sdk/);
  assert.match(digest!, /before concluding that work described here was never done/);
});

test('a digest carries the account the marker it replaces already held', () => {
  const first = compactionDigest([
    { id: 'a', role: 'assistant', content: '', toolCalls: [call('run_command', { command: 'git clone sdk' })] },
  ]);
  const second = compactionDigest([
    compactionNotice(4, first),
    { id: 'b', role: 'assistant', content: '', toolCalls: [call('write_file', { path: 'src/plugin.cpp' })] },
  ]);

  assert.ok(second);
  assert.match(second!, /run_command git clone sdk/);
  assert.match(second!, /write_file src\/plugin\.cpp/);
  assert.equal(second!.match(/never done/g)?.length, 1, 'the advisory is stated once, not once per generation');
});

test('a model-written summary survives being replaced by a digest', () => {
  const carried = compactionDigest([
    compactionNotice(6, 'The SDK is cloned into vst3sdk and CMake is configured.'),
    { id: 'b', role: 'assistant', content: '', toolCalls: [call('read_file', { path: 'CMakeLists.txt' })] },
  ]);

  assert.ok(carried);
  assert.match(carried!, /The SDK is cloned into vst3sdk and CMake is configured\./);
  assert.match(carried!, /read_file CMakeLists\.txt/);
});

test('a digest of nothing but prose-only turns is no digest at all', () => {
  assert.equal(compactionDigest([{ id: 'a', role: 'assistant', content: 'Thinking about it.' }]), undefined);
  assert.equal(compactionDigest([]), undefined);
});

test('a long turn cannot grow its digest without bound', () => {
  const many: Message[] = Array.from({ length: 200 }, (_, index) => ({
    id: `a${index}`,
    role: 'assistant',
    content: '',
    toolCalls: [call('read_file', { path: `file-${index}.ts` })],
  }));
  const digest = compactionDigest(many)!;

  assert.ok(digest.split('\n').filter((line) => line.startsWith('- ')).length <= 24);
  assert.match(digest, /\(and 176 earlier calls not listed\)/);
  // Both ends survive, and the elision sits between them.
  //
  // This used to keep only the newest calls, on the reasoning that they are the
  // work still being built on. That is true and it is not sufficient: a long
  // session lost track of which directory it was working in, because the calls
  // that established the ground had aged out while the recent ones only showed
  // where the conversation had drifted. The oldest calls say where the work
  // lives; the newest say what it is doing. Keeping one end loses the other.
  assert.match(digest, /file-199\.ts/);
  assert.match(digest, /file-0\.ts/);
  const lines = digest.split('\n');
  const gap = lines.findIndex((line) => line.startsWith('(and 176 earlier'));
  const oldest = lines.findIndex((line) => line.includes('file-0.ts'));
  const newest = lines.findIndex((line) => line.includes('file-199.ts'));
  assert.ok(oldest < gap && gap < newest, 'the elision belongs between the ends it separates');
  // The middle is what goes: neither end should reach halfway through the span.
  assert.equal(digest.includes('file-100.ts'), false);
});

test('the oldest calls survive repeated compaction, not just the first', () => {
  // The reported failure was a two-hour session, which compacts many times. A
  // digest that preserved its oldest end only on the first pass would lose the
  // ground on the second, so the carry-forward has to be cumulative at both
  // ends rather than only at the recent one.
  const span = (from: number, count: number): Message[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `a${from + index}`,
      role: 'assistant' as const,
      content: '',
      toolCalls: [call('edit_file', { path: `project/file-${from + index}.ts` })],
    }));

  let marker = compactionNotice(60, compactionDigest(span(0, 60)));
  for (let round = 1; round <= 5; round += 1) {
    marker = compactionNotice(60, compactionDigest([marker, ...span(round * 60, 60)]));
  }

  // 360 calls later, the first file is still named.
  assert.match(marker.content, /project\/file-0\.ts/);
  // And so is the most recent.
  assert.match(marker.content, /project\/file-359\.ts/);
  assert.ok(marker.content.split('\n').filter((line) => line.startsWith('- ')).length <= 24);
});

test('the gap marker is worth one more old exchange, but never worth overflowing', () => {
  const messages: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Build the plugin.' },
    { id: 'old', role: 'assistant', content: 'old '.repeat(400) },
    { id: 'middle', role: 'assistant', content: 'middle '.repeat(40) },
    { id: 'latest', role: 'user', content: 'Carry on.' },
  ];
  // Room for the opening, the middle exchange and the request — and nothing else. A marker can
  // only be had by giving up `middle`, which is the trade this makes.
  const budget = conversationTokens([messages[0], messages[1], messages[3], messages[4]]);
  const fit = fitWithCompactionNotice(messages, budget);

  assert.ok(fit.messages.some(isCompactionNotice), 'a silent gap is read as work that never happened');
  assert.ok(fit.messages.some((entry) => entry.id === 'latest'));
  assert.equal(fit.overflowTokens, 0);
  assert.equal(fit.messages.some((entry) => entry.id === 'middle'), false);
});

test('compaction leaves headroom, so the turns after it reuse the same prefix', () => {
  // Why this matters: a local engine reuses the prompt it has already processed only while the
  // next prompt starts the same way. Trimming to the brim means the next turn folds again and
  // the match ends at the fold, so every turn pays a full reprocess. Measured on this box:
  // 15,024 tokens came back in 0.5s unchanged, against 62.4s cold.
  const turn = (index: number): Message[] => [
    { id: `u${index}`, role: 'user', content: `question ${index} `.repeat(40) },
    { id: `a${index}`, role: 'assistant', content: `answer ${index} `.repeat(40) },
  ];
  const opening: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Build it.' },
  ];
  let conversation = [...opening, ...Array.from({ length: 40 }, (_, i) => turn(i)).flat()];
  const budget = Math.floor(conversationTokens(conversation) * 0.6);

  const first = fitToBudget(conversation, budget);
  assert.ok(first.compacted > 0, 'the conversation did not fit, so it was compacted');
  assert.ok(first.estimatedTokens <= budget, 'and it fits now');

  // The prefix an engine would cache: everything up to the newest exchange.
  const prefixOf = (messages: Message[]) => messages.slice(0, -2).map((message) => message.id).join(',');
  const settled = prefixOf(first.messages);

  // Carry on. Each turn appends, as a conversation does, and must not force another fold.
  let reused = 0;
  conversation = first.messages;
  for (let next = 40; next < 44; next += 1) {
    conversation = [...conversation, ...turn(next)];
    const fit = fitToBudget(conversation, budget);
    if (fit.compacted === 0 && prefixOf(fit.messages).startsWith(settled)) reused += 1;
    conversation = fit.messages;
  }
  assert.ok(reused >= 2, `expected several turns to reuse the compacted prefix, got ${reused}`);
});

test('headroom is taken from old context, never from the recent tail', () => {
  const recent: Message[] = [
    { id: 'r1', role: 'user', content: 'one' },
    { id: 'r2', role: 'assistant', content: 'two' },
    { id: 'r3', role: 'user', content: 'three' },
    { id: 'r4', role: 'assistant', content: 'four' },
  ];
  const messages: Message[] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Build it.' },
    { id: 'old', role: 'assistant', content: 'old '.repeat(4_000) },
    ...recent,
  ];
  // A budget that fits the opening and the whole recent tail, and nothing more.
  const budget = conversationTokens([messages[0], messages[1], ...recent]);
  const fit = fitToBudget(messages, budget);
  assert.deepEqual(
    fit.messages.filter((message) => message.id.startsWith('r')).map((message) => message.id),
    recent.map((message) => message.id),
    'the preferred tail survives even though it uses more than the compaction target'
  );
  assert.equal(fit.minimumRecentMet, true);
  assert.equal(fit.overflowTokens, 0);
});
