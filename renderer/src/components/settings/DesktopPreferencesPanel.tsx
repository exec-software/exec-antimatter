import { useState } from 'react';
import { Monitor, Pin } from 'lucide-react';
import { toolIsVisible, type DesktopPreferences } from '../../../../src/api/desktopPreferences';
import { saveDesktopPreferences, useDesktopPreferences } from '../../desktopPreferences';
import { toolWindows } from '../../plugins/registry';

export function DesktopPreferencesPanel() {
  const settings = useDesktopPreferences();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const tools = toolWindows();
  const update = async (patch: Partial<DesktopPreferences>) => {
    setPending(true);
    setError('');
    try { await saveDesktopPreferences(patch); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save settings.'); }
    finally { setPending(false); }
  };
  return <section className="space-y-5 border-t border-line pt-5" aria-labelledby="desktop-window-title">
    <h3 id="desktop-window-title" className="flex items-center gap-2 text-sm font-medium text-ink"><Monitor size={16} />Window</h3>
    <fieldset disabled={pending} className="space-y-3">
      <label className="flex items-center justify-between gap-4 text-sm text-ink">
        Window controls
        <select value={settings.windowStyle} onChange={(event) => void update({ windowStyle: event.target.value as DesktopPreferences['windowStyle'] })}
          className="rounded border border-line bg-surface-2 px-3 py-1.5 text-ink">
          <option value="native">System title bar</option><option value="custom">Antimatter title bar</option>
        </select>
      </label>
      <p className="text-xs text-ink-2">Window style changes take effect when Antimatter next starts.</p>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={settings.alwaysOnTop} onChange={(event) => void update({ alwaysOnTop: event.target.checked })} />
        <Pin size={14} />Always on top
      </label>
    </fieldset>
    <fieldset disabled={pending} className="space-y-2 border-t border-line pt-4"><legend className="text-sm font-medium text-ink">Reply pad</legend>
      <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={settings.macroPadEnabled} onChange={(event) => void update({ macroPadEnabled: event.target.checked })} />Enable saved replies</label>
      <p className="text-xs text-ink-2">Save reusable prompts in a floating or docked panel. Sending follows your current chat permissions and Send protection.</p>
    </fieldset>
    <fieldset disabled={pending} className="space-y-2 border-t border-line pt-4"><legend className="text-sm font-medium text-ink">Doom</legend>
      <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={settings.doomEnabled} onChange={(event) => void update({ doomEnabled: event.target.checked })} />Show Doom easter egg</label>
      <p className="text-xs text-ink-2">Play Freedoom or load your own IWAD while an agent works.</p>
    </fieldset>
    <fieldset disabled={pending} className="space-y-3 border-t border-line pt-4">
      <legend className="text-sm font-medium text-ink">Tool shortcuts</legend>
      <p className="text-xs text-ink-2">Choose the tools shown on the right edge. Hide all to remove the tool bar.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {tools.map((tool) => <label key={tool.id} className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={toolIsVisible(settings, tool.id)} disabled={tool.id === 'reply-pad' && !settings.macroPadEnabled || tool.id === 'doom' && !settings.doomEnabled}
            onChange={(event) => void update({ toolVisibility: { ...settings.toolVisibility, [tool.id]: event.target.checked } })} />
          {tool.title}
        </label>)}
      </div>
      <div className="flex gap-2">
        {[true, false].map((visible) => <button key={String(visible)} type="button"
          onClick={() => void update({ toolVisibility: { ...settings.toolVisibility, ...Object.fromEntries(tools.map((tool) => [tool.id, visible])) } })}
          className="rounded border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface-2">{visible ? 'Show all' : 'Hide all'}</button>)}
      </div>
    </fieldset>
    {pending && <p role="status" className="text-xs text-ink-2">Saving…</p>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </section>;
}
