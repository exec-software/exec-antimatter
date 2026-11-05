import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatRequest, StreamResult } from '../src/api/types';
import { compactionNotice, conversationTokens, fitToBudget } from '../src/main/context';
import {
  runToolLoop,
  type BackgroundWork,
  type Steering,
  type StreamingProvider,
  type ToolCallOptions,
  type ToolRuntime,
} from '../src/main/toolLoop';

const request: ChatRequest = {
  messages: [{ id: 'user', role: 'user', content: 'Use bash.' }],
  model: 'test',
  providerId: 'test',
  useTools: true,
};

function fixture(results: StreamResult[]) {
  const requests: ChatRequest[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const provider: StreamingProvider = {
    async stream(next, callback) {
      // The loop appends its result after stream() resolves; retain what the provider actually
      // received at call time rather than a reference to the later durable transcript.
      requests.push({ ...next, messages: [...next.messages] });
      const result = results.shift();
      if (!result) throw new Error('provider script exhausted');
      if (result.content) callback({ id: 'chunk', content: result.content });
      return result;
    },
  };
  const runtime: ToolRuntime = {
    enabledTools: () => [
      {
        serverId: 'antimatter',
        serverName: 'Antimatter tools',
        tool: {
          name: 'run_command',
          description: 'Run Bash.',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
          enabled: true,
        },
      },
    ],
    async callTool(_server, name, args) {
      calls.push({ name, args });
      return { ok: true, text: 'exit 0' };
    },
  };
  return { provider, runtime, requests, calls };
}

const call = {
  id: 'call-1',
  type: 'function' as const,
  function: { name: 'antimatter__run_command', arguments: '{"command":"pwd"}' },
};

const completionReply = (command: string, index = 0, content = 'I have successfully completed the implementation. All requirements are met.'): StreamResult => ({
  content, toolCalls: [{ id: `completion-${index}`, type: 'function',
    function: { name: 'antimatter__run_command', arguments: JSON.stringify({ command }) } }],
});

test('varying completion echoes and exit commands stop without asking for another summary', async () => {
  const f = fixture([
    completionReply('echo "Implementation complete and tested successfully"', 1),
    completionReply('exit 0', 2),
    completionReply('echo "SUCCESS: all requirements implemented" && echo "All tests pass"', 3),
  ]);
  const activities: string[] = []; let visible = '';
  const result = await runToolLoop({ provider: f.provider, toolRuntime: f.runtime, request, runId: 'run', mode: 'full',
    reportWhenStopped: true, autoContinue: { enabled: true, maxContinues: 3, onRoundLimit: true },
    onContent: text => { visible += text; }, onActivity: activity => { activities.push(activity.toolName); }, requestApproval: async () => true });
  assert.equal(result.reason, 'no-progress'); assert.equal(result.rounds, 3); assert.equal(result.toolCalls, 3);
  assert.equal(f.requests.length, 3, 'no fourth model request to summarize the summaries');
  assert.match(visible, /Antimatter stopped this turn after three responses/);
  assert.match(result.content, /Those commands did not verify the application/);
  assert.equal(result.transcript.at(-1)?.content, visible.slice(visible.indexOf('Antimatter stopped')));
  assert.ok(activities.includes('completion_loop_guard'));
  assert.equal(result.transcript.some(message => message.id.startsWith('report_')), false);
});

test('developer round-limit continuation cannot reset the completion-loop allowance', async () => {
  const f = fixture([completionReply('echo "Implementation complete"', 1), completionReply('exit 0', 2),
    completionReply('echo "All requirements met"', 3)]);
  const nudges: string[] = [];
  const result = await runToolLoop({ provider: f.provider, toolRuntime: f.runtime, request, runId: 'run', mode: 'full', maxRounds: 2,
    autoContinue: { enabled: true, maxContinues: 3, onRoundLimit: true }, onAutoContinue: event => { nudges.push(event.reason); },
    onContent() {}, onActivity() {}, requestApproval: async () => true });
  assert.equal(result.reason, 'no-progress'); assert.equal(result.rounds, 3);
  assert.deepEqual(nudges, ['round-limit']);
});

test('negated completion statuses in prose or echoed text do not stop useful work', async () => {
  const statuses = [
    'Not all tests pass yet', 'It is not true that the implementation is complete',
    'I have not completed the implementation', 'I haven’t completed the task',
    'No claim that all requirements are met', 'All tests pass is false',
  ];
  const replies = statuses.flatMap((status, index) => [
    completionReply(`echo "Implementation complete ${index}"`, index * 2, status),
    completionReply(`echo "${status}"`, index * 2 + 1),
  ]);
  const f = fixture([...replies, { content: 'The remaining work needs investigation.', toolCalls: [] }]);
  const result = await runToolLoop({ provider: f.provider, toolRuntime: f.runtime, request, runId: 'run', mode: 'full',
    onContent() {}, onActivity() {}, requestApproval: async () => true });
  assert.equal(result.reason, 'finished'); assert.equal(f.calls.length, replies.length);
});

test('a real command resets completion-loop evidence before later completion-only rounds', async () => {
  const f = fixture([completionReply('echo "Implementation complete"', 1), completionReply('exit 0', 2),
    completionReply('./sdk/nilbuild check --project nil.project.json', 3),
    completionReply('echo "All requirements met"', 4), completionReply('exit 0', 5),
    completionReply('echo "All tests pass"', 6)]);
  const result = await runToolLoop({ provider: f.provider, toolRuntime: f.runtime, request, runId: 'run', mode: 'full',
    onContent() {}, onActivity() {}, requestApproval: async () => true });
  assert.equal(result.reason, 'no-progress'); assert.equal(result.rounds, 6); assert.equal(f.calls.length, 6);
});

test('completion wording does not turn shell work, build retries or polling into completion-only rounds', async () => {
  const commands = [
    'echo "Implementation complete" > status.txt',
    'echo "Implementation complete" && ./sdk/nilbuild check',
    'echo "Implementation complete $(./sdk/nilbuild check)"',
    'echo "Implementation complete `./sdk/nilbuild check`"',
    'echo "Implementation complete" | tee status.txt',
    'echo "Implementation complete"; ./sdk/nilbuild run',
    './sdk/nilbuild check --project first.json',
    './sdk/nilbuild check --project second.json',
    'curl --fail http://127.0.0.1:8080/status',
    'curl --fail http://127.0.0.1:8080/health',
    'echo "Implementation complete" *.matrix',
  ];
  const f = fixture([...commands.map((command, index) => completionReply(command, index)), { content: 'Finished checking.', toolCalls: [] }]);
  const result = await runToolLoop({ provider: f.provider, toolRuntime: f.runtime, request, runId: 'run', mode: 'full',
    onContent() {}, onActivity() {}, requestApproval: async () => true });
  assert.equal(result.reason, 'finished'); assert.equal(f.calls.length, commands.length);
});

test('echo commands without an assistant completion claim and useful mixed batches remain allowed', async () => {
  const f = fixture([
    completionReply('echo "Implementation complete"', 1, 'Checking the literal text output.'),
    completionReply('echo "All requirements met"', 2, 'Checking a second literal text output.'),
    completionReply('echo "All tests pass"', 3, 'Checking another output format.'),
    { content: 'Implementation complete.', toolCalls: [
      ...completionReply('echo "Implementation complete"', 4).toolCalls,
      ...completionReply('./sdk/nilbuild check', 5).toolCalls,
    ] },
    completionReply('echo "All requirements met"', 6), completionReply('exit 0', 7),
    { content: 'Finished checking.', toolCalls: [] },
  ]);
  const result = await runToolLoop({ provider: f.provider, toolRuntime: f.runtime, request, runId: 'run', mode: 'full',
    onContent() {}, onActivity() {}, requestApproval: async () => true });
  assert.equal(result.reason, 'finished'); assert.equal(result.rounds, 7);
});

test('several completion echoes in one response consume only one completion-only round', async () => {
  const f = fixture([{ content: 'Implementation complete.', toolCalls: [
    ...completionReply('echo "Implementation complete"', 1).toolCalls,
    ...completionReply('exit 0', 2).toolCalls,
    ...completionReply('echo "All requirements met"', 3).toolCalls,
  ] }, { content: 'The requested output is above.', toolCalls: [] }]);
  const result = await runToolLoop({ provider: f.provider, toolRuntime: f.runtime, request, runId: 'run', mode: 'full',
    onContent() {}, onActivity() {}, requestApproval: async () => true });
  assert.equal(result.reason, 'finished'); assert.equal(result.rounds, 2);
});

test('completion-only prose cannot stop a turn while background work is still running', async () => {
  const f = fixture([completionReply('echo "Implementation complete"', 1), completionReply('exit 0', 2),
    completionReply('echo "All requirements met"', 3), { content: 'Background work is finished.', toolCalls: [] }]);
  const background: BackgroundWork = { take: () => [], running: () => f.requests.length < 4 ? 1 : 0,
    ready: () => 0, onSettle: () => () => {} };
  const result = await runToolLoop({ provider: f.provider, toolRuntime: f.runtime, request, runId: 'run', mode: 'full', background,
    onContent() {}, onActivity() {}, requestApproval: async () => true });
  assert.equal(result.reason, 'finished'); assert.equal(result.rounds, 4);
});

const validationReply = (action: 'check' | 'run', index: number, content?: string) =>
  completionReply(`./sdk/nilbuild ${action} --project nil.project.json`, index, content);
const validationToolReply = (name: string, args: Record<string, unknown>, index: number, server = 'antimatter'): StreamResult => ({
  content: 'The implementation is complete.', toolCalls: [{ id: `validation-${index}`, type: 'function',
    function: { name: `${server.replaceAll('.', '_')}__${name}`, arguments: JSON.stringify(args) } }],
});
const validationInspection = (index: number) => validationToolReply('list_directory', { path: 'src' }, index);
const doneValidation: StreamResult = { content: 'The recorded results are ready for review.', toolCalls: [] };
const shellValidationReport = (command: string, index: number, stdout?: string, stderr?: string, code = 0) => {
  const out = stdout ?? (command.includes(' run ') ? 'Warehouse compiled successfully' : '');
  const err = stderr ?? (command.includes(' run ') ? `Compiled files to '/project/build/.nilbuild-${index}/warehouse.nil' in topological order:\n  - /project/src/main.matrix (module: warehouse)` : '');
  return `Automatic compiler feedback prefix ${index}\n\nOriginal tool result:\n$ ${command}\n[cwd] /project\n[exit] ${code}\n--- stdout (${out.length} bytes) ---\n${out}\n--- stderr (${err.length} bytes) ---\n${err}`;
};

function validationFixture(replies: StreamResult[], output?: (name: string, args: Record<string, unknown>, index: number) => string) {
  const f = fixture(replies); const base = f.runtime.enabledTools();
  f.runtime.enabledTools = () => [...base, ...['list_directory', 'read_file', 'write_file', 'edit_file'].map(name => ({
    serverId: 'antimatter', serverName: 'Antimatter', tool: { name, description: name, enabled: true,
      inputSchema: { type: 'object', properties: {} } },
  })), ...['antimatter.pensieve', 'other'].map(serverId => ({ serverId, serverName: serverId,
    tool: { name: 'pensieve_check_project', description: 'Check project', enabled: true, inputSchema: { type: 'object', properties: {} } },
  }))];
  f.runtime.callTool = async (_server, name, args) => {
    f.calls.push({ name, args });
    return { ok: true, text: output ? output(name, args, f.calls.length) : name === 'run_command'
      ? shellValidationReport(String(args.command), f.calls.length) : 'Observed source files.' };
  };
  return f;
}

const runValidation = (f: ReturnType<typeof validationFixture>, options: Partial<Parameters<typeof runToolLoop>[0]> = {}) =>
  runToolLoop({ provider: f.provider, toolRuntime: f.runtime, request, runId: 'validation-run', mode: 'full',
    onContent() {}, onActivity() {}, requestApproval: async () => true, ...options });

test('alternating unchanged validations stop after three repeated completion claims across inspections and auto-continue', async () => {
  // Plain shell reports expose output, not source hashes. This checks redundant completion
  // behavior only; it cannot prove no external edit occurred with identical output.
  const f = validationFixture([
    validationReply('check', 1, 'Checking compilation.'), validationReply('run', 2, 'Running the application.'),
    validationReply('check', 3), validationInspection(4), validationReply('run', 5), validationInspection(6), validationReply('check', 7),
  ]);
  const nudges: string[] = []; let visible = '';
  const result = await runValidation(f, { maxRounds: 3, reportWhenStopped: true,
    autoContinue: { enabled: true, maxContinues: 3, onRoundLimit: true }, onAutoContinue: event => { nudges.push(event.reason); },
    onContent: text => { visible += text; } });
  assert.equal(result.reason, 'no-progress'); assert.equal(result.rounds, 7); assert.equal(f.requests.length, 7);
  assert.equal(nudges.length, 2, 'developer continuation cannot reset the validation history');
  assert.match(visible, /three completion claims repeated previously observed validation results/);
  assert.match(visible, /does not establish that the requested application is correct/);
  assert.equal(result.transcript.at(-1)?.content, visible.slice(visible.indexOf('Antimatter stopped')));
  assert.equal(result.transcript.some(message => message.id.startsWith('report_')), false);
});

test('initial distinct validation targets and normal check/run completion remain allowed', async () => {
  const replies = ['one.json', 'two.json', 'three.json'].flatMap((project, index) => ['check', 'run'].map((action, offset) =>
    completionReply(`./sdk/nilbuild ${action} --project ${project}`, index * 2 + offset)));
  const f = validationFixture([...replies, doneValidation]);
  const result = await runValidation(f);
  assert.equal(result.reason, 'finished'); assert.equal(f.calls.length, 6);
});

test('source edits and complex shell work reset repeated validation history', async () => {
  for (const change of [validationToolReply('write_file', { path: 'src/main.matrix', content: 'new source' }, 5),
    validationToolReply('edit_file', { path: 'src/main.matrix', old_text: 'old', new_text: 'new' }, 5),
    completionReply('./sdk/nilbuild check --project nil.project.json && echo inspected', 5)]) {
    const f = validationFixture([
      validationReply('check', 1), validationReply('run', 2), validationReply('check', 3), validationReply('run', 4), change,
      validationReply('check', 6), validationReply('run', 7), validationReply('check', 8), validationReply('run', 9), validationReply('check', 10),
    ]);
    const result = await runValidation(f);
    assert.equal(result.reason, 'no-progress'); assert.equal(result.rounds, 10);
  }
});

test('changed diagnostics, runtime output and unsuccessful validations are new evidence', async () => {
  for (const kind of ['diagnostic', 'stdout', 'failure', 'stage-in-stdout']) {
    const f = validationFixture([...Array.from({ length: 8 }, (_, index) => validationReply(index % 2 ? 'run' : 'check', index)), doneValidation],
      (_name, args, index) => shellValidationReport(String(args.command), index,
        kind === 'stdout' ? `Observed value: ${index}` : kind === 'stage-in-stdout' ? `/project/build/.nilbuild-${index}/result` : '',
        kind === 'diagnostic' ? `main.matrix:${index}: warning: changed diagnostic` : '', kind === 'failure' ? 1 : 0));
    const result = await runValidation(f);
    assert.equal(result.reason, 'finished', kind);
  }
});

test('a changed diagnostic clears the prior repeat allowance before stable checks can count again', async () => {
  const f = validationFixture(Array.from({ length: 9 }, (_, index) => validationReply(index % 2 ? 'run' : 'check', index)),
    (_name, args, index) => shellValidationReport(String(args.command), index, '',
      String(args.command).includes(' check ') && index >= 5 ? 'A newly observed warning.' : ''));
  const result = await runValidation(f);
  assert.equal(result.reason, 'no-progress'); assert.equal(result.rounds, 9);
});

test('complex validation commands and checks without completion claims are not guessed into a loop', async () => {
  const commands = [
    './sdk/nilbuild check --project nil.project.json && true', './sdk/nilbuild run --project nil.project.json | tee run.log',
    './sdk/nilbuild check --project "$(select-project)"', './sdk/nilbuild run --target native',
    './sdk/nilbuild check --project nil.project.json > check.log', './sdk/nilbuild run --project nil.project.json; inspect',
  ];
  const replies = [...commands, ...commands].map((command, index) => completionReply(command, index));
  replies.push(...Array.from({ length: 8 }, (_, index) => validationReply(index % 2 ? 'run' : 'check', index + 20, 'Not all tests pass yet.')));
  const f = validationFixture([...replies, doneValidation]);
  const result = await runValidation(f);
  assert.equal(result.reason, 'finished'); assert.equal(f.calls.length, replies.length);
});

const pensieveValidationOutput = (index: number, changes: Record<string, unknown> = {}) => JSON.stringify({
  verification: 'compile-only', success: true, sourceStable: true, entry: 'src/main.matrix', task: 'nil.project.json',
  output: 'A stable compiler warning.', capturedSourceHashes: index % 4 < 2
    ? { 'src/main.matrix': 'a'.repeat(64), 'nil.project.json': 'b'.repeat(64) }
    : { 'nil.project.json': 'b'.repeat(64), 'src/main.matrix': 'a'.repeat(64) },
  memory: { event_id: `event-${index}`, repair_id: null }, ...changes,
});

test('app-owned Pensieve checks compare stable source evidence while ignoring memory event identities', async () => {
  const replies = Array.from({ length: 4 }, (_, index) => [
    validationToolReply('pensieve_check_project', {}, index * 2, 'antimatter.pensieve'), validationInspection(index * 2 + 1),
  ]).flat();
  const f = validationFixture(replies, (name, _args, index) => name === 'pensieve_check_project'
    ? pensieveValidationOutput(index) : 'Source listing.');
  const result = await runValidation(f);
  assert.equal(result.reason, 'no-progress'); assert.equal(result.rounds, 7);
});

test('changed Pensieve source, entry, task or diagnostics reset evidence; other servers cannot trigger this guard', async () => {
  for (const change of ['hash', 'entry', 'task', 'diagnostic', 'server']) {
    const replies = Array.from({ length: 5 }, (_, index) => [validationToolReply('pensieve_check_project', {}, index * 2,
      change === 'server' ? 'other' : 'antimatter.pensieve'), validationInspection(index * 2 + 1)]).flat();
    const f = validationFixture([...replies, doneValidation], (name, _args, index) => name !== 'pensieve_check_project' ? 'Files.' :
      pensieveValidationOutput(index, change === 'hash' ? { capturedSourceHashes: { 'src/main.matrix': String(index).repeat(64).slice(0, 64) } }
        : change === 'entry' ? { entry: `src/entry${index}.matrix` } : change === 'task' ? { task: `project${index}.json` }
          : change === 'diagnostic' ? { output: `Diagnostic ${index}` } : {}));
    const result = await runValidation(f);
    assert.equal(result.reason, 'finished', change);
  }
});

test('background work and human input reset repeated validation evidence', async () => {
  const replies = Array.from({ length: 8 }, (_, index) => validationReply(index % 2 ? 'run' : 'check', index));
  const busy = validationFixture([...replies, doneValidation]);
  const background: BackgroundWork = { take: () => [], running: () => busy.requests.length < 9 ? 1 : 0,
    ready: () => 0, onSettle: () => () => {} };
  assert.equal((await runValidation(busy, { background })).reason, 'finished');

  const steeredFixture = validationFixture([...replies, doneValidation]); let delivered = false;
  const steer: Steering = { take: () => {
    if (!delivered && steeredFixture.requests.length === 4) { delivered = true; return 'Re-run both checks for my review.'; }
    return null;
  }, pending: () => false, interrupt: new AbortController().signal, rearm() {} };
  const result = await runValidation(steeredFixture, { steer });
  assert.equal(result.reason, 'finished'); assert.equal(delivered, true);
});

test('ordinary auto-selection may finish without a tool', async () => {
  const f = fixture([{ content: 'An explanation.', toolCalls: [] }]);
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });
  assert.equal(result.rounds, 1);
  assert.equal(result.toolCalls, 0);
});

