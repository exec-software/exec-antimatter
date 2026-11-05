import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedUnattended, decide, isTrustedTool, tierOf } from '../src/main/toolPolicy';
import { ASK_SERVER, ASK_TOOL_NAME, withAsk } from '../src/main/ask/tools';
import type { AskOutcome, AskRequest } from '../src/api/ask';
import type { ToolRuntime } from '../src/main/toolLoop';

/**
 * Serving `ask_user`: who is offered it, where an answer is allowed to come from, and what the
 * model is told when there is nobody to answer.
 *
 * The case that matters most is the one with no person in it. A blocking question in an
 * unattended run would hold that run until its own deadline and then fail for a reason that looks
 * nothing like the cause, so the tool has to be absent there rather than merely unapproved.
 */

const base = (): ToolRuntime => ({
  enabledTools: () => [],
  callTool: async () => ({ ok: true, attempted: true, text: 'inner' }),
});

const activity = { runId: 'run-1', callId: 'call-1', activityId: 'occurrence-1' } as never;

const serve = (
  options: { canAsk?: boolean; answer?: (request: AskRequest) => AskOutcome | Promise<AskOutcome> } = {}
) => {
  const asked: { askId: string; runId: string; request: AskRequest }[] = [];
  const runtime = withAsk(base(), {
    runId: 'run-1',
    canAsk: () => options.canAsk ?? true,
    ask: async (question) => {
      asked.push(question);
      return options.answer
        ? options.answer(question.request)
        : { kind: 'answered', answers: [{ chosen: ['sqlite'], text: null }], note: null };
    },
  });
  return { runtime, asked };
};

const call = (runtime: ToolRuntime, args: Record<string, unknown>) =>
  runtime.callTool(ASK_SERVER, ASK_TOOL_NAME, args, { activity });

const question = { questions: [{ header: 'Store', question: 'Which store?', options: ['sqlite', 'json'] }] };

test('the tool is offered when a person is watching, and absent when none is', () => {
  const watched = serve({ canAsk: true }).runtime.enabledTools();
  assert.deepEqual(watched.map((entry) => entry.tool.name), [ASK_TOOL_NAME]);
  assert.equal(watched[0].serverId, ASK_SERVER);
  assert.deepEqual(serve({ canAsk: false }).runtime.enabledTools(), []);
});

test('an unattended run that calls it anyway is told to decide for itself', async () => {
  // A cached tool definition from an earlier round must not outlive the window that justified it.
  const result = await call(serve({ canAsk: false }).runtime, question);
  assert.equal(result.ok, false);
  assert.equal(result.attempted, false);
  assert.match(result.text, /nobody watching/i);
  assert.match(result.text, /Decide it yourself/);
});

test('an answer comes back as the call’s result, so the turn carries on', async () => {
  const { runtime, asked } = serve();
  const result = await call(runtime, question);
  assert.equal(result.ok, true);
  assert.equal(result.attempted, true);
  assert.match(result.text, /sqlite/);
  // Keyed to the occurrence, not the model's say-so: an answer must route to the call that asked.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].askId, 'run-1:occurrence-1');
  assert.equal(asked[0].runId, 'run-1');
});

test('a malformed question is refused without anyone being shown anything', async () => {
  const { runtime, asked } = serve();
  const result = await call(runtime, { questions: [] });
  assert.equal(result.ok, false);
  // `attempted: false` matters: nothing was put to anyone, so the model may safely try again.
  assert.equal(result.attempted, false);
  assert.match(result.text, /at least one question/);
  assert.equal(asked.length, 0);
});

test('an unanswered question is not reported as a success', async () => {
  for (const kind of ['interrupted', 'dismissed'] as const) {
    const { runtime } = serve({ answer: () => ({ kind, answers: [], note: null }) });
    const result = await call(runtime, question);
    assert.equal(result.ok, false, kind);
    assert.doesNotMatch(result.text, /sqlite/);
  }
  // Discussing is a real answer, so it is not a failure — the turn ends and the model talks.
  const { runtime } = serve({ answer: () => ({ kind: 'discuss', answers: [], note: null }) });
  assert.equal((await call(runtime, question)).ok, true);
});

test('every other tool passes straight through, untouched', async () => {
  const { runtime, asked } = serve();
  const result = await runtime.callTool('antimatter', 'read_file', { path: 'x' }, { activity });
  assert.equal(result.text, 'inner');
  assert.equal(asked.length, 0);
  assert.equal((await runtime.callTool(ASK_SERVER, 'ask_something_else', {}, { activity })).ok, false);
});

test('a call that cannot be identified does not ask, since no answer could reach it', async () => {
  const { runtime, asked } = serve();
  const result = await runtime.callTool(ASK_SERVER, ASK_TOOL_NAME, question, {});
  assert.equal(result.ok, false);
  assert.equal(asked.length, 0);
});

/** Permissions. Asking is not an action on the project, and it is never unattended. */

test('asking needs no approval in any access mode', () => {
  assert.equal(tierOf(ASK_TOOL_NAME, ASK_SERVER), 'read');
  for (const mode of ['read', 'ask', 'full'] as const) {
    assert.equal(decide(ASK_TOOL_NAME, { mode, serverId: ASK_SERVER }), 'allow', mode);
  }
  // A question is not a file in the project, so an unnominated working directory does not bear
  // on it — and read-only permissions are exactly when a model most needs to be able to ask.
  assert.equal(decide(ASK_TOOL_NAME, { mode: 'read', serverId: ASK_SERVER, workspaceConfirmed: false }), 'allow');
});

test('an unattended run is never allowed the question tool', () => {
  assert.equal(allowedUnattended(ASK_TOOL_NAME, ASK_SERVER), false);
});

test('only the app’s own server may serve this name', () => {
  assert.equal(isTrustedTool(ASK_TOOL_NAME, ASK_SERVER), true);
  // A configured MCP server borrowing the name would be putting its own prompts in front of the
  // person under the app's framing.
  assert.equal(isTrustedTool(ASK_TOOL_NAME, 'some.mcp.server'), false);
  assert.equal(tierOf(ASK_TOOL_NAME, 'some.mcp.server'), 'danger');
});
