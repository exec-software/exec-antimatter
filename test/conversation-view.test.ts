import assert from 'node:assert/strict';
import test from 'node:test';
import {
  carbonActions,
  conversationOutputs,
  conversationPreviews,
  conversationSources,
  conversationSubagents,
  previewIdentity,
  sittingLabel,
  splitPath,
  splitWork,
  startsSitting,
  subagentPhase,
  unfinishedSubagents,
} from '../renderer/src/lib/conversation';
import { buildTranscriptParts, toolActivitySummary } from '../renderer/src/lib/transcript';
import type { Message, ToolActivity } from '../renderer/src/types';

const call = (toolName: string, args: Record<string, unknown>, overrides: Partial<ToolActivity> = {}): ToolActivity => ({
  callId: `${toolName}-${JSON.stringify(args)}`,
  requestId: 'reply',
  serverId: 'antimatter',
  serverName: 'Antimatter tools',
  toolName,
  tier: 'write',
  args: JSON.stringify(args),
  status: 'done',
  ...overrides,
});

const reply = (id: string, createdAt: number, tools: ToolActivity[], content = ''): Message => ({
  id,
  role: 'assistant',
  content,
  meta: { createdAt, tools },
});

const asked = (id: string, createdAt: number, extra: Partial<Message> = {}): Message => ({
  id,
  role: 'user',
  content: 'do it',
  meta: { createdAt },
  ...extra,
});

test('outputs are the files the conversation wrote, newest first, each once', () => {
  const messages = [
    asked('u1', 1),
    reply('a1', 2, [
      call('write_file', { path: 'src/editor.py' }),
      call('write_file', { path: 'notes.md' }, { status: 'failed' }),
      call('read_file', { path: 'README.md' }, { tier: 'read' }),
    ]),
    asked('u2', 3),
    reply('a2', 4, [
      call('edit_file', { path: 'src/editor.py' }),
      call('write_file', { path: 'tests/test_editor.py' }, { status: 'denied' }),
      call('coding_write_file', { path: 'docs/usage.md' }),
    ]),
  ];

  // A failed or refused write left nothing behind, and a read is not an output.
  assert.deepEqual(conversationOutputs(messages), [
    { path: 'docs/usage.md', at: 4, edited: false },
    { path: 'src/editor.py', at: 4, edited: true },
  ]);

  // Touching an older file again makes it the newest, wherever it was first written.
  const again = [...messages, asked('u3', 5), reply('a3', 6, [call('edit_file', { path: 'src/editor.py' })])];
  assert.deepEqual(conversationOutputs(again).map((output) => output.path), ['src/editor.py', 'docs/usage.md']);
});

test('same-named previews stay distinct across workspaces and share the exact open identity', () => {
  const preview = (activityId: string, workspace: string, title: string): ToolActivity =>
    call('preview_image', { path: 'shot.png' }, {
      activityId,
      preview: { kind: 'image', target: 'shot.png', title, workspace },
    });
  const messages = [
    reply('a1', 1, [preview('a-first', '/workspace/a', 'A old')]),
    reply('a2', 2, [preview('b', '/workspace/b', 'B')]),
    reply('a3', 3, [preview('a-new', '/workspace/a', 'A new')]),
  ];

  const previews = conversationPreviews(messages);
  assert.deepEqual(
    previews.map(({ id, workspace, title }) => ({ id, workspace, title })),
    [
      { id: 'a3:a-new', workspace: '/workspace/a', title: 'A new' },
      { id: 'a2:b', workspace: '/workspace/b', title: 'B' },
    ]
  );
  assert.notEqual(previewIdentity(previews[0]), previewIdentity(previews[1]));
});

test('preview component ids stay distinct when a provider reuses a call id in later turns', () => {
  const preview = (target: string): ToolActivity =>
    call('preview_image', { path: target }, {
      activityId: '0:0:provider-call-0',
      preview: { kind: 'image', target, title: target, workspace: '/workspace' },
    });
  const previews = conversationPreviews([
    reply('turn-one', 1, [preview('first.png')]),
    reply('turn-two', 2, [preview('second.png')]),
  ]);

  assert.equal(new Set(previews.map((entry) => entry.id)).size, 2);
  assert.deepEqual(previews.map((entry) => entry.id), [
    'turn-two:0:0:provider-call-0',
    'turn-one:0:0:provider-call-0',
  ]);
});

const explorer = { taskId: 't1', agentId: 'explorer', agentName: 'Explorer', title: 'Map it' };
const reviewer = { taskId: 't2', agentId: 'security-reviewer', agentName: 'Security reviewer', title: 'Review it' };

