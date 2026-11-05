import { str } from '../types';
import type { ToolDef } from '../types';

/**
 * The fallback recovery shell, reached from an ordinary turn.
 *
 * The app's own main process owns the shell and intercepts these two tool names before they ever
 * reach this server (see src/main/recovery/wire.ts), so a chat or orchestrator turn can look at
 * the shell with recovery_status or drive it with recovery_use while the window that would show
 * it is broken. The definitions here are what the model reads; the `run` bodies below are the
 * impossible-by-construction path where an interception was not in place, and say so rather than
 * pretending to do anything.
 */
export const recoveryTools: ToolDef[] = [
  {
    name: 'recovery_status',
    description:
      "Report the state of the app's recovery shell: whether it is shown, what engaged it, " +
      'whether a turn is running, the model and workspace it would answer on, and how many messages ' +
      "it holds. The recovery shell is the fallback surface the window displays when the normal UI " +
      'is down or broken. Use this first, then recovery_use to ask the shell to do something.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      throw new Error(
        'recovery_status is handled by the Antimatter app itself; route your turn through the app rather than this server process.'
      );
    },
  },
  {
    name: 'recovery_use',
    description:
      'Send one line to the recovery shell and wait for the result: a plain prompt it ' +
      'runs with the same real tools as a chat window, or a slash command such as /status, ' +
      '/logs 40, /conversations, /workspace /path/to/repo or /run npm run typecheck. Returns the ' +
      "shell's reply. A line that changes the machine is put to whoever is watching the shell " +
      'for approval; if nobody is watching, it is refused rather than hanging.',
    inputSchema: {
      type: 'object',
      properties: {
        line: str('one line for the recovery shell, like the message or command you would type into it'),
      },
      required: ['line'],
    },
    async run(_args) {
      throw new Error(
        'recovery_use is handled by the Antimatter app itself; route your turn through the app rather than this server process.'
      );
    },
  },
];