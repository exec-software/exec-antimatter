import type { AntimatterPlugin, ToolWindowAnchor, ToolWindowDef } from './types';

/**
 * The plugin registry.
 *
 * Registration is a module-load side effect rather than a discovery pass, because everything
 * ships in the bundle today. What matters is that the shell reads plugins through this and
 * knows nothing about any particular one — the built-in panels register the same way Snitch
 * does, which is the only way to be sure the contribution points actually work.
 */

const plugins: AntimatterPlugin[] = [];

export function registerPlugin(plugin: AntimatterPlugin): AntimatterPlugin {
  const existing = plugins.findIndex((entry) => entry.id === plugin.id);
  if (existing === -1) plugins.push(plugin);
  else plugins[existing] = plugin;
  return plugin;
}

export const listPlugins = (): AntimatterPlugin[] => [...plugins];

export const toolWindows = (): ToolWindowDef[] => plugins.flatMap((plugin) => plugin.toolWindows);

export const toolWindowsAt = (anchor: ToolWindowAnchor): ToolWindowDef[] =>
  toolWindows().filter((window) => window.anchor === anchor);

export const findToolWindow = (id: string): ToolWindowDef | undefined =>
  toolWindows().find((window) => window.id === id);