test('an explicit required tool gets one corrective retry and then really runs', async () => {
  const f = fixture([
    { content: "I'll run it now.", toolCalls: [] },
    { content: '', toolCalls: [call] },
    { content: 'The command exited successfully.', toolCalls: [] },
  ]);
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    requiredTool: 'run_command',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(result.rounds, 3);
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(f.calls, [{ name: 'run_command', args: { command: 'pwd' } }]);
  assert.match(
    f.requests[1].messages.find((message) => message.id.startsWith('required_tool_'))?.content ?? '',
    /Call antimatter__run_command now/
  );
});

test('two prose-only responses fail instead of recording imaginary work', async () => {
  const f = fixture([
    { content: "I'll run it.", toolCalls: [] },
    { content: 'Done.', toolCalls: [] },
  ]);
  await assert.rejects(
    runToolLoop({
      provider: f.provider,
      toolRuntime: f.runtime,
      request,
      runId: 'run',
      mode: 'full',
      requiredTool: 'run_command',
      onContent: () => undefined,
      onActivity: () => undefined,
      requestApproval: async () => true,
    }),
    /no required run_command tool call/
  );
  assert.equal(f.calls.length, 0);
});

test('a hallucinated tool name does not satisfy the real-tool requirement', async () => {
  const f = fixture([
    {
      content: '',
      toolCalls: [
        {
          id: 'fake-call',
          type: 'function',
          function: { name: 'imaginary__shell', arguments: '{}' },
        },
      ],
    },
    { content: 'Everything is complete.', toolCalls: [] },
    { content: 'Still complete.', toolCalls: [] },
  ]);

  await assert.rejects(
    runToolLoop({
      provider: f.provider,
      toolRuntime: f.runtime,
      request,
      runId: 'run',
      mode: 'full',
      requireToolCall: true,
      onContent: () => undefined,
      onActivity: () => undefined,
      requestApproval: async () => true,
    }),
    /no tool call after a corrective retry/
  );
  assert.equal(f.calls.length, 0);
});

