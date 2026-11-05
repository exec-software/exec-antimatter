import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChatImport } from '../src/main/chatImports/parsers';

type Json = Record<string, any>;
// Synthetic fixtures follow the official export.ts writer and schema/src/v1/session.ts.
// No local OpenCode conversations, databases, paths, or credentials are read by these tests.
const sessionID = 'ses_fixture';
const part = (messageID: string, id: string, fields: Json): Json => ({ id: `prt_${id}`, sessionID, messageID, ...fields });
const message = (id: string, role: 'user' | 'assistant', parts: Json[], extra: Json = {}): Json => ({
  info: { id, sessionID, role, time: { created: role === 'user' ? 1000 : 2000 }, ...(role === 'assistant' ? { parentID: 'msg_user' } : {}), ...extra }, parts,
});
const fixture = (assistantParts: Json[] = [part('msg_assistant', 'answer', { type: 'text', text: 'Hello.' })]): Json => ({
  info: { id: sessionID, title: 'OpenCode fixture', time: { created: 500, updated: 3000 } },
  messages: [message('msg_user', 'user', [part('msg_user', 'prompt', { type: 'text', text: 'Hi.' })]), message('msg_assistant', 'assistant', assistantParts)],
});
const tool = (id: string, status = 'completed', fields: Json = {}): Json => part('msg_assistant', id, {
  type: 'tool', callID: `call_${id}`, tool: 'bash', state: { status, input: { command: 'echo fixture' }, ...({ completed: { output: 'fixture', time: { start: 2000, end: 2100 }, title: 'Fixture', metadata: {} }, error: { error: 'Fixture error', time: { start: 2000, end: 2100 } }, running: { time: { start: 2000 } }, pending: { raw: '{}' } }[status] ?? {}), ...fields },
});
const parse = (value: Json) => parseChatImport(JSON.stringify(value), 'session.json');

test('OpenCode official session export retains identity and millisecond timestamps', () => {
  const result = parse(fixture());
  const conversation = result.conversations[0];
  assert.equal(conversation.source, 'opencode');
  assert.equal(conversation.format, 'opencode-export');
  assert.equal(conversation.externalId, sessionID);
  assert.equal(conversation.title, 'OpenCode fixture');
  assert.equal(conversation.createdAt, 500);
  assert.equal(conversation.updatedAt, 3000);
  assert.deepEqual(conversation.messages.map((item) => [item.role, item.content, item.meta.createdAt]), [['user', 'Hi.', 1000], ['assistant', 'Hello.', 2000]]);
  assert.equal(conversation.messages[1].meta.sourceName, 'Imported OpenCode history');
  assert.deepEqual(parse(fixture()), result);
});

test('OpenCode preserves interleaved text and tool offsets in exported part order', () => {
  const result = parse(fixture([
    part('msg_assistant', 'before', { type: 'text', text: 'Before.' }), tool('one'),
    part('msg_assistant', 'between', { type: 'text', text: 'Between.' }), tool('two', 'error'),
    part('msg_assistant', 'after', { type: 'text', text: 'After.' }),
  ])).conversations[0].messages[1];
  assert.equal(result.content, 'Before.\n\nBetween.\n\nAfter.');
  assert.deepEqual(result.meta.tools?.map((item) => [item.callId, item.contentOffset, item.status, item.result]), [['call_one', 7, 'done', 'fixture'], ['call_two', 17, 'failed', 'Fixture error']]);
  assert.equal(result.meta.tools?.[0].serverName, 'OpenCode history');
  assert.deepEqual(JSON.parse(result.meta.tools![0].args!), { command: 'echo fixture' });
});

test('OpenCode terminalizes running/pending tools without restoring executable metadata', () => {
  const value = fixture([tool('pending', 'pending'), tool('running', 'running')]);
  Object.assign(value.messages[1].parts[0], { approvalId: 'secret-approval', preview: { url: 'http://never.invalid/' }, metadata: { subagent: 'secret-agent' } });
  const result = parse(value);
  for (const item of result.conversations[0].messages[1].meta.tools!) {
    assert.equal(item.status, 'failed');
    assert.match(item.result!, /unfinished/);
    assert.match(item.caution!, /not executed/);
    for (const key of ['activityId', 'approvalId', 'serverId', 'awaitingApproval', 'preview', 'subagent']) assert.equal(Object.hasOwn(item, key), false);
  }
  assert.ok(result.warnings.some((item) => /will not resume/.test(item)));
  assert.doesNotMatch(JSON.stringify(result), /secret-approval|never\.invalid|secret-agent/);
});

