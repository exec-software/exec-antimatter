export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  source: 'project' | 'personal' | 'plugin';
  root: string;
  pluginId?: string;
  enabled: boolean;
  error: string | null;
}

export interface PluginServerSummary {
  id: string;
  name: string;
  command: string;
  args: string[];
  envNames: string[];
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  root: string;
  enabled: boolean;
  fingerprint: string;
  skills: number;
  servers: PluginServerSummary[];
  error: string | null;
  activationError: string | null;
  warnings: string[];
}

export interface ExtensionCatalog {
  skills: SkillInfo[];
  plugins: PluginInfo[];
  personalSkillsRoot: string;
  projectSkillsRoot: string | null;
  errors: string[];
}

export interface SkillDocument {
  skill: SkillInfo;
  resource: string;
  content: string;
  resources: string[];
  resourcesTruncated: boolean;
}

/** MAIN PROCESS ONLY: includes secret environment values, never sent over renderer IPC. */
export interface ExtensionMcpConfig {
  id: string;
  pluginId: string;
  fingerprint: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: true;
  createdAt: number;
}
