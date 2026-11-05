export const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', description: 'Appearance, your profile, notifications, and desktop companion.' },
  { id: 'models', label: 'Models & providers', description: 'Connect inference sources and manage local model infrastructure.' },
  { id: 'voice', label: 'Voice', description: 'Audio input and spoken replies for pair programming.' },
  { id: 'devices', label: 'Remote devices', description: 'Pair a phone with this computer and manage its access.' },
  { id: 'vault', label: 'Vault', description: 'Credentials a conversation may use with your approval, sealed by the system keyring and never shown in chat.' },
  { id: 'application', label: 'Updates & about', description: 'Application updates, release notes, and build information.' },
  { id: 'experimental', label: 'Experimental', description: 'Optional features that are still being developed. Each starts off until you enable it.' },
] as const;

export type SettingsSection = typeof SETTINGS_SECTIONS[number]['id'];
export interface SettingsTarget {
  section: SettingsSection;
  detail?: 'add-source' | 'engine' | 'downloads' | 'servers' | 'nodes';
}

/** Only genuinely equivalent configured endpoints suppress another "Use as source" form. */
export function matchingSource<T extends { baseUrl: string }>(sources: readonly T[], baseUrl: string): T | undefined {
  const canonical = (value: string) => {
    try { const url = new URL(value); url.pathname = url.pathname.replace(/\/+$/, ''); return url.href; }
    catch { return value.replace(/\/+$/, ''); }
  };
  return sources.find((source) => canonical(source.baseUrl) === canonical(baseUrl));
}
