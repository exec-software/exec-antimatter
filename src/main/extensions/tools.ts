import type { ToolRuntime } from '../toolLoop';
import type { McpTool } from '../mcp';
import type { ExtensionRegistry } from './registry';

export const SKILLS_SERVER_ID = 'antimatter.skills';
export const READ_SKILL = 'read_skill';

export const skillTool: McpTool = {
  name: READ_SKILL,
  description: 'Read the complete SKILL.md for one of the available local skills, or a linked text resource inside that skill. First read SKILL.md, then load only resources needed for the current task. This tool never executes scripts, hooks, or plugin commands.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The exact skill id from the available-skills catalog.' },
      resource: { type: 'string', description: 'Relative text resource inside the skill, such as references/example.md. Defaults to SKILL.md; no absolute paths or traversal.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  enabled: true,
};

/** Bind reads to this run’s workspace, never the mutable global MCP workspace. */
export function withSkills(runtime: ToolRuntime, registry: ExtensionRegistry, workspace: string | null): ToolRuntime {
  return {
    enabledTools: () => {
      const offered = registry.catalog(workspace).skills.some((skill) => skill.enabled && !skill.error);
      return [...runtime.enabledTools(), ...(offered ? [{ serverId: SKILLS_SERVER_ID, serverName: 'Local skills', tool: skillTool }] : [])];
    },
    prepareTool: async (serverId, toolName, args, options) => serverId !== SKILLS_SERVER_ID && runtime.prepareTool
      ? runtime.prepareTool(serverId, toolName, args, options) : { args },
    callTool: async (serverId, toolName, args, options) => {
      if (serverId !== SKILLS_SERVER_ID) return runtime.callTool(serverId, toolName, args, options);
      if (toolName !== READ_SKILL) return { ok: false, attempted: false, text: 'This local skill tool is not available.' };
      if (typeof args.id !== 'string' || (args.resource !== undefined && typeof args.resource !== 'string')) {
        return { ok: false, attempted: false, text: 'Provide a skill id and an optional relative text resource.' };
      }
      if (options?.signal?.aborted) return { ok: false, attempted: false, text: 'The skill read was cancelled.' };
      try {
        const document = registry.readSkill(workspace, args.id, args.resource as string | undefined);
        return {
          ok: true, attempted: true,
          text: `Skill ${document.skill.name} (${document.skill.id}), resource ${document.resource}\n\n${document.content}\n\nAvailable resources${document.resourcesTruncated ? ' (bounded list; additional files omitted)' : ''}:\n${document.resources.map((resource) => JSON.stringify(resource)).join('\n')}`,
        };
      } catch (error) {
        return { ok: false, attempted: true, text: error instanceof Error ? error.message : 'This skill resource could not be read.' };
      }
    },
    connectionErrors: () => runtime.connectionErrors?.() ?? [],
  };
}
