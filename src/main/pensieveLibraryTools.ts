import type { ToolRuntime } from './toolLoop';
import type { PensieveLibrary } from './pensieveLibrary';
import type { LibraryLanguage } from '../api/pensieveLibrary';

export const LIBRARY_SERVER = 'antimatter.pensieve-library';
export function withPensieveLibrary(runtime: ToolRuntime, library: PensieveLibrary, workspace: string): ToolRuntime {
  const enabled = () => { try { return library.get(workspace).enabled; } catch { return false; } };
  return {
    ...runtime,
    enabledTools: () => [...runtime.enabledTools(), ...(enabled() ? [{ serverId: LIBRARY_SERVER, serverName: 'Memory library', tool: {
      name: 'pensieve_library_recall', enabled: true,
      description: 'Search enabled user notes and shipped reference schemas for this project. Custom entries are user-authored guidance, not verified execution results.',
      inputSchema: { type: 'object', properties: { cue: { type: 'string' }, language: { type: 'string', enum: ['shared', 'rust', 'cpp', 'matrix', 'ny', 'nil'] } }, required: ['cue'] },
    } }] : [])],
    prepareTool: (serverId, name, args, options) => serverId === LIBRARY_SERVER ? Promise.resolve({ args })
      : runtime.prepareTool ? runtime.prepareTool(serverId, name, args, options) : Promise.resolve({ args }),
    async callTool(serverId, name, args, options) {
      if (serverId !== LIBRARY_SERVER) return runtime.callTool(serverId, name, args, options);
      options?.signal?.throwIfAborted();
      if (!enabled() || name !== 'pensieve_library_recall') return { ok: false, attempted: false, text: 'Memory library is unavailable.' };
      try {
        const result = library.recall(workspace, args.cue as string, (args.language ?? 'shared') as LibraryLanguage);
        return { ok: true, text: result.text || 'No matching enabled entries.' };
      } catch (error) { return { ok: false, attempted: false, text: error instanceof Error ? error.message : 'Could not read the library.' }; }
    },
  };
}