test('a mandatory-tool run fails before inference when no eligible tools are connected', async () => {
  let streamed = false;
  const runtime: ToolRuntime = {
    enabledTools: () => [],
    callTool: async () => ({ ok: false, text: 'unreachable' }),
  };
  const provider: StreamingProvider = {
    async stream() {
      streamed = true;
      return { content: '', toolCalls: [] };
    },
  };

  await assert.rejects(
    runToolLoop({
      provider,
      toolRuntime: runtime,
      request,
      runId: 'run',
      mode: 'full',
      requireToolCall: true,
      onContent: () => undefined,
      onActivity: () => undefined,
      requestApproval: async () => true,
    }),
    /no eligible tools are connected and enabled/
  );
  assert.equal(streamed, false);
});

test('isolated-runtime connection failures are surfaced without spending an inference request', async () => {
  let streamed = false;
  const activities: string[] = [];
  const runtime: ToolRuntime = {
    enabledTools: () => [],
    connectionErrors: () => [
      { serverId: 'broken', serverName: 'Broken tools', message: 'spawn ENOENT' },
    ],
    callTool: async () => ({ ok: false, text: 'unreachable', attempted: false }),
  };
  const provider: StreamingProvider = {
    async stream() {
      streamed = true;
      return { content: '', toolCalls: [] };
    },
  };

  await assert.rejects(
    runToolLoop({
      provider,
      toolRuntime: runtime,
      request,
      runId: 'run',
      mode: 'full',
      requireToolCall: true,
      workspace: '/workspace',
      onContent: () => undefined,
      onActivity: (activity) => activities.push(`${activity.toolName}:${activity.result}`),
      requestApproval: async () => true,
    }),
    /Broken tools: spawn ENOENT/
  );
  assert.equal(streamed, false);
  assert.deepEqual(activities, ['connect:spawn ENOENT']);
});

test('transcript checkpoints keep a tool request paired with its result when the next stream fails', async () => {
  const f = fixture([{ content: '', toolCalls: [call] }]);
  const checkpoints: ChatRequest['messages'][] = [];

  await assert.rejects(
    runToolLoop({
      provider: f.provider,
      toolRuntime: f.runtime,
      request,
      runId: 'run',
      mode: 'full',
      onContent: () => undefined,
      onActivity: () => undefined,
      onTranscript: (messages) => checkpoints.push(messages),
      requestApproval: async () => true,
    }),
    /provider script exhausted/
  );

  const final = checkpoints.at(-1) ?? [];
  const assistant = final.find((message) => message.toolCalls?.some((entry) => entry.id === call.id));
  const tool = final.find((message) => message.role === 'tool' && message.toolCallId === call.id);
  assert.ok(assistant);
  assert.ok(tool);
  assert.equal(tool.content, 'exit 0');
});

test('a provider that resolves after cancellation checkpoints text it already streamed', async () => {
  const controller = new AbortController();
  const checkpoints: ChatRequest['messages'][] = [];
  const provider: StreamingProvider = {
    async stream(_next, callback, _onAlive, signal) {
      callback({ id: 'partial', content: 'Partial answer kept.' });
      controller.abort();
      assert.equal(signal?.aborted, true);
      // Some OpenAI-compatible transports settle their promise after the abort instead of
      // rejecting it. The outer turn must still stop, but its visible prefix remains context.
      return { content: 'Partial answer kept.', toolCalls: [] };
    },
  };

  await assert.rejects(
    runToolLoop({
      provider,
      toolRuntime: { enabledTools: () => [], callTool: async () => ({ ok: false, text: 'unreachable' }) },
      request: { ...request, useTools: false },
      runId: 'late-cancel',
      mode: 'full',
      signal: controller.signal,
      onContent: () => undefined,
      onActivity: () => undefined,
      onTranscript: (messages) => checkpoints.push(messages),
      requestApproval: async () => true,
    }),
    /cancelled/
  );

  assert.equal(checkpoints.at(-1)?.at(-1)?.role, 'assistant');
  assert.equal(checkpoints.at(-1)?.at(-1)?.content, 'Partial answer kept.');
});

test('each completed call in a multi-call batch has a protocol-valid durable checkpoint', async () => {
  const first = {
    id: 'read-1',
    type: 'function' as const,
    function: { name: 'antimatter__read_file', arguments: '{"path":"first"}' },
  };
  const second = {
    id: 'read-2',
    type: 'function' as const,
    function: { name: 'antimatter__read_file', arguments: '{"path":"second"}' },
  };
  const third = {
    id: 'read-3',
    type: 'function' as const,
    function: { name: 'antimatter__read_file', arguments: '{"path":"third"}' },
  };
  const results: StreamResult[] = [
    { content: '', toolCalls: [first, second, third] },
    { content: 'Done.', toolCalls: [] },
  ];
  const provider: StreamingProvider = {
    async stream(_next, callback) {
      const result = results.shift();
      if (!result) throw new Error('provider script exhausted');
      if (result.content) callback({ id: 'chunk', content: result.content });
      return result;
    },
  };
  let releaseSecond = () => undefined;
  let markSecondStarted = () => undefined;
  const secondHeld = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });
  let secondMutated = false;
  const runtime: ToolRuntime = {
    enabledTools: () => [{
      serverId: 'antimatter',
      serverName: 'Antimatter tools',
      tool: {
        name: 'read_file',
        description: 'Read a file.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        enabled: true,
      },
    }],
    async callTool(_server, _name, args) {
      if (args.path === 'second') {
        // Model a side effect that happens before the transport returns its settled result.
        secondMutated = true;
        markSecondStarted();
        await secondHeld;
      }
      return { ok: true, text: `contents:${String(args.path)}` };
    },
  };
  const checkpoints: ChatRequest['messages'][] = [];
  const turn = runToolLoop({
    provider,
    toolRuntime: runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    onTranscript: (messages) => checkpoints.push(messages),
    requestApproval: async () => true,
  });

  await secondStarted;
  try {
    const recovery = checkpoints.at(-1) ?? [];
    const batch = recovery.find((message) => message.toolCalls?.length === 3);
    const firstResult = recovery.find((message) => message.toolCallId === first.id);
    const secondPlaceholder = recovery.find((message) => message.toolCallId === second.id);
    const thirdPlaceholder = recovery.find((message) => message.toolCallId === third.id);
    assert.ok(batch);
    assert.equal(secondMutated, true);
    assert.equal(firstResult?.content, 'contents:first');
    assert.match(secondPlaceholder?.content ?? '', /Execution began/);
    assert.match(secondPlaceholder?.content ?? '', /Verify the target state before retrying/);
    assert.match(thirdPlaceholder?.content ?? '', /Not run before/);
  } finally {
    releaseSecond();
  }

  const completed = await turn;
  assert.equal(completed.transcript.find((message) => message.toolCallId === second.id)?.content, 'contents:second');
  assert.equal(completed.transcript.find((message) => message.toolCallId === third.id)?.content, 'contents:third');
});

