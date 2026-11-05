/** Visual preferences only: hiding a section never changes its chats or feature settings. */
export const SIDEBAR_VISIBILITY_KEY = 'antimatter.sidebar.visibility';

export const SIDEBAR_SECTION_GROUPS = [
  { label: 'Workspace', sections: [
    { id: 'agents', label: 'Agents' },
    { id: 'memory', label: 'Memory' },
    { id: 'environment', label: 'Code' },
    { id: 'tools', label: 'Tools' },
    { id: 'skills', label: 'Skills' },
    { id: 'plugins', label: 'Plugins' },
    { id: 'models', label: 'Models' },
    { id: 'orchestrator', label: 'Orchestrator' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'pull-requests', label: 'Pull requests' },
    { id: 'bot-chat', label: 'Bot chat' },
  ] },
  { label: 'Conversations', sections: [
    { id: 'pinned', label: 'Pinned' },
    { id: 'projects', label: 'Projects' },
    { id: 'imported-claude', label: 'Claude chats' },
    { id: 'imported-codex', label: 'Codex chats' },
    { id: 'imported-opencode', label: 'OpenCode chats' },
    { id: 'recent', label: 'Recent' },
  ] },
  { label: 'More', sections: [
    { id: 'developer', label: 'Developer' },
    { id: 'whatsnew', label: "What's New" },
  ] },
] as const;

export type SidebarSectionId = typeof SIDEBAR_SECTION_GROUPS[number]['sections'][number]['id'];
export type SidebarVisibility = Record<SidebarSectionId, boolean>;

export const DEFAULT_SIDEBAR_VISIBILITY = Object.fromEntries(
  SIDEBAR_SECTION_GROUPS.flatMap((group) => group.sections.map(({ id }) => [id, true]))
) as SidebarVisibility;

export function loadSidebarVisibility(storage?: Pick<Storage, 'getItem'>): SidebarVisibility {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    const saved: unknown = JSON.parse(target?.getItem(SIDEBAR_VISIBILITY_KEY) ?? '{}');
    const values = saved && typeof saved === 'object' && !Array.isArray(saved)
      ? saved as Record<string, unknown> : {};
    // New sections stay visible after an upgrade; only an explicit false hides anything.
    return Object.fromEntries(Object.keys(DEFAULT_SIDEBAR_VISIBILITY).map((id) => [id, values[id] !== false])) as SidebarVisibility;
  } catch {
    return { ...DEFAULT_SIDEBAR_VISIBILITY };
  }
}

export function saveSidebarVisibility(visibility: SidebarVisibility, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
    target?.setItem(SIDEBAR_VISIBILITY_KEY, JSON.stringify(visibility));
  } catch {
    // Keep the current session usable even when browser storage is unavailable.
  }
}
