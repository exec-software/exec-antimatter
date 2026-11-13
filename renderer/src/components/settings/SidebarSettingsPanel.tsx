import { useEffect, useState } from 'react';
import { DEFAULT_SIDEBAR_VISIBILITY, loadSidebarVisibility, saveSidebarVisibility, SIDEBAR_SECTION_GROUPS, SIDEBAR_VISIBILITY_EVENT, SIDEBAR_VISIBILITY_KEY, type SidebarSectionId } from '../../lib/sidebarVisibility';

export function SidebarSettingsPanel({ botChatEnabled = false }: { botChatEnabled?: boolean }) {
  const [visibility, setVisibility] = useState(loadSidebarVisibility);
  useEffect(() => {
    const local = () => setVisibility(loadSidebarVisibility());
    const remote = (event: StorageEvent) => { if (event.key === SIDEBAR_VISIBILITY_KEY || event.key === null) local(); };
    window.addEventListener(SIDEBAR_VISIBILITY_EVENT, local);
    window.addEventListener('storage', remote);
    return () => { window.removeEventListener(SIDEBAR_VISIBILITY_EVENT, local); window.removeEventListener('storage', remote); };
  }, []);
  const change = (id: SidebarSectionId, visible: boolean) => {
    const next = { ...loadSidebarVisibility(), [id]: visible };
    saveSidebarVisibility(next); setVisibility(next);
  };
  return <div className="space-y-5">
    <p className="text-xs leading-5 text-ink-3">Choose which sections appear on this computer. Hidden chats remain searchable.</p>
    {SIDEBAR_SECTION_GROUPS.map((group) => <fieldset key={group.label} className="rounded-lg border border-line p-4">
      <legend className="px-1 text-sm font-medium text-ink">{group.label}</legend>
      {group.sections.filter((section) => section.id !== 'bot-chat' || botChatEnabled).map((section) => <label key={section.id} className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 text-sm text-ink-2 hover:bg-surface-2">
        <input type="checkbox" className="accent-accent" checked={visibility[section.id]} onChange={(event) => change(section.id, event.target.checked)} />{section.label}
      </label>)}
    </fieldset>)}
    <button type="button" onClick={() => { const next = { ...DEFAULT_SIDEBAR_VISIBILITY }; saveSidebarVisibility(next); setVisibility(next); }}
      disabled={Object.values(visibility).every(Boolean)} className="rounded-md border border-line px-3 py-2 text-xs text-ink-2 hover:bg-surface-3 disabled:opacity-40">Show all sections</button>
  </div>;
}
