import { insideWorkspace } from '../../mcp/workspace';
import type { ToolRuntime } from './toolLoop';
import { runCommand, type RunCommandOptions } from './terminal';
import * as vaultGrants from './vault/grants';

export interface TerminalToolContext {
  workspace: string;
  threadId?: string;
  runCommand?: typeof runCommand;
}

const DESCRIPTION = 'Run a Bash command in the workspace and wait for its exit status. The command appears in Antimatter\'s inline terminal, where the user can interact directly when necessary, including entering a sudo password after approval. Never ask for passwords in chat or send them in tool arguments. If the user has a Vault credential for what you need, vault_use puts its value in an environment variable for this command instead. If the user types into the terminal, all output from that command is withheld from the model and transcript; only its exit status is returned. Use launch_program for servers and other programs meant to stay running. Commands run in separate shells, not the user\'s interactive shell.';

/** The normal tool loop approves the call before this wrapper can open a native terminal. */
export function withTerminal(runtime: ToolRuntime, context: TerminalToolContext): ToolRuntime {
  const execute = context.runCommand ?? runCommand;
  return {
    ...runtime,
    enabledTools: () => runtime.enabledTools().map((entry) => entry.serverId === 'antimatter' && entry.tool.name === 'run_command'
      ? { ...entry, tool: { ...entry.tool, description: DESCRIPTION } }
      : entry),
    prepareTool: runtime.prepareTool?.bind(runtime),
    connectionErrors: runtime.connectionErrors?.bind(runtime),
    async callTool(serverId, toolName, args, options) {
      if (serverId !== 'antimatter' || toolName !== 'run_command') return runtime.callTool(serverId, toolName, args, options);
      // A cached call cannot bypass a tool disabled/disconnected since definitions were read.
      if (!runtime.enabledTools().some((entry) => entry.serverId === serverId && entry.tool.name === toolName && entry.tool.enabled)) {
        return { ok: false, text: 'The bundled run_command tool is no longer available; nothing ran.', attempted: false };
      }
      let spec: RunCommandOptions;
      try {
        if (typeof args.command !== 'string' || !args.command.trim()) throw new Error('No command was given.');
        if (args.cwd !== undefined && typeof args.cwd !== 'string') throw new Error('The command directory must be a string.');
        const cwd = insideWorkspace(context.workspace, (args.cwd as string | undefined) ?? '.');
        const requested = Number(args.timeout_ms);
        const ownTimeout = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 300_000) : 60_000;
        const outerTimeout = options?.timeoutMs;
        const timeoutMs = outerTimeout !== undefined && Number.isFinite(outerTimeout) && outerTimeout > 0
          ? Math.min(ownTimeout, outerTimeout) : ownTimeout;
        const runId = options?.activity?.runId;
        // A credential the user approved for this turn, if there is one. Looked up by run id
        // rather than passed in an argument, so it never appears in the call the transcript
        // records or the approval prompt quotes; see src/main/vault/grants.ts. Asked for exactly
        // once: the lookup spends the grant's use budget.
        const vaultEnv = vaultGrants.environmentFor(runId, args.command);
        spec = {
          command: args.command, cwd, timeoutMs, signal: options?.signal,
          threadId: context.threadId, runId,
          activityId: options?.activity?.activityId ?? options?.activity?.callId,
          ...(vaultEnv ? { env: vaultEnv } : {}),
        };
      } catch (error) {
        return { ok: false, text: `${error instanceof Error ? error.message : 'Could not prepare the command.'} Nothing ran.`, attempted: false };
      }
      try { return await execute(spec); }
      catch {
        // Once dispatched a thrown native/IPC error does not prove that no side effect happened.
        return { ok: false, text: 'The terminal lost the command result after dispatch. It may have run; inspect the terminal and workspace before retrying.', attempted: true };
      }
    },
  };
}