test('mid-loop fitting leaves a durable notice and reports the live toolset', async () => {
  const f = fixture([{ content: 'Done.', toolCalls: [] }]);
  const messages: ChatRequest['messages'] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Do the work.' },
    { id: 'old', role: 'assistant', content: 'old '.repeat(1_000) },
    { id: 'latest', role: 'user', content: 'Continue.' },
  ];
  const budget = conversationTokens([messages[0], messages[1], compactionNotice(1), messages[3]]);
  const events: Array<{ compacted: number; tools: number; notice: string; persisted: boolean }> = [];
  let fitTools = 0;

  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request: { ...request, messages },
    runId: 'run',
    mode: 'full',
    // Array results remain supported for current callers; the loop reconstructs what was omitted.
    fit: (conversation, tools) => {
      fitTools = tools.length;
      return fitToBudget(conversation, budget).messages;
    },
    onCompaction: (event) =>
      events.push({
        compacted: event.compacted,
        tools: event.tools.length,
        notice: event.notice.content,
        persisted: event.noticePersisted,
      }),
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(fitTools, 1);
  assert.deepEqual(events.map((event) => [event.compacted, event.tools]), [[1, 1]]);
  assert.equal(events[0].persisted, true);
  assert.match(events[0].notice, /1 earlier message was dropped|1 earlier messages were dropped/);
  const notice = result.transcript.find((message) => message.id.startsWith('compaction_'));
  assert.ok(notice, 'the compaction marker must survive in the persisted transcript');
  assert.ok(f.requests[0].messages.some((message) => message.id === notice.id));
  assert.equal(result.transcript.some((message) => message.id === 'old'), false);
});

test('a tight production fit omits the marker rather than the current request', async () => {
  const f = fixture([{ content: 'Done.', toolCalls: [] }]);
  const messages: ChatRequest['messages'] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Do the work.' },
    { id: 'old', role: 'assistant', content: 'old '.repeat(1_000) },
    { id: 'latest', role: 'user', content: 'Keep this request.' },
  ];
  const budget = conversationTokens([messages[0], messages[1], messages[3]]);
  let persisted: boolean | undefined;

  await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request: { ...request, messages },
    runId: 'run',
    mode: 'full',
    fit: (conversation) => fitToBudget(conversation, budget),
    onCompaction: (event) => {
      persisted = event.noticePersisted;
    },
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(persisted, false);
  assert.ok(f.requests[0].messages.some((message) => message.id === 'latest'));
  assert.equal(f.requests[0].messages.some((message) => message.id.startsWith('compaction_')), false);
  assert.ok(conversationTokens(f.requests[0].messages) <= budget);
});

test('a simultaneous human steer remains newer than a background report under a tight fit', async () => {
  const f = fixture([{ content: 'Understood.', toolCalls: [] }]);
  const messages: ChatRequest['messages'] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Do the work.' },
    { id: 'old', role: 'assistant', content: 'old '.repeat(1_000) },
  ];
  const human = 'Use the corrected requirement.';
  const budget = conversationTokens([...messages.slice(0, 2), { id: 'steer_0', role: 'user', content: human }]);
  let queued: string | null = human;
  const steer: Steering = {
    take: () => {
      const note = queued;
      queued = null;
      return note;
    },
    pending: () => queued !== null,
    interrupt: new AbortController().signal,
    rearm: () => undefined,
  };
  let available = true;
  const background: BackgroundWork = {
    take: () => {
      if (!available) return [];
      available = false;
      return [
        {
          note: 'A background review completed.',
          activity: {
            callId: 'background-call',
            serverId: 'antimatter',
            serverName: 'Antimatter',
            toolName: 'agent_report',
            tier: 'read',
            args: '{}',
            status: 'done',
            result: 'review complete',
          },
        },
      ];
    },
    running: () => 0,
    ready: () => (available ? 1 : 0),
    onSettle: () => () => undefined,
  };

  await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    background,
    steer,
    request: { ...request, messages },
    runId: 'run',
    mode: 'full',
    fit: (conversation) => fitToBudget(conversation, budget),
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  const backgroundIndex = f.requests[0].messages.findIndex((message) => message.content.includes('background review'));
  const steerIndex = f.requests[0].messages.findIndex((message) => message.id === 'steer_0');
  assert.ok(backgroundIndex >= 0, 'the consumed background report must reach the model');
  assert.ok(steerIndex > backgroundIndex, 'the human correction remains the newest boundary input');
});

test('legacy malformed calls are repaired in the durable transcript before the first request', async () => {
  const f = fixture([{ content: 'Recovered.', toolCalls: [] }]);
  const broken = '{"command":"printf unfinished';
  const checkpoints: ChatRequest['messages'][] = [];
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request: {
      ...request,
      messages: [
        request.messages[0],
        {
          id: 'old-assistant',
          role: 'assistant',
          content: '',
          toolCalls: [{ ...call, id: 'old-call', function: { ...call.function, arguments: broken } }],
        },
        { id: 'old-call', role: 'tool', toolCallId: 'old-call', name: 'run_command', content: 'It did not run.' },
        { id: 'continue', role: 'user', content: 'Continue.' },
      ],
    },
    runId: 'run',
    mode: 'full',
    onTranscript: (messages) => checkpoints.push(messages),
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  const repaired = result.transcript.find((message) => message.id === 'old-assistant')?.toolCalls?.[0].function.arguments;
  assert.equal(JSON.parse(repaired ?? '{}')._antimatter.reason, 'invalid_json');
  assert.equal(checkpoints[0].find((message) => message.id === 'old-assistant')?.toolCalls?.[0].function.arguments, repaired);
  assert.equal(f.requests[0].messages.find((message) => message.id === 'old-assistant')?.toolCalls?.[0].function.arguments, repaired);
});

test('cancellation on the last tool of the last round is cancellation, not the round limit', async () => {
  const controller = new AbortController();
  const f = fixture([{ content: '', toolCalls: [call] }]);
  f.runtime.callTool = async () => {
    controller.abort();
    return { ok: false, text: 'aborted' };
  };

  await assert.rejects(
    runToolLoop({
      provider: f.provider,
      toolRuntime: f.runtime,
      request,
      runId: 'run',
      mode: 'full',
      maxRounds: 1,
      signal: controller.signal,
      onContent: () => undefined,
      onActivity: () => undefined,
      requestApproval: async () => true,
    }),
    /run was cancelled/
  );
});

test('approval waits are cancellable and their ids are scoped to the run', async () => {
  const controller = new AbortController();
  const f = fixture([{ content: '', toolCalls: [call] }]);
  let approvalId: string | undefined;
  const activities: Array<{ status: string; awaitingApproval?: boolean; result?: string }> = [];
  const checkpoints: ChatRequest['messages'][] = [];
  const running = runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run-a',
    mode: 'ask',
    signal: controller.signal,
    onContent: () => undefined,
    onTranscript: (messages) => checkpoints.push(messages),
    onActivity: (activity) => {
      if (activity.awaitingApproval) approvalId = activity.approvalId;
      activities.push({
        status: activity.status,
        awaitingApproval: activity.awaitingApproval,
        result: activity.result,
      });
    },
    requestApproval: async () => new Promise<boolean>(() => {}),
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(approvalId, 'run-a:0:0:call-1');
  const waiting = checkpoints.at(-1)?.find((message) => message.toolCallId === call.id);
  assert.match(waiting?.content ?? '', /Not run before/);
  assert.doesNotMatch(waiting?.content ?? '', /Execution began/);
  assert.equal(f.calls.length, 0);
  controller.abort();
  await assert.rejects(running, /run was cancelled/);
  assert.deepEqual(
    activities.map(({ status, awaitingApproval }) => ({ status, awaitingApproval })),
    [
      { status: 'pending', awaitingApproval: true },
      { status: 'failed', awaitingApproval: false },
    ]
  );
  assert.match(activities[1].result ?? '', /Interrupted while waiting for approval/);
  assert.doesNotMatch(activities[1].result ?? '', /declined/i);
  assert.equal(f.calls.length, 0);
});

test('an explicit approval refusal remains a declined tool event', async () => {
  const f = fixture([{ content: '', toolCalls: [call] }]);
  const activities: Array<{ status: string; awaitingApproval?: boolean; result?: string }> = [];

  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run-a',
    mode: 'ask',
    maxRounds: 1,
    onContent: () => undefined,
    onActivity: (activity) => {
      activities.push({
        status: activity.status,
        awaitingApproval: activity.awaitingApproval,
        result: activity.result,
      });
    },
    requestApproval: async () => false,
  });

  assert.equal(result.reason, 'limit');
  assert.deepEqual(
    activities.map(({ status, awaitingApproval }) => ({ status, awaitingApproval })),
    [
      { status: 'pending', awaitingApproval: true },
      { status: 'denied', awaitingApproval: false },
    ]
  );
  assert.match(activities[1].result ?? '', /was declined/);
  assert.equal(f.calls.length, 0);
});

test('renderer-loss cancellation cannot masquerade as a declined approval', async () => {
  const controller = new AbortController();
  const f = fixture([{ content: '', toolCalls: [call] }]);
  const activities: Array<{ status: string; awaitingApproval?: boolean; result?: string }> = [];
  const running = runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run-reload',
    mode: 'ask',
    signal: controller.signal,
    onContent: () => undefined,
    onActivity: (activity) => {
      activities.push({
        status: activity.status,
        awaitingApproval: activity.awaitingApproval,
        result: activity.result,
      });
    },
    // Mirrors the interactive main-process adapter, which resolves its boolean wait when the
    // renderer-owned signal aborts. The loop must still distinguish that from a clicked Decline.
    requestApproval: async (_activity, signal) =>
      new Promise<boolean>((resolve) => {
        const interrupted = () => resolve(false);
        if (signal?.aborted) interrupted();
        else signal?.addEventListener('abort', interrupted, { once: true });
      }),
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort('antimatter:renderer-lost');
  await assert.rejects(running, /run was cancelled/);
  assert.deepEqual(
    activities.map(({ status, awaitingApproval }) => ({ status, awaitingApproval })),
    [
      { status: 'pending', awaitingApproval: true },
      { status: 'failed', awaitingApproval: false },
    ]
  );
  assert.match(activities[1].result ?? '', /Interrupted while waiting for approval/);
  assert.doesNotMatch(activities[1].result ?? '', /declined/i);
  assert.equal(f.calls.length, 0);
});

test('reused provider fallback call ids still create distinct approval occurrences', async () => {
  const f = fixture([
    { content: '', toolCalls: [call] },
    { content: '', toolCalls: [call] },
  ]);
  const approvals: string[] = [];

  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run-a',
    mode: 'ask',
    maxRounds: 2,
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async (activity) => {
      approvals.push(activity.approvalId ?? '');
      return false;
    },
  });

  assert.equal(result.reason, 'limit');
  assert.deepEqual(approvals, ['run-a:0:0:call-1', 'run-a:1:0:call-1']);
});

test('a tool server lost between rounds is removed from the next inference request', async () => {
  const f = fixture([
    { content: '', toolCalls: [call] },
    { content: 'The first call completed.', toolCalls: [] },
  ]);
  const definitions = f.runtime.enabledTools();
  let connected = true;
  f.runtime.enabledTools = () => (connected ? definitions : []);
  f.runtime.callTool = async () => {
    connected = false;
    return { ok: true, text: 'exit 0', attempted: true };
  };

  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(result.reason, 'finished');
  assert.equal(f.requests[0].tools?.length, 1);
  assert.equal(f.requests[1].tools, undefined);
});

/** What a reasoning model returns when max_tokens runs out mid-thought. */
const ranOutThinking = {
  content: '',
  toolCalls: [],
  reasoning: 'Let me consider the workspace...',
  finishReason: 'length',
};

test('a round the output lid cut off mid-thought is asked for the step, not ended on', async () => {
  // Carbon e2b3a672 lost 97 tool calls and an hour and a half to exactly this shape: a round
  // that spent its whole reply budget deliberating, wrote nothing, and ended the turn.
  const f = fixture([
    { content: '', toolCalls: [call] },
    ranOutThinking,
    { content: 'The command exited successfully.', toolCalls: [] },
  ]);
  const carriedOn: string[] = [];
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    onAutoContinue: ({ reason }) => carriedOn.push(reason),
    requestApproval: async () => true,
  });

  assert.equal(result.reason, 'finished', 'the work before the cut-off round is not lost with it');
  assert.equal(result.content, 'The command exited successfully.');
  assert.deepEqual(carriedOn, ['ran-out-thinking']);
  // The nudge has to tell it not to deliberate again: it never sees its own thinking back.
  const nudge = result.transcript.find((m) => m.id.startsWith('ran_out_thinking_'));
  assert.equal(nudge?.role, 'user');
  assert.match(nudge!.content, /Do not deliberate again/i);
});

test('a turn that cannot get out of its own deliberation is still reported as truncated', async () => {
  const f = fixture([{ content: '', toolCalls: [call] }, ranOutThinking, ranOutThinking, ranOutThinking]);
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(result.reason, 'truncated', 'an answer that never arrived is not a finished turn');
  assert.equal(result.toolCalls, 1);
  // The transcript has to say why it is empty; silence here is the bug being fixed. It also says
  // the retries were spent, so a continued turn does not walk into the same wall.
  const last = result.transcript.at(-1)!;
  assert.equal(last.role, 'assistant');
  assert.match(last.content, /output limit/);
  assert.match(last.content, /reasoning/);
  assert.match(last.content, /2 times/);
});

test('a cut-off first round is not carried on: there is no work to carry', async () => {
  // The retry exists to save a turn's tool calls. A turn that has made none is a model that
  // deliberated itself out of its budget before starting, and asking again just pays twice.
  const f = fixture([ranOutThinking]);
  const carriedOn: string[] = [];
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    onAutoContinue: ({ reason }) => carriedOn.push(reason),
    requestApproval: async () => true,
  });

  assert.equal(result.reason, 'truncated');
  assert.deepEqual(carriedOn, []);
});

test('an empty reply the server called stop is not retried, however much it thought', async () => {
  // Only the lid earns a retry. A model that thought and then chose to say nothing will choose
  // it again, and the round costs a full prompt either way.
  const f = fixture([
    { content: '', toolCalls: [call] },
    { content: '', toolCalls: [], reasoning: 'Nothing to add.', finishReason: 'stop' },
  ]);
  const carriedOn: string[] = [];
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    onAutoContinue: ({ reason }) => carriedOn.push(reason),
    requestApproval: async () => true,
  });

  assert.equal(result.reason, 'truncated');
  assert.deepEqual(carriedOn, []);
});

test('an ordinary empty reply with no reasoning is still an ordinary finish', async () => {
  const f = fixture([{ content: '', toolCalls: [], finishReason: 'stop' }]);
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });
  assert.equal(result.reason, 'finished', 'only a budget-exhausted reply counts as truncated');
});

test('an unattended run stopped at its ceiling is asked for a report, with its tools withdrawn', async () => {
  const f = fixture([
    { content: 'Let me check the workspace.', toolCalls: [call] },
    { content: 'Let me check whether ImageTk is available.', toolCalls: [{ ...call, id: 'call-2' }] },
    { content: 'Built nothing yet: ImageTk is missing, and a virtual environment would fix that.', toolCalls: [] },
  ]);
  const streamed: string[] = [];
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    maxRounds: 2,
    reportWhenStopped: true,
    onContent: (chunk) => streamed.push(chunk),
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  // Still a stop at the ceiling, and still two rounds: the report is not another round of work.
  assert.equal(result.reason, 'limit');
  assert.equal(result.rounds, 2);
  assert.equal(result.toolCalls, 2);
  assert.equal(f.requests.length, 3);

  const asked = f.requests[2];
  assert.equal(asked.tools, undefined, 'the report request must not offer tools');
  // The loop hands its own growing array to every request, so look the prompt up by id.
  const prompt = asked.messages.find((message) => message.id === 'report_2');
  assert.equal(prompt?.role, 'user');
  assert.match(prompt?.content ?? '', /last of your 2 rounds[\s\S]*Write your report now/);

  // The report is the end of what the person reads, set apart from the sentence it follows.
  assert.match(result.content, /ImageTk is available\.\n\nBuilt nothing yet/);
  assert.equal(streamed.join(''), result.content);
  assert.equal(result.transcript.at(-1)!.role, 'assistant');
  assert.match(result.transcript.at(-1)!.content, /virtual environment/);
});

test('a run stopped for repeating itself reports too, and says why it was stopped', async () => {
  const f = fixture([
    { content: '', toolCalls: [call] },
    { content: '', toolCalls: [{ ...call, id: 'call-2' }] },
    { content: '', toolCalls: [{ ...call, id: 'call-3' }] },
    { content: 'pwd kept printing the same directory; the build script is not there.', toolCalls: [] },
  ]);
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    reportWhenStopped: true,
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(result.reason, 'stalled');
  assert.equal(result.rounds, 3);
  const prompt = f.requests[3].messages.find((message) => message.id === 'report_3');
  assert.match(prompt?.content ?? '', /same tool call with the same arguments 3 times/);
  // Nothing came before the report, so nothing separates it.
  assert.equal(result.content, 'pwd kept printing the same directory; the build script is not there.');
});

test('interactive turns are not asked for a report — they can simply be told to continue', async () => {
  const f = fixture([
    { content: '', toolCalls: [call] },
    { content: 'Unreachable.', toolCalls: [] },
  ]);
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    maxRounds: 1,
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });
  assert.equal(result.reason, 'limit');
  assert.equal(f.requests.length, 1);
});

test('a report that cannot be had leaves the run stopped, not crashed', async () => {
  const f = fixture([{ content: 'Working on it.', toolCalls: [call] }]);
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    maxRounds: 1,
    reportWhenStopped: true,
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });
  // The fixture's script is exhausted, so the report request throws.
  assert.equal(result.reason, 'limit');
  assert.equal(result.content, 'Working on it.');
});

test('a run cancelled while it reports is cancelled, not stopped at the ceiling', async () => {
  const controller = new AbortController();
  const provider: StreamingProvider = {
    async stream(next) {
      if (!next.tools) {
        controller.abort();
        throw new Error('the turn was stopped');
      }
      return { content: '', toolCalls: [call] };
    },
  };
  const f = fixture([]);
  await assert.rejects(
    runToolLoop({
      provider,
      toolRuntime: f.runtime,
      request,
      runId: 'run',
      mode: 'full',
      maxRounds: 1,
      signal: controller.signal,
      reportWhenStopped: true,
      onContent: () => undefined,
      onActivity: () => undefined,
      requestApproval: async () => true,
    }),
    /cancelled/
  );
});