test('subagents are listed in the order they were started, once they exist', () => {
  // Started, and returned at once: the call is done, the run is not.
  const working = call('start_agent', { agent: 'explorer', task: 'Map it.' }, {
    tier: 'read',
    result: 'Started Explorer on "Map it" as task t1.',
    subagent: explorer,
  });
  const finished = call('start_agent', { agent: 'security-reviewer', task: 'Review it.' }, {
    tier: 'read',
    result: 'Security reviewer finished "Review it".\n\nNothing found.',
    subagent: { ...reviewer, finished: true },
  });
  // The main process never started this one: there was no such agent.
  const refused = call('start_agent', { agent: 'gimp-builder', task: 'Build it.' }, { tier: 'read', status: 'failed' });
  // Where the reviewer's report reached the model. It is the same agent, not another one.
  const heard = call('agent_report', { agent: 'security-reviewer' }, { tier: 'read', subagent: { ...reviewer, finished: true } });

  const subagents = conversationSubagents([asked('u', 1), reply('a', 2, [finished, refused, working, heard])]);
  assert.deepEqual(subagents, [
    { ...reviewer, finished: true, messageId: 'a', status: 'done', report: 'Security reviewer finished "Review it".\n\nNothing found.' },
    { ...explorer, finished: false, messageId: 'a', status: 'done', report: null },
  ]);
  assert.deepEqual(unfinishedSubagents([finished, refused, working, heard]), [explorer]);
});

test('a conversation from before start_agent still lists what its agents did', () => {
  // run_agent settled only when its run had, so a settled call is a finished run.
  const done = call('run_agent', { agent: 'security-reviewer', task: 'Review it.' }, {
    tier: 'read',
    result: 'Security reviewer finished.\n\nNothing found.',
    subagent: reviewer,
  });
  const cutOff = call('run_agent', { agent: 'explorer', task: 'Map it.' }, { tier: 'read', status: 'running', subagent: explorer });
  const subagents = conversationSubagents([asked('u', 1), reply('a', 2, [done, cutOff])]);
  assert.deepEqual(
    subagents.map(({ taskId, finished, report }) => ({ taskId, finished, report })),
    [
      { taskId: 't2', finished: true, report: 'Security reviewer finished.\n\nNothing found.' },
      { taskId: 't1', finished: false, report: null },
    ]
  );
  assert.deepEqual(unfinishedSubagents([done, cutOff]), [explorer]);
});

test("a subagent's standing comes from its task, and from its start row without one", () => {
  const task = (state: 'running' | 'done' | 'failed' | 'cancelled') =>
    ({ id: 't1', agentId: 'explorer', title: 'Map it', state }) as unknown as Parameters<typeof subagentPhase>[1];
  const row = (status: 'pending' | 'running' | 'done' | 'failed', started: boolean, finished: boolean) => ({ status, started, finished });

  // The task is the better witness whenever the store has it.
  assert.equal(subagentPhase(row('done', true, false), task('running'), false), 'running');
  assert.equal(subagentPhase(row('done', true, true), task('cancelled'), true), 'cancelled');

  // Without it, a start that returned is still working while its turn is.
  assert.equal(subagentPhase(row('done', true, false), null, true), 'running');
  assert.equal(subagentPhase(row('done', true, false), null, false), 'interrupted');
  assert.equal(subagentPhase(row('done', true, true), null, false), 'done');
  assert.equal(subagentPhase(row('failed', true, true), null, false), 'failed');

  // A call that never became a task.
  assert.equal(subagentPhase(row('running', false, false), null, true), 'starting');
  assert.equal(subagentPhase(row('running', false, false), null, false), 'interrupted');
  assert.equal(subagentPhase(row('failed', false, false), null, true), 'unstarted');
});

test('sources are the attachments, newest first, each name once', () => {
  const file = (id: string, name: string) => ({ id, name, size: 10, content: 'x' });
  const sources = conversationSources([
    asked('u1', 1, { attachments: [file('1', 'smb.conf'), file('2', 'notes.txt')] }),
    asked('u2', 2, { attachments: [file('3', 'smb.conf')] }),
  ]);
  assert.deepEqual(sources.map((source) => source.id), ['3', '2']);
});

test("a turn's answer is what it wrote after its last action; everything before is the work", () => {
  const content = 'Checking.\n\nApplying.\n\nDone — both changes are in.';
  const first = content.indexOf('Applying');
  const last = content.indexOf('Done');
  const parts = buildTranscriptParts(content, [
    call('read_file', { path: 'a' }, { contentOffset: first }),
    call('write_file', { path: 'b' }, { contentOffset: last }),
  ]);
  const { work, answer } = splitWork(parts);
  assert.deepEqual(work.map((part) => part.kind), ['text', 'tools', 'text', 'tools']);
  assert.deepEqual(answer.map((part) => (part.kind === 'text' ? part.text : '')), ['Done — both changes are in.']);

  // No actions: all answer, nothing to fold.
  const plain = splitWork(buildTranscriptParts('Just words.'));
  assert.equal(plain.work.length, 0);
  assert.equal(plain.answer.length, 1);

  // An action last: all work, and no answer yet.
  const working = splitWork(buildTranscriptParts('Looking.', [call('read_file', { path: 'a' }, { contentOffset: 8 })]));
  assert.equal(working.answer.length, 0);
});

