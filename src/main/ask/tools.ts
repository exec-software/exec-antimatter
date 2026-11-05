import { askIdFor, describeAskOutcome, parseAskRequest, type AskOutcome, type AskRequest } from '../../api/ask';
import type { McpTool } from '../mcp';
import type { ToolRuntime } from '../toolLoop';

export const ASK_SERVER = 'antimatter.ask';
const ASK_SERVER_NAME = 'Ask';

export const ASK_TOOL_NAME = 'ask_user';

/**
 * Asking the person something, mid-turn.
 *
 * The description carries the whole policy, because the policy is entirely about judgement and
 * there is nothing for code to enforce: a tool call that is technically valid can still be a
 * question that should never have been asked. So it says, in order, the one case this is for and
 * the four it is not — and it is blunt about the failure mode that matters, which is a model
 * asking instead of reading. Checking the repository is work the turn can do by itself; a
 * question is an interruption of a person who asked not to be interrupted.
 */
const askTool: McpTool = {
  name: ASK_TOOL_NAME,
  enabled: true,
  description:
    'Ask the user a short multiple-choice question and wait for their answer, without ending your turn. ' +
    'Use it when you have genuinely reached a fork that is theirs to decide and the options differ in ' +
    'a way they would care about — which of two existing conventions to follow, whether a migration may ' +
    'drop a column, which of three ambiguous things they meant. The answer comes back as this call\'s ' +
    'result and you carry straight on in the same turn. ' +
    'Do NOT use it: to ask something the project would tell you (read the files instead — a question you ' +
    'could have answered by looking is the worst use of this tool); to confirm a plan you have already ' +
    'been told to carry out; to ask permission to run something, which has its own approval prompt; or to ' +
    'check in on progress. Prefer one question over several, state the real trade-off in each option\'s ' +
    'description, and put the option you would pick first. If you can make the call yourself and say what ' +
    'you assumed, do that instead — it is almost always the better turn. ' +
    'The user can also answer in their own words, say they would rather discuss it, or close it unanswered; ' +
    'handle each as the result tells you, and never ask the same question twice.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        description: 'One to four questions, asked together. Prefer one.',
        items: {
          type: 'object',
          properties: {
            header: {
              type: 'string',
              description: 'Two to four words naming the decision, for the label on the card — for example "Error handling".',
            },
            question: {
              type: 'string',
              description: 'What you are asking, as one plain sentence. The user may be reading this without the rest of your reply in view, so make it stand on its own.',
            },
            options: {
              type: 'array',
              maxItems: 4,
              description:
                'Up to four answers to offer, most recommended first. Each needs a short "label" and should carry a ' +
                '"description" saying what choosing it means. The user can always answer in their own words instead, ' +
                'so do not add an "other" or "something else" option yourself.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'The choice, in a few words.' },
                  description: { type: 'string', description: 'What it means or what follows from it — the trade-off, not a restatement of the label.' },
                },
                required: ['label'],
                additionalProperties: false,
              },
            },
            multiSelect: {
              type: 'boolean',
              description: 'True when several options can sensibly be chosen together. Default false.',
            },
          },
          required: ['header', 'question', 'options'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
};

export interface AskRuntimeContext {
  /**
   * Whether there is a person on the other end of this turn.
   *
   * Not a convenience check. An unattended run — a schedule, an orchestrator, a delegated agent —
   * has nobody to answer, so a question there is not merely unanswerable: it would block the run
   * until its own deadline and then fail for a reason that looks nothing like the cause. Such a
   * turn must not be offered the tool at all, so it plans around not knowing instead.
   */
  canAsk(): boolean;
  /** The turn this runtime belongs to, used when an occurrence does not name its own. */
  runId: string;
  /** Puts the question to the person and resolves when they answer, or the turn ends. */
  ask(
    question: { askId: string; runId: string; request: AskRequest },
    signal?: AbortSignal
  ): Promise<AskOutcome>;
}

/**
 * Wraps a runtime with `ask_user`.
 *
 * Placed inside the Vault but outside the delegated agents, for the same reason the collaboration
 * tools are: the person is watching *this* conversation. An agent this turn starts runs
 * unattended by construction, and an agent that could stop and ask would strand a turn nobody is
 * looking at behind a question nobody will see.
 */
export function withAsk(runtime: ToolRuntime, context: AskRuntimeContext): ToolRuntime {
  return {
    enabledTools: () => {
      const inner = runtime.enabledTools();
      if (!context.canAsk()) return inner;
      return [...inner, { serverId: ASK_SERVER, serverName: ASK_SERVER_NAME, tool: askTool }];
    },
    prepareTool: (serverId, toolName, args, options) =>
      serverId !== ASK_SERVER && runtime.prepareTool
        ? runtime.prepareTool(serverId, toolName, args, options)
        : Promise.resolve({ args }),
    connectionErrors: () => runtime.connectionErrors?.() ?? [],
    async callTool(serverId, toolName, args, options) {
      if (serverId !== ASK_SERVER) return runtime.callTool(serverId, toolName, args, options);

      // The window may have gone, or the run been handed to an unattended owner, between the
      // round that read the tool definitions and this call.
      if (!context.canAsk()) {
        return {
          ok: false,
          attempted: false,
          text: 'There is nobody watching this run to answer a question. Decide it yourself and say what you assumed, or stop and explain what you need.',
        };
      }
      if (toolName !== ASK_TOOL_NAME) {
        return { ok: false, attempted: false, text: `There is no tool named ${toolName}.` };
      }

      let request: AskRequest;
      try {
        request = parseAskRequest(args);
      } catch (error) {
        // `attempted: false` — nothing was shown to anyone, so this is safe for the model to retry.
        return { ok: false, attempted: false, text: error instanceof Error ? error.message : 'That question could not be asked.' };
      }

      // The occurrence, not the model's choosing: an answer must route to the turn and the call
      // that actually asked, and `options.activity` is the only authority on which those are.
      const runId = options?.activity?.runId ?? context.runId;
      const occurrenceId = options?.activity?.activityId ?? options?.activity?.callId;
      if (!occurrenceId) {
        return { ok: false, attempted: false, text: 'This call could not be identified, so the question was not asked. Decide it yourself and say what you assumed.' };
      }

      try {
        const outcome = await context.ask(
          { askId: askIdFor(runId, occurrenceId), runId, request },
          options?.signal
        );
        return {
          ok: outcome.kind === 'answered' || outcome.kind === 'discuss',
          attempted: true,
          text: describeAskOutcome(outcome, request),
        };
      } catch (error) {
        return { ok: false, attempted: true, text: error instanceof Error ? error.message : 'The question could not be put to the user.' };
      }
    },
  };
}