test('a call cut off by the output limit is explained as that, and never run', async () => {
  // What llama.cpp streams when max_tokens runs out inside a write_file: a named call whose
  // arguments stop mid-string, and finish_reason "length".
  const complete = { ...call, id: 'call-a' };
  const truncated = {
    id: 'call-b',
    type: 'function' as const,
    function: { name: 'antimatter__run_command', arguments: '{"command":"cat > paint.py <<EOF\\nimport tkin' },
  };
  const f = fixture([
    { content: '', toolCalls: [complete, truncated], finishReason: 'length' },
    { content: 'I will write it in parts.', toolCalls: [] },
  ]);
  const activity: string[] = [];
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request: { ...request, maxTokens: 8192 },
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: (event) => activity.push(`${event.callId}:${event.status}`),
    requestApproval: async () => true,
  });

  // The complete call before it still ran; the cut-off one did not.
  assert.deepEqual(f.calls, [{ name: 'run_command', args: { command: 'pwd' } }]);
  assert.ok(activity.includes('call-b:failed'), activity.join(','));
  const told = result.transcript.find((message) => message.role === 'tool' && message.toolCallId === 'call-b');
  assert.match(told?.content ?? '', /reached its output limit of 8192 tokens while it was still writing this run_command call/);
  assert.match(told?.content ?? '', /"append": true/);
  const stored = result.transcript
    .find((message) => message.toolCalls?.some((entry) => entry.id === 'call-b'))
    ?.toolCalls?.find((entry) => entry.id === 'call-b');
  const repaired = JSON.parse(stored?.function.arguments ?? '{}');
  assert.deepEqual(repaired._antimatter, {
    invalidToolArguments: true,
    reason: 'output_limit',
    originalCharacters: truncated.function.arguments.length,
  });
  assert.doesNotMatch(f.requests[1].messages.flatMap((message) => message.toolCalls ?? []).find((entry) => entry.id === 'call-b')?.function.arguments ?? '', /import tkin/);
  assert.equal(result.reason, 'finished');
});

test('unreadable arguments with no output limit involved are still reported as unreadable', async () => {
  const f = fixture([
    { content: '', toolCalls: [{ ...call, function: { ...call.function, arguments: '{"command": pwd}' } }], finishReason: 'tool_calls' },
    { content: 'Done.', toolCalls: [] },
  ]);
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });
  const told = result.transcript.find((message) => message.role === 'tool');
  assert.match(told?.content ?? '', /could not read the arguments for run_command/);
  const stored = result.transcript.find((message) => message.toolCalls?.length)?.toolCalls?.[0];
  assert.equal(JSON.parse(stored?.function.arguments ?? '{}')._antimatter.reason, 'invalid_json');
  assert.equal(f.calls.length, 0);
});

test('valid JSON that is not an argument object is rejected and normalized for history', async () => {
  const invalid = ['null', '[]', '1', '"text"'];
  const calls = invalid.map((arguments_, index) => ({
    id: `bad-shape-${index}`,
    type: 'function' as const,
    function: { name: 'antimatter__run_command', arguments: arguments_ },
  }));
  const f = fixture([
    { content: '', toolCalls: calls },
    { content: 'None of those calls ran.', toolCalls: [] },
  ]);

  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'bad-shapes',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.deepEqual(f.calls, []);
  const stored = result.transcript.find((message) => message.toolCalls?.length === invalid.length)?.toolCalls ?? [];
  assert.equal(stored.length, invalid.length);
  for (const entry of stored) {
    assert.deepEqual(JSON.parse(entry.function.arguments)._antimatter, {
      invalidToolArguments: true,
      reason: 'invalid_json',
      originalCharacters: invalid[Number(entry.id.split('-').at(-1))].length,
    });
  }
  for (const entry of calls) {
    assert.match(
      result.transcript.find((message) => message.toolCallId === entry.id)?.content ?? '',
      /could not read the arguments/
    );
  }
});

