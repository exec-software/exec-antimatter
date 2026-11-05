import type { McpTool } from '../mcp';
import type { ToolRuntime } from '../toolLoop';
import * as grants from './grants';
import * as store from './store';

export const VAULT_SERVER = 'antimatter.vault';
const VAULT_SERVER_NAME = 'Vault';

export const VAULT_TOOL_NAMES = ['vault_list', 'vault_use'] as const;

/**
 * The Vault's tools.
 *
 * Only two, and the asymmetry between them is the design: one reads a catalogue that contains no
 * secrets and may run freely, the other spends a credential and always stops for a person.
 *
 * Both are served here in the main process rather than by the bundled MCP child. That is not an
 * implementation convenience — it is the boundary. `safeStorage` only exists in main, and keeping
 * the unsealed value here means there is no second process, no stdio pipe, and no child
 * environment that has ever held it.
 */
const listTool: McpTool = {
  name: 'vault_list',
  enabled: true,
  description:
    "List the credentials the user keeps in Antimatter's Vault: each one's tag, what it is for, " +
    'the account name where there is one, and the environment variable its value would arrive under. ' +
    'Secrets are never returned by this tool or any other — you can learn that a credential exists ' +
    'and what it is for, never what it is. Use this to find the right tag, then vault_use to get it ' +
    'into a command.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const useTool: McpTool = {
  name: 'vault_use',
  enabled: true,
  description:
    'Ask to use one Vault credential in the commands that follow. The user is asked to approve ' +
    'every call, and sees the tag and the reason you give, so say plainly what the credential is ' +
    'for. This does NOT return the secret: it puts the value into an environment variable for the ' +
    'next few run_command calls in this turn and tells you the variable name. Read it as ' +
    '"$ANTIMATTER_VAULT_<TAG>" from the shell and never print it, copy it into a file, or pass it ' +
    'as a command-line argument — a command line is readable by every process on the machine. ' +
    'Prefer standard input: for example printf \'%s\\n\' "$ANTIMATTER_VAULT_SUDO" | sudo -S -p \'\' apt-get install -y foo, ' +
    "or curl -K - reading its own flags from a here-document. Command output is scanned and the " +
    'secret masked out before you or the transcript see it, so echoing it tells you nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      tag: { type: 'string', description: 'The credential\'s tag, as vault_list reports it — for example "sudo".' },
      purpose: {
        type: 'string',
        description:
          'One sentence on what you are about to do with it, shown to the user in the approval prompt. ' +
          'Name the actual command where you can.',
      },
    },
    required: ['tag', 'purpose'],
    additionalProperties: false,
  },
};

const describe = (entry: store.VaultEntrySummary): string =>
  [
    `tag: ${entry.tag}`,
    `  for: ${entry.label}`,
    `  kind: ${entry.kind}`,
    ...(entry.username ? [`  account: ${entry.username}`] : []),
    ...(entry.notes ? [`  note: ${entry.notes}`] : []),
    `  arrives as: $${entry.envName}`,
  ].join('\n');

export interface VaultRuntimeContext {
  /** The turn a grant belongs to. A grant armed by one run is never visible to another. */
  runId: string;
}

/**
 * Wraps a runtime with the Vault's tools and — the part that matters even when the model never
 * calls them — with redaction of every result that passes through.
 *
 * This belongs **outermost** in the runtime chain. Redaction has to see the results of all tools,
 * not just the shell: a secret that reached a file is read back by `read_file`, and a secret that
 * reached a delegated agent comes back in its report. Being outermost also keeps the Vault's own
 * tools out of every runtime nested inside it, so an agent this turn starts cannot spend a
 * credential — the conversation the person is watching is the only place that can.
 */
export function withVault(runtime: ToolRuntime, context: VaultRuntimeContext): ToolRuntime {
  const offered = (): boolean => store.enabled();

  return {
    enabledTools: () => {
      const inner = runtime.enabledTools();
      if (!offered()) return inner;
      return [
        ...inner,
        { serverId: VAULT_SERVER, serverName: VAULT_SERVER_NAME, tool: listTool },
        { serverId: VAULT_SERVER, serverName: VAULT_SERVER_NAME, tool: useTool },
      ];
    },
    prepareTool: (serverId, toolName, args, options) =>
      serverId !== VAULT_SERVER && runtime.prepareTool
        ? runtime.prepareTool(serverId, toolName, args, options)
        : Promise.resolve({ args }),
    connectionErrors: () => runtime.connectionErrors?.() ?? [],
    async callTool(serverId, toolName, args, options) {
      if (serverId !== VAULT_SERVER) {
        const result = await runtime.callTool(serverId, toolName, args, options);
        // Every result, not only the shell's. Cheap when nothing is armed.
        if (!grants.anyActive()) return result;
        const text = grants.redact(result.text);
        return text === result.text ? result : { ...result, text };
      }

      // The user may have turned the Vault off between the round that read the tool definitions
      // and this call. A cached definition must not outlive the setting that offered it.
      if (!offered()) {
        return { ok: false, attempted: false, text: 'The Vault is off, so no credential is available. Ask the user to turn it on in Settings.' };
      }

      if (toolName === listTool.name) {
        const entries = store.status().entries;
        if (!entries.length) {
          return { ok: true, attempted: true, text: 'The Vault is on but holds no credentials yet. The user adds them in Settings › Vault.' };
        }
        return {
          ok: true,
          attempted: true,
          text: [
            `${entries.length} credential${entries.length === 1 ? '' : 's'} in the Vault. Values are never shown; use vault_use to get one into a command.`,
            ...entries.map(describe),
          ].join('\n'),
        };
      }

      if (toolName !== useTool.name) {
        return { ok: false, attempted: false, text: `The Vault has no tool named ${toolName}.` };
      }

      const tag = store.normalizeTag(args.tag);
      const purpose = typeof args.purpose === 'string' ? args.purpose.trim().slice(0, 300) : '';
      if (!tag) return { ok: false, attempted: false, text: 'Name the credential to use with "tag", as vault_list reports it.' };
      if (!purpose) return { ok: false, attempted: false, text: 'Say what the credential is for in "purpose"; the user reads it before approving.' };

      // The run is this turn's, not the model's to choose: a grant armed for one turn must never
      // be reachable from another, and `activity.runId` is the only authority on which turn this is.
      const runId = options?.activity?.runId ?? context.runId;
      try {
        const armed = grants.arm(runId, tag, purpose);
        const seconds = Math.round(grants.GRANT_LIMITS.ttlMs / 1000);
        return {
          ok: true,
          attempted: true,
          text: [
            `The user approved using "${armed.tag}" (${armed.label}).`,
            `Its value is now set as $${armed.envName} for run_command calls in this turn that name that variable — at most ${armed.maxUses} of them, and for ${seconds} seconds. A command that does not name it is unaffected and does not count.`,
            'You were not given the value and cannot read it. Use the variable from the shell, by standard input rather than on a command line:',
            `  printf '%s\\n' "$${armed.envName}" | sudo -S -p '' <command>`,
            'Command output is scanned and the value masked before it reaches you or the transcript.',
          ].join('\n'),
        };
      } catch (error) {
        return { ok: false, attempted: true, text: error instanceof Error ? error.message : 'That credential could not be used.' };
      }
    },
  };
}