test('OpenCode compacted tool output stays unavailable and interrupted output is historical', () => {
  const result = parse(fixture([
    tool('compacted', 'completed', { output: 'CLEARED_SECRET', time: { start: 2000, end: 2100, compacted: 2200 } }),
    tool('interrupted', 'error', { error: 'Interrupted', metadata: { interrupted: true, output: 'Partial output', sessionId: 'EXECUTABLE_LINK' } }),
  ]));
  const tools = result.conversations[0].messages[1].meta.tools!;
  assert.equal(tools[0].status, 'failed');
  assert.match(tools[0].result!, /compacted/);
  assert.match(tools[1].result!, /Interrupted.*\n.*partial output.*\nPartial output/);
  assert.doesNotMatch(JSON.stringify(result), /CLEARED_SECRET|EXECUTABLE_LINK/);
  assert.ok(result.warnings.some((item) => /Compacted/.test(item)));
});

test('OpenCode media and tool attachments become inert placeholders', () => {
  const image = part('msg_assistant', 'image', { type: 'file', mime: 'image/png', url: 'https://never.invalid/image.png', filename: 'PRIVATE_NAME', source: { path: '/private/path' } });
  const value = fixture([image, tool('media', 'completed', { attachments: [part('msg_assistant', 'attachment', { type: 'file', mime: 'audio/wav', url: 'data:audio/wav;base64,SECRET_BLOB' })] })]);
  const result = parse(value);
  assert.match(result.conversations[0].messages[1].content, /Imported image omitted/);
  assert.match(result.conversations[0].messages[1].meta.tools![0].result!, /tool attachment omitted/);
  assert.doesNotMatch(JSON.stringify(result), /never\.invalid|PRIVATE_NAME|private\/path|SECRET_BLOB/);
  assert.ok(result.warnings.some((item) => /no files or URLs/.test(item)));
});

test('OpenCode omits hidden reasoning, synthetic/ignored text, and configuration authority', () => {
  const value = fixture([
    part('msg_assistant', 'reasoning', { type: 'reasoning', text: 'PRIVATE_REASONING' }),
    part('msg_assistant', 'synthetic', { type: 'text', text: 'PRIVATE_SYNTHETIC', synthetic: true }),
    part('msg_assistant', 'ignored', { type: 'text', text: 'PRIVATE_IGNORED', ignored: true }),
    part('msg_assistant', 'agent', { type: 'agent', name: 'PRIVATE_AGENT' }),
    part('msg_assistant', 'subtask', { type: 'subtask', prompt: 'PRIVATE_SUBTASK', command: 'EXECUTE_ME' }),
    part('msg_assistant', 'compaction', { type: 'compaction', auto: true }),
    part('msg_assistant', 'answer', { type: 'text', text: 'Visible answer.' }),
  ]);
  value.messages[0].info.system = 'PRIVATE_SYSTEM';
  value.messages[0].info.tools = { EXECUTE_ME: true };
  value.info.permission = [{ action: 'allow' }];
  const result = parse(value);
  assert.equal(result.conversations[0].messages[1].content, 'Visible answer.');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|EXECUTE_ME|permission/);
  for (const phrase of [/reasoning/, /synthetic context/, /configuration/]) assert.ok(result.warnings.some((item) => phrase.test(item)));
});

test('OpenCode summary messages are omitted without losing original history', () => {
  const value = fixture();
  value.messages.push(message('msg_summary', 'assistant', [part('msg_summary', 'summary', { type: 'text', text: 'SUMMARY_PROMPT' })], { summary: true }));
  const result = parse(value);
  assert.equal(result.conversations[0].messages.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /SUMMARY_PROMPT/);
  assert.ok(result.warnings.some((item) => /compaction summaries/.test(item)));
});

test('OpenCode unsupported parts warn with placeholders and bookkeeping is not authority', () => {
  const result = parse(fixture([
    part('msg_assistant', 'unknown', { type: 'future-part', instructions: 'HIDDEN_INSTRUCTIONS' }),
    part('msg_assistant', 'patch', { type: 'patch', hash: 'HIDDEN_HASH', files: ['PRIVATE_FILE'] }),
  ]));
  assert.match(result.conversations[0].messages[1].content, /Unsupported imported OpenCode part/);
  assert.doesNotMatch(JSON.stringify(result), /HIDDEN_|PRIVATE_FILE/);
  assert.ok(result.warnings.some((item) => /Unsupported OpenCode/.test(item)));
  assert.ok(result.warnings.some((item) => /workspace changes/.test(item)));
});

test('OpenCode child session and assistant errors are retained without live links', () => {
  const value = fixture();
  value.info.parentID = 'ses_parent_private';
  value.messages[1].info.error = { name: 'APIError', data: { message: 'PRIVATE_PROVIDER_ERROR' } };
  const result = parse(value);
  assert.equal(result.conversations[0].messages[1].meta.failed, true);
  assert.match(result.conversations[0].messages[1].content, /ended with an error/);
  assert.doesNotMatch(JSON.stringify(result), /ses_parent_private|PRIVATE_PROVIDER_ERROR/);
  assert.ok(result.warnings.some((item) => /child session/.test(item)));
});

test('OpenCode rejects unresolved revert rather than restoring undone turns', () => {
  const value = fixture();
  value.info.revert = { messageID: 'msg_user', partID: 'prt_prompt', diff: 'PRIVATE_DIFF' };
  assert.throws(() => parse(value), /unresolved revert/);
});

test('OpenCode rejects incomplete exports, unsupported roles, and missing content', () => {
  const mutations: ((value: Json) => void)[] = [
    (value) => { delete value.info.id; }, (value) => { delete value.info.time; },
    (value) => { value.info.time.created = '2026-09-26'; }, (value) => { delete value.messages; },
    (value) => { delete value.messages[1].info; }, (value) => { delete value.messages[1].parts; },
    (value) => { delete value.messages[1].parts[0].id; }, (value) => { delete value.messages[1].parts[0].text; },
    (value) => { value.messages[1].info.role = 'system'; }, (value) => { value.messages[1].parts[0].ignored = 'false'; },
    (value) => { delete value.messages[1].info.time; },
  ];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => parse(value), /OpenCode/); }
  assert.throws(() => parse({ info: fixture().info, messages: [] }), /no supported/);
});

test('OpenCode rejects ownership mismatches, duplicate IDs, and ambiguous parents', () => {
  const mutations: ((value: Json) => void)[] = [
    (value) => { value.messages[1].info.sessionID = 'ses_other'; },
    (value) => { value.messages[1].parts[0].sessionID = 'ses_other'; },
    (value) => { value.messages[1].parts[0].messageID = 'msg_other'; },
    (value) => { value.messages.push(value.messages[1]); },
    (value) => { value.messages[1].parts.push(value.messages[1].parts[0]); },
    (value) => { delete value.messages[1].info.parentID; },
    (value) => { value.messages[1].info.parentID = 'msg_other'; },
    (value) => { value.messages.reverse(); },
  ];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => parse(value), /OpenCode/); }
});

test('OpenCode keeps mid-turn guidance and an ongoing response to a prior user in exported order', () => {
  const value = fixture();
  value.messages.splice(1, 0, message('msg_guidance', 'user', [part('msg_guidance', 'guidance', { type: 'text', text: 'Additional guidance.' })], { time: { created: 1500 } }));
  value.messages[2].parts.push(part('msg_assistant', 'second-text', { type: 'text', text: 'Second paragraph.' }));
  const result = parse(value);
  assert.deepEqual(result.conversations[0].messages.map((item) => item.content), ['Hi.', 'Additional guidance.', 'Hello.\n\nSecond paragraph.']);
});

test('OpenCode rejects missing, invalid, and duplicate tool state instead of guessing success', () => {
  const mutations: ((value: Json) => void)[] = [
    (value) => { delete value.callID; }, (value) => { delete value.tool; }, (value) => { delete value.state; },
    (value) => { delete value.state.input; }, (value) => { delete value.state.output; },
    (value) => { value.state.status = 'success'; }, (value) => { value.state.attachments = {}; },
    (value) => { value.state.time.compacted = 'yesterday'; },
  ];
  for (const mutate of mutations) { const value = tool('one'); mutate(value); assert.throws(() => parse(fixture([value])), /OpenCode/); }
  const duplicate = tool('two'); duplicate.callID = 'call_one';
  assert.throws(() => parse(fixture([tool('one'), duplicate])), /Duplicate tool call/);
  assert.throws(() => parse(fixture([tool('bad', 'error', { error: null })])), /missing its error/);
});

test('OpenCode respects message, tool, and text limits without truncating', () => {
  const oversized = fixture(); oversized.messages = Array.from({ length: 20_001 }, () => oversized.messages[0]);
  assert.throws(() => parse(oversized), /20,000-message limit/);
  assert.throws(() => parse(fixture(Array.from({ length: 2001 }, (_, index) => tool(String(index))))), /2000-tool import limit/);
  assert.throws(() => parse(fixture([part('msg_assistant', 'huge', { type: 'text', text: 'x'.repeat(16 * 1024 * 1024 + 1) })])), /16 MiB content limit/);
});

test('OpenCode error messages never include malformed private values', () => {
  const value = fixture([tool('one', 'PRIVATE_SECRET_STATUS')]);
  assert.throws(() => parse(value), (error: Error) => /OpenCode/.test(error.message) && !error.message.includes('PRIVATE_SECRET_STATUS'));
});