/** A workspace with write_file and file_info that remembers what was written. */
function workspaceFiles(
  existing: Record<string, string> = {},
  afterAbsent?: (disk: Record<string, string>, path: string) => void
) {
  const disk: Record<string, string> = { ...existing };
  const calls: Array<{ name: string; args: Record<string, unknown>; createOnly?: boolean }> = [];
  const offered = (name: string) => ({
    serverId: 'antimatter',
    serverName: 'Antimatter tools',
    tool: { name, description: name, inputSchema: { type: 'object', properties: {} }, enabled: true },
  });
  const runtime: ToolRuntime = {
    enabledTools: () => [offered('write_file'), offered('file_info')],
    async callTool(_server, name, args, options?: ToolCallOptions) {
      calls.push({ name, args, ...(options?.createOnly ? { createOnly: true } : {}) });
      // The real tools resolve paths against the workspace, so ./a and a are one file.
      const path = String(args.path).replace(/^\.\//, '');
      if (name === 'file_info') {
        if (path in disk) return { ok: true, text: `path: ${path}\ntype: file` };
        afterAbsent?.(disk, path);
        return { ok: false, text: `ENOENT: no such file or directory, stat '/work/${path}'` };
      }
      if (name === 'read_file') {
        const from = Number(args.start_line ?? 1);
        const lines = (disk[path] ?? '').split('\n').slice(from - 1, Number(args.end_line ?? 1e9));
        return { ok: true, text: lines.map((line, index) => `${from + index}\t${line}`).join('\n') };
      }
      const content = String(args.content);
      if (options?.createOnly && path in disk) {
        return { ok: false, text: `Refused create-only write to ${path}; the existing file was left unchanged.` };
      }
      disk[path] = args.append === true ? `${disk[path] ?? ''}${content}` : content;
      return { ok: true, text: `Wrote ${content.length} characters to ${path}.` };
    },
  };
  return { disk, calls, runtime };
}

const cutWrite = (raw: string) => ({
  id: 'w1',
  type: 'function' as const,
  function: { name: 'antimatter__write_file', arguments: raw },
});

const replies = (raw: string) => {
  const sent: ChatRequest[] = [];
  const results: StreamResult[] = [
    { content: '', toolCalls: [cutWrite(raw)], finishReason: 'length' },
    { content: 'Carrying on.', toolCalls: [] },
  ];
  const provider: StreamingProvider = {
    async stream(next) {
      sent.push(next);
      return results.shift()!;
    },
  };
  return { provider, sent };
};

const toldAbout = (transcript: Array<{ role: string; toolCallId?: string; content?: string | null }>) =>
  transcript.find((message) => message.role === 'tool' && message.toolCallId === 'w1')?.content ?? '';

test('a write cut off by the output limit keeps what arrived, and says where to carry on', async () => {
  const files = workspaceFiles();
  const model = replies('{"path":"gimp_clone.py","content":"import tkinter as tk\\nfrom PIL import Image\\nclass Ed');
  const activity: Array<{ status: string; args: string }> = [];
  const result = await runToolLoop({
    provider: model.provider,
    toolRuntime: files.runtime,
    request: { ...request, maxTokens: 8192 },
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: (event) => activity.push({ status: event.status, args: event.args }),
    requestApproval: async () => true,
  });

  assert.equal(files.disk['gimp_clone.py'], 'import tkinter as tk\nfrom PIL import Image\n');
  // Checked that nothing was there to overwrite, then wrote.
  assert.deepEqual(files.calls.map((call) => call.name), ['file_info', 'write_file']);
  assert.deepEqual(files.calls[1].args, { path: 'gimp_clone.py', content: 'import tkinter as tk\nfrom PIL import Image\n' });
  assert.equal(files.calls[1].createOnly, true);
  assert.equal(activity.at(-1)?.status, 'done');
  assert.match(activity.at(-1)?.args ?? '', /"path": "gimp_clone\.py"/);

  const told = toldAbout(result.transcript);
  assert.match(told, /reached the reply's output limit of 8192 tokens, and its content was cut off/);
  assert.match(told, /the first 2 lines are now in gimp_clone\.py/);
  assert.match(told, /they are already written:\n```\n1\timport tkinter as tk\n2\tfrom PIL import Image\n```/);
  assert.match(told, /"append": true/);
  assert.equal(result.reason, 'finished');
});

test('a cut-off new-file salvage cannot replace a path that appears after its probe', async () => {
  const files = workspaceFiles({}, (disk, path) => {
    disk[path] = 'created by somebody else\n';
  });
  const model = replies('{"path":"raced.py","content":"partial generated file\\nclass Ed');
  const result = await runToolLoop({
    provider: model.provider,
    toolRuntime: files.runtime,
    request: { ...request, maxTokens: 8192 },
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(files.disk['raced.py'], 'created by somebody else\n');
  assert.equal(files.calls.find((entry) => entry.name === 'write_file')?.createOnly, true);
  assert.match(toldAbout(result.transcript), /existing file was left unchanged/i);
});

test('a cut-off write is not put over a file that exists unless it said it appends', async () => {
  const files = workspaceFiles({ 'gimp_clone.py': 'part one\n' });
  const model = replies('{"path":"gimp_clone.py","content":"part two\\nmore\\npar');
  const result = await runToolLoop({
    provider: model.provider,
    toolRuntime: files.runtime,
    request: { ...request, maxTokens: 8192 },
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(files.disk['gimp_clone.py'], 'part one\n');
  // Existing means protected: no prefix comparison can prove that a replacement is complete.
  assert.deepEqual(files.calls.map((call) => call.name), ['file_info']);
  const told = toldAbout(result.transcript);
  assert.match(told, /arguments were cut off and nothing ran/);
  assert.match(told, /cut-off replacement is never put over a file that already exists/i);
});

test('a cut-off write that begins the way an existing file does leaves it untouched', async () => {
  // Matching the opening proves this was a rewrite, but never that the rewrite reached its end.
  const files = workspaceFiles({ 'editor.py': '#!/usr/bin/env python3\n"""Image editor."""\nimport os\nold()\n' });
  const raw = JSON.stringify({ path: 'editor.py', content: '#!/usr/bin/env python3\n"""Image editor."""\nimport tkinter as tk\nclass Editor:\n' });
  const model = replies(raw.slice(0, raw.indexOf('class') + 5));
  const result = await runToolLoop({
    provider: model.provider,
    toolRuntime: files.runtime,
    request: { ...request, maxTokens: 8192 },
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(files.disk['editor.py'], '#!/usr/bin/env python3\n"""Image editor."""\nimport os\nold()\n');
  assert.deepEqual(files.calls.map((call) => call.name), ['file_info']);
  assert.match(toldAbout(result.transcript), /cut off and nothing ran/);
  assert.match(toldAbout(result.transcript), /never put over a file that already exists/);
});

test('a cut-off write with explicit append false still leaves an existing file untouched', async () => {
  const files = workspaceFiles({ 'editor.py': 'complete old file\n' });
  const model = replies('{"path":"editor.py","append":false,"content":"partial replacement\\nclass Ed');
  const result = await runToolLoop({
    provider: model.provider,
    toolRuntime: files.runtime,
    request: { ...request, maxTokens: 8192 },
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(files.disk['editor.py'], 'complete old file\n');
  assert.deepEqual(files.calls.map((call) => call.name), ['file_info']);
  assert.match(toldAbout(result.transcript), /cut off and nothing ran/);
});

test('a cut-off write whose content came before its path is explained, and taught the order', async () => {
  // What qwen3-coder-next-80b sent on its third try at a GIMP clone.
  const files = workspaceFiles();
  const model = replies('{"content":"#!/usr/bin/env python3\nimport tkinter as tk\nfrom PIL import Ima');
  const result = await runToolLoop({
    provider: model.provider,
    toolRuntime: files.runtime,
    request: { ...request, maxTokens: 8192 },
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.deepEqual(files.calls, []);
  const told = toldAbout(result.transcript);
  assert.match(told, /arguments were cut off and nothing ran/);
  assert.match(told, /give "path" and "append" before "content", so that a cut-off first part can still be saved/i);
});

test('a cut-off part that said it appends is appended', async () => {
  const files = workspaceFiles({ 'gimp_clone.py': 'part one\n' });
  const model = replies('{"path":"gimp_clone.py","append":true,"content":"part two\\nmore\\npar');
  const result = await runToolLoop({
    provider: model.provider,
    toolRuntime: files.runtime,
    request: { ...request, maxTokens: 8192 },
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(files.disk['gimp_clone.py'], 'part one\npart two\nmore\n');
  assert.deepEqual(files.calls.map((call) => call.name), ['write_file']);
  assert.match(toldAbout(result.transcript), /the first 2 lines were added to the end of gimp_clone\.py/);
});

test('a salvaged write is still put to the person, and a refusal says the call was cut off', async () => {
  const files = workspaceFiles();
  const model = replies('{"path":"gimp_clone.py","content":"import tkinter as tk\\nfrom PIL import Image\\nclass Ed');
  const asked: string[] = [];
  const result = await runToolLoop({
    provider: model.provider,
    toolRuntime: files.runtime,
    request: { ...request, maxTokens: 8192 },
    runId: 'run',
    mode: 'ask',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async (activity) => {
      asked.push(activity.args);
      return false;
    },
  });

  // The person saw what would be written, and said no.
  assert.equal(asked.length, 1);
  assert.match(asked[0], /"content": "import tkinter as tk\\nfrom PIL import Image\\n"/);
  assert.equal(files.disk['gimp_clone.py'], undefined);
  assert.match(
    toldAbout(result.transcript),
    /^write_file was declined, so nothing ran\. This call had also reached the reply's output limit of 8192 tokens, and its content was cut off after 2 lines, so nothing of it was written\./
  );
});

test('the part appended after a cut does not repeat where the file stopped', async () => {
  const files = workspaceFiles();
  const results: StreamResult[] = [
    {
      content: '',
      toolCalls: [cutWrite('{"path":"editor.py","content":"class Editor:\\n    def draw(self):\\n        if self.tool == \\"line\\":\\n            self.pre')],
      finishReason: 'length',
    },
    {
      content: '',
      toolCalls: [
        {
          id: 'w2',
          type: 'function',
          function: {
            name: 'antimatter__write_file',
            // Starts again from the two lines it was shown.
            arguments: JSON.stringify({
              path: './editor.py',
              content: '    def draw(self):\n        if self.tool == "line":\n            self.preview()\n',
              append: true,
            }),
          },
        },
      ],
    },
    { content: 'Done.', toolCalls: [] },
  ];
  const provider: StreamingProvider = { stream: async () => results.shift()! };
  const result = await runToolLoop({
    provider,
    toolRuntime: files.runtime,
    request: { ...request, maxTokens: 8192 },
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(files.disk['editor.py'], 'class Editor:\n    def draw(self):\n        if self.tool == "line":\n            self.preview()\n');
  const appended = files.calls.find((call) => call.args.append === true);
  assert.equal(appended?.args.content, '            self.preview()\n');
  const told = result.transcript.find((message) => message.role === 'tool' && message.toolCallId === 'w2')?.content ?? '';
  assert.match(told, /\(Its first 2 lines repeated the end of the file, so Antimatter left them out\.\)$/);
});

test('an append that was not preceded by a cut is written as asked', async () => {
  const files = workspaceFiles({ 'notes.md': '- one\n- two\n' });
  const results: StreamResult[] = [
    {
      content: '',
      toolCalls: [{ id: 'w1', type: 'function', function: { name: 'antimatter__write_file', arguments: JSON.stringify({ path: 'notes.md', append: true, content: '- one\n- two\n' }) } }],
    },
    { content: 'Done.', toolCalls: [] },
  ];
  const provider: StreamingProvider = { stream: async () => results.shift()! };
  await runToolLoop({
    provider,
    toolRuntime: files.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });
  assert.equal(files.disk['notes.md'], '- one\n- two\n- one\n- two\n');
});

test('a cut-off part of a file the turn was continuing is added to it, though its flag never arrived', async () => {
  const files = workspaceFiles();
  const first = JSON.stringify({ path: 'editor.py', content: 'import tkinter as tk\nclass Editor:\n    def undo(self):\n        pass\n' });
  // The next part, written path-content-append as qwen3-coder-next-80b writes it, cut off in its content.
  const second = JSON.stringify({ path: 'editor.py', content: '    def redo(self):\n        if self.redo_stack:\n            self.apply()\n', append: true });
  const results: StreamResult[] = [
    { content: '', toolCalls: [cutWrite(first.slice(0, first.indexOf('pass')))], finishReason: 'length' },
    {
      content: '',
      toolCalls: [{ ...cutWrite(second.slice(0, second.indexOf('self.apply') + 4)), id: 'w2' }],
      finishReason: 'length',
    },
    { content: 'Done.', toolCalls: [] },
  ];
  const provider: StreamingProvider = { stream: async () => results.shift()! };
  const result = await runToolLoop({
    provider,
    toolRuntime: files.runtime,
    request: { ...request, maxTokens: 8192 },
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(
    files.disk['editor.py'],
    'import tkinter as tk\nclass Editor:\n    def undo(self):\n    def redo(self):\n        if self.redo_stack:\n'
  );
  const writes = files.calls.filter((call) => call.name === 'write_file');
  assert.deepEqual(writes.map((call) => call.args.append), [undefined, true]);
  const told = result.transcript.find((message) => message.role === 'tool' && message.toolCallId === 'w2')?.content ?? '';
  assert.match(told, /the first 2 lines were added to the end of editor\.py/);
});

test('auto-continue carries a turn that stopped on its next step, and stops at the allowance', async () => {
  const f = fixture([
    { content: 'Reading the SDK.', toolCalls: [call] },
    { content: 'Cloned it. Now let me wire the processor up:', toolCalls: [] },
    { content: 'Wired. Next, I will build it:', toolCalls: [] },
    { content: 'Still going. Let me run the tests:', toolCalls: [] },
  ]);
  const nudges: Array<{ attempt: number; reason: string }> = [];
  let streamed = '';

  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    autoContinue: { enabled: true, maxContinues: 2, onRoundLimit: true },
    onAutoContinue: ({ attempt, reason }) => nudges.push({ attempt, reason }),
    onContent: (chunk) => {
      streamed += chunk;
    },
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.deepEqual(nudges, [
    { attempt: 1, reason: 'stopped-mid-work' },
    { attempt: 2, reason: 'stopped-mid-work' },
  ]);
  assert.equal(result.rounds, 4, 'the turn ends on its own once the allowance is spent');
  assert.equal(result.reason, 'finished');
  // One turn, read as one turn: everything it wrote is in the visible text, in order.
  assert.match(streamed, /Cloned it\..*Wired\..*Still going\./s);
  // And it picks up rather than starting again: the tool result from round one is still there.
  const last = f.requests[f.requests.length - 1].messages;
  assert.ok(last.some((message) => message.role === 'tool' && message.content === 'exit 0'));
  assert.equal(last.filter((message) => message.id.startsWith('auto_continue_')).length, 2);
});

test('auto-continue leaves a finished answer, and an untouched turn, alone', async () => {
  const settled = fixture([
    { content: 'Reading.', toolCalls: [call] },
    { content: 'Done. The plugin builds and loads.', toolCalls: [] },
  ]);
  const finished = await runToolLoop({
    provider: settled.provider,
    toolRuntime: settled.runtime,
    request,
    runId: 'run',
    mode: 'full',
    autoContinue: { enabled: true, maxContinues: 3, onRoundLimit: true },
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });
  assert.equal(finished.rounds, 2);

  // A turn that called no tool was never mid-work, whatever its last line looks like.
  const talking = fixture([{ content: 'Now let me explain how that would work:', toolCalls: [] }]);
  const chatted = await runToolLoop({
    provider: talking.provider,
    toolRuntime: talking.runtime,
    request,
    runId: 'run',
    mode: 'full',
    autoContinue: { enabled: true, maxContinues: 3, onRoundLimit: true },
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });
  assert.equal(chatted.rounds, 1);
});

test('the round ceiling buys another allowance rather than ending the turn', async () => {
  const f = fixture([
    { content: '', toolCalls: [call] },
    { content: '', toolCalls: [call] },
    { content: 'Done.', toolCalls: [] },
  ]);
  const nudges: string[] = [];

  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    maxRounds: 1,
    autoContinue: { enabled: true, maxContinues: 3, onRoundLimit: true },
    onAutoContinue: ({ reason }) => nudges.push(reason),
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.deepEqual(nudges, ['round-limit', 'round-limit']);
  assert.equal(result.reason, 'finished');
  assert.equal(result.toolCalls, 2);
});

test('the round ceiling still ends a turn when that switch is off', async () => {
  const f = fixture([{ content: '', toolCalls: [call] }, { content: 'Done.', toolCalls: [] }]);
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    maxRounds: 1,
    autoContinue: { enabled: true, maxContinues: 3, onRoundLimit: false },
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.equal(result.reason, 'limit');
  assert.equal(result.rounds, 1);
});

test('thinking reaches the caller as it arrives, and never as part of the answer', async () => {
  // The frames a reasoning model actually produces: a long deliberation, then a short answer and
  // a tool call. On MiMo here the ratio was 12,400 tokens of the first to about 300 of the rest,
  // so what the loop does with these frames decides whether a twelve-minute turn shows anything.
  const provider: StreamingProvider = {
    async stream(_next, callback) {
      callback({ id: 'chunk', content: '', reasoning: 'Which file owns ' });
      callback({ id: 'chunk', content: '', reasoning: 'the console?' });
      callback({ id: 'chunk', content: 'Looking now.' });
      return { content: 'Looking now.', reasoning: 'Which file owns the console?', toolCalls: [] };
    },
  };
  const f = fixture([]);
  const content: string[] = [];
  const thinking: string[] = [];

  const result = await runToolLoop({
    provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: (chunk) => content.push(chunk),
    onReasoning: (chunk) => thinking.push(chunk),
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  // Fragment by fragment, in order: a caller that only learns of it at the end learns of it too
  // late to show anything while the turn is running.
  assert.deepEqual(thinking, ['Which file owns ', 'the console?']);
  // A reasoning frame carries no content, so it must not reach onContent at all — an empty chunk
  // there is a token the transcript counts and a first-token time it would move.
  assert.deepEqual(content, ['Looking now.']);
  assert.equal(result.content, 'Looking now.');
});

test('a loop given no reasoning handler still runs a thinking model', async () => {
  const provider: StreamingProvider = {
    async stream(_next, callback) {
      callback({ id: 'chunk', content: '', reasoning: 'At length.' });
      callback({ id: 'chunk', content: 'Done.' });
      return { content: 'Done.', reasoning: 'At length.', toolCalls: [] };
    },
  };
  const f = fixture([]);
  const content: string[] = [];

  const result = await runToolLoop({
    provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: (chunk) => content.push(chunk),
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.deepEqual(content, ['Done.']);
  assert.equal(result.content, 'Done.');
});

/** A fixture whose server also offers a read tool, so the read/write distinction is testable. */
function readFixture(results: StreamResult[]) {
  const ran: Array<{ name: string; args: Record<string, unknown> }> = [];
  const provider: StreamingProvider = {
    async stream(_next, callback) {
      const result = results.shift();
      if (!result) throw new Error('provider script exhausted');
      if (result.content) callback({ id: 'chunk', content: result.content });
      return result;
    },
  };
  const runtime: ToolRuntime = {
    enabledTools: () => [
      {
        serverId: 'antimatter',
        serverName: 'Antimatter tools',
        tool: { name: 'read_file', description: 'Read.', inputSchema: { type: 'object' }, enabled: true },
      },
      {
        serverId: 'antimatter',
        serverName: 'Antimatter tools',
        tool: { name: 'run_command', description: 'Run.', inputSchema: { type: 'object' }, enabled: true },
      },
    ],
    async callTool(_server, name, args) {
      ran.push({ name, args });
      return { ok: true, text: 'contents' };
    },
  };
  return { provider, runtime, ran };
}

const reads = (path: string, id: string) => ({
  id,
  type: 'function' as const,
  function: { name: 'antimatter__read_file', arguments: JSON.stringify({ path }) },
});

test('a reply that asks for the same read twice only makes it once', async () => {
  // Carbon 95bf32a1: one batch of sixteen read src/main/index.ts four times and toolLoop.ts three
  // times. 39% of that round's results were byte-identical repeats — the window paid for each.
  const f = readFixture([
    {
      content: '',
      toolCalls: [reads('a.ts', 'c1'), reads('b.ts', 'c2'), reads('a.ts', 'c3'), reads('a.ts', 'c4')],
    },
    { content: 'Read them.', toolCalls: [] },
  ]);
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.deepEqual(f.ran, [
    { name: 'read_file', args: { path: 'a.ts' } },
    { name: 'read_file', args: { path: 'b.ts' } },
  ]);
  // A call that never ran must not be in the transcript, or it is a tool_call with no result on
  // every later request.
  const assistant = result.transcript.find((m) => m.id === 'assistant_0');
  assert.equal(assistant?.toolCalls?.length, 2);
  assert.equal(result.transcript.filter((m) => m.role === 'tool').length, 2);
});

test('two identical commands in one reply are two runs, not one', async () => {
  // Read twice cannot differ. Append twice means append twice, and collapsing it would change
  // what the turn did.
  const twice = {
    id: 'x',
    type: 'function' as const,
    function: { name: 'antimatter__run_command', arguments: JSON.stringify({ command: 'echo hi >> log' }) },
  };
  const f = readFixture([
    { content: '', toolCalls: [twice, { ...twice, id: 'y' }] },
    { content: 'Done.', toolCalls: [] },
  ]);
  await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });
  assert.equal(f.ran.length, 2);
});

test('the same call three times inside one reply is a careless batch, not a stalled turn', async () => {
  // What killed carbon 95bf32a1 on its first round. A reply picks its whole batch before any
  // result arrives, so three identical calls in it are one decision — and the turn was ended with
  // "something it needs is not where it is looking", which was true of nothing.
  const same = {
    id: 'r1',
    type: 'function' as const,
    function: { name: 'antimatter__run_command', arguments: JSON.stringify({ command: 'pwd' }) },
  };
  const f = readFixture([
    { content: '', toolCalls: [same, { ...same, id: 'r2' }, { ...same, id: 'r3' }] },
    { content: 'Carried on.', toolCalls: [] },
  ]);
  const result = await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request,
    runId: 'run',
    mode: 'full',
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.notEqual(result.reason, 'stalled');
  assert.equal(result.content, 'Carried on.');
  assert.equal(f.ran.length, 3, 'the calls still run; only the verdict on them changed');
});

test('the context meter is fed every round, not only when history is dropped', async () => {
  // Two rounds: a tool call, then the reply. Nothing is ever compacted, so `onCompaction`
  // stays silent - which is exactly the case where the old meter sat still for a whole turn.
  const f = fixture([
    { content: '', toolCalls: [call] },
    { content: 'Done.', toolCalls: [] },
  ]);
  const messages: ChatRequest['messages'] = [
    { id: 'system', role: 'system', content: 'system' },
    { id: 'task', role: 'user', content: 'Do the work.' },
  ];
  const reports: Array<{ round: number; estimated: number; budget?: number; compacted: number; tools: number }> = [];
  const compactions: number[] = [];

  await runToolLoop({
    provider: f.provider,
    toolRuntime: f.runtime,
    request: { ...request, messages },
    runId: 'run',
    mode: 'full',
    // A generous budget: this fit never drops anything.
    fit: (conversation) => fitToBudget(conversation, 1_000_000),
    onContext: (event) =>
      reports.push({
        round: event.round,
        estimated: event.estimatedTokens,
        budget: event.budgetTokens,
        compacted: event.totalCompacted,
        tools: event.tools.length,
      }),
    onCompaction: (event) => compactions.push(event.compacted),
    onContent: () => undefined,
    onActivity: () => undefined,
    requestApproval: async () => true,
  });

  assert.deepEqual(compactions, [], 'nothing was compacted, so the old signal never fired');
  assert.ok(reports.length >= 2, `expected a report per round, got ${reports.length}`);
  assert.deepEqual(reports.map((report) => report.round).slice(0, 2), [0, 1]);
  // The whole point: the estimate grows as the turn's own tool results accumulate.
  assert.ok(
    reports[reports.length - 1].estimated > reports[0].estimated,
    `the estimate must climb across rounds, saw ${reports.map((r) => r.estimated).join(' -> ')}`
  );
  // Nothing was dropped, so the meter must not claim any compaction.
  assert.deepEqual([...new Set(reports.map((report) => report.compacted))], [0]);
  // The live toolset travels with the reading, as it does with a compaction event.
  assert.ok(reports.every((report) => report.tools === 1));
  assert.ok(reports.every((report) => (report.budget ?? 0) > 0));
});