test('a time label marks a new sitting, not every message', () => {
  const minute = 60_000;
  const monday = new Date(2026, 8, 14, 9, 13).getTime();
  assert.equal(startsSitting(undefined, monday), true);
  assert.equal(startsSitting(monday, monday + 5 * minute), false);
  assert.equal(startsSitting(monday, monday + 30 * minute), true);
  // Past midnight is a new day however short the gap.
  const late = new Date(2026, 8, 14, 23, 55).getTime();
  assert.equal(startsSitting(late, late + 10 * minute), true);
  assert.equal(startsSitting(monday, undefined), false);
});

test('time labels say today, yesterday, a weekday, or a date', () => {
  const now = new Date(2026, 8, 16, 17, 30).getTime(); // Wednesday
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
  assert.equal(sittingLabel(at(16, 14, 5), now, 'en-US'), 'Today 2:05 PM');
  assert.equal(sittingLabel(at(15, 9, 13), now, 'en-US'), 'Yesterday 9:13 AM');
  assert.equal(sittingLabel(at(14, 9, 13), now, 'en-US'), 'Monday 9:13 AM');
  assert.equal(sittingLabel(at(3, 9, 13), now, 'en-US'), 'Sep 3, 9:13 AM');
  assert.equal(sittingLabel(new Date(2025, 11, 24, 8, 0).getTime(), now, 'en-US'), 'Dec 24, 2025, 8:00 AM');
});

test('paths split into a name and the directory that holds it', () => {
  assert.deepEqual(splitPath('etc/samba/smb.conf.d/releases.conf'), { name: 'releases.conf', directory: 'etc/samba/smb.conf.d' });
  assert.deepEqual(splitPath('notes.md'), { name: 'notes.md', directory: '' });
  assert.deepEqual(splitPath('C:\\work\\out\\'), { name: 'out', directory: 'C:\\work' });
});

test('a handoff and a launch read as what they are in a one-line summary', () => {
  assert.equal(
    toolActivitySummary(call('start_agent', { agent: 'explorer', task: 'Map the tree.', title: 'Map the workspace' })),
    'Hand to explorer: Map the workspace'
  );
  assert.equal(toolActivitySummary(call('run_agent', { agent: 'explorer', task: 'Map the tree.' })), 'Hand to explorer: Map the tree.');
  assert.equal(toolActivitySummary(call('wait_for_agents', {})), 'Wait for agents');
  assert.equal(toolActivitySummary(call('wait_for_agents', { agents: ['explorer', 'test-writer'] })), 'Wait for explorer, test-writer');
  assert.equal(toolActivitySummary(call('agent_report', { agent: 'explorer', title: 'Map it' })), 'explorer reported back');
  assert.equal(toolActivitySummary(call('launch_program', { command: './build/editor' })), 'Start ./build/editor');
});

test('a note kept, read or dropped says which note, and a save for every project says so', () => {
  const memory = { serverId: 'antimatter.memory', serverName: 'Memory' };
  assert.equal(toolActivitySummary(call('remember', { name: 'GPU source', content: 'x' }, memory)), 'Remember: GPU source');
  assert.equal(
    toolActivitySummary(call('remember', { name: 'Prefers short answers', scope: 'user', content: 'x' }, memory)),
    'Remember: Prefers short answers (every project)'
  );
  assert.equal(toolActivitySummary(call('recall', { name: 'GPU source' }, memory)), 'Recall: GPU source');
  assert.equal(toolActivitySummary(call('forget', { name: 'GPU source', scope: 'user' }, memory)), 'Forget: GPU source');
  assert.equal(toolActivitySummary(call('antimatter_memory__remember', {}, memory)), 'Remember a note');
});

test("a run's record is read back as what it did, without the prompt it was given", () => {
  const carbon = [
    '# Carbon — abc',
    '',
    '- **model:** m (Sub)',
    '',
    '---',
    '',
    '## [0] note',
    '',
    '```\nExplorer — Map it (chat)\n```',
    '',
    '## [1] system',
    '',
    '```\nYou are the assistant inside Antimatter.\n```',
    '',
    '## [2] user',
    '',
    'You get your bearings in a codebase.',
    '',
    '## [3] list_directory',
    '',
    '```\nargs: {}\n```',
    '',
    '## [4] assistant',
    '',
    'Two entries.',
    '',
  ].join('\n');
  const kept = carbonActions(carbon);
  assert.match(kept, /^## \[0\] note/);
  assert.match(kept, /## \[3\] list_directory/);
  assert.match(kept, /Two entries\./);
  assert.doesNotMatch(kept, /bearings|inside Antimatter|Carbon — abc/);

  // A conversation's carbon labels a subagent's entries with its name; those prompts go too.
  const mirrored = '## [6] Explorer · system\n\nprompt\n\n## [7] Explorer · user\n\nbrief\n\n## [8] Explorer · list_directory\n\nargs\n';
  assert.equal(carbonActions(mirrored), '## [8] Explorer · list_directory\n\nargs\n');
});
