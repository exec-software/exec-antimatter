export const SETTINGS_SECTIONS = [
  { id: 'general', group: 'Personal', label: 'General', description: 'Your profile, assistant, and notifications.' },
  { id: 'appearance', group: 'Personal', label: 'Appearance', description: 'Themes, window controls, and tool panels.' },
  { id: 'keyboard', group: 'Personal', label: 'Keyboard', description: 'Shortcuts and send controls.' },
  { id: 'sidebar', group: 'Personal', label: 'Sidebar', description: 'Choose your navigation sections.' },
  { id: 'models', group: 'Agent', label: 'Models', description: 'Models, providers, and inference servers.' },
  { id: 'agents', group: 'Agent', label: 'Agents', description: 'Agent prompts, models, and permissions.' },
  { id: 'memory', group: 'Agent', label: 'Memory', description: 'Memories, instructions, and the Pensieve library.' },
  { id: 'tools', group: 'Agent', label: 'Tools', description: 'MCP servers and their available tools.' },
  { id: 'skills', group: 'Agent', label: 'Skills', description: 'Reusable instructions for your agents.' },
  { id: 'plugins', group: 'Agent', label: 'Plugins', description: 'Installed extensions and permissions.' },
  { id: 'orchestrator', group: 'Agent', label: 'Orchestrator', description: 'Issue workflows, running agents, and logs.' },
  { id: 'voice', group: 'Connections', label: 'Voice', description: 'Microphone and spoken replies.' },
  { id: 'devices', group: 'Connections', label: 'Remote devices', description: 'Pair devices and manage their access.' },
  { id: 'vault', group: 'Connections', label: 'Vault', description: 'Credentials protected by the system keyring.' },
  { id: 'application', group: 'Application', label: 'Updates & about', description: 'Updates, release notes, and build information.' },
  { id: 'experimental', group: 'Application', label: 'Experimental', description: 'Optional features in development.' },
] as const;

export type SettingsSection = typeof SETTINGS_SECTIONS[number]['id'];
export interface SettingsTarget {
  section: SettingsSection;
  detail?: 'sources' | 'add-source' | 'engine' | 'downloads' | 'servers' | 'nodes';
}

/** Only genuinely equivalent configured endpoints suppress another "Use as source" form. */
export function matchingSource<T extends { baseUrl: string }>(sources: readonly T[], baseUrl: string): T | undefined {
  const canonical = (value: string) => {
    try { const url = new URL(value); url.pathname = url.pathname.replace(/\/+$/, ''); return url.href; }
    catch { return value.replace(/\/+$/, ''); }
  };
  return sources.find((source) => canonical(source.baseUrl) === canonical(baseUrl));
}

/** Legacy page links and tool-window actions enter the same settings categories. */
export function settingsForPage(page: string): SettingsTarget | null {
  if (page === 'hub') return { section: 'models' };
  if (page === 'whatsnew') return { section: 'application' };
  if (['memory', 'tools', 'skills', 'plugins', 'orchestrator'].includes(page)) return { section: page as SettingsSection };
  return null;
}
