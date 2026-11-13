import { useState, type KeyboardEvent } from 'react';
import { Keyboard, RotateCcw } from 'lucide-react';
import {
  DEFAULT_DESKTOP_PREFERENCES, HOTKEY_ACTIONS, displayShortcut, normalizeShortcut,
  type DesktopPreferences, type HotkeyAction, type SendClickModifier,
} from '../../../../src/api/desktopPreferences';
import { desktopPlatform, saveDesktopPreferences, useDesktopPreferences } from '../../desktopPreferences';

const LABELS: Record<HotkeyAction, string> = {
  newChat: 'New chat', searchChats: 'Search chats', settings: 'Settings',
  toggleSidebar: 'Toggle sidebar', terminal: 'Terminal', sendMessage: 'Send message',
};

function recordedShortcut(event: KeyboardEvent<HTMLInputElement>): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key) || event.nativeEvent.isComposing || event.repeat) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push(desktopPlatform() === 'darwin' ? 'Ctrl' : 'Mod');
  if (event.metaKey) modifiers.push(desktopPlatform() === 'darwin' ? 'Mod' : 'Meta');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  try { return normalizeShortcut([...modifiers, event.key === ' ' ? 'Space' : event.key].join('+')); } catch { return null; }
}

export function HotkeysPanel() {
  const settings = useDesktopPreferences();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const update = async (patch: Partial<DesktopPreferences>) => {
    setPending(true);
    setError('');
    try { await saveDesktopPreferences(patch); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save shortcuts.'); }
    finally { setPending(false); }
  };
  return <section className="space-y-5" aria-labelledby="hotkeys-title">
    <h2 id="hotkeys-title" className="flex items-center gap-2 text-base font-medium text-ink"><Keyboard size={18} />Keyboard shortcuts</h2>
    <p className="text-sm text-ink-2">Select a shortcut and press the keys you want to use.</p>
    <fieldset disabled={pending} className="space-y-3">
      {HOTKEY_ACTIONS.map((action) => <label key={action} className="flex items-center justify-between gap-4 text-sm text-ink">
        {LABELS[action]}
        <input data-hotkey-recorder readOnly value={displayShortcut(settings.hotkeys[action], desktopPlatform())}
          aria-label={`${LABELS[action]} shortcut`}
          onKeyDown={(event) => {
            if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) return;
            event.preventDefault();
            event.stopPropagation();
            const shortcut = recordedShortcut(event);
            if (shortcut) void update({ hotkeys: { ...settings.hotkeys, [action]: shortcut } });
          }} className="w-44 rounded border border-line bg-surface-2 px-3 py-2 text-center font-mono text-xs text-ink focus:border-primary focus:outline-none" />
      </label>)}
      <button type="button" onClick={() => void update({ hotkeys: { ...DEFAULT_DESKTOP_PREFERENCES.hotkeys } })}
        className="flex items-center gap-1.5 rounded border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-2"><RotateCcw size={13} />Reset shortcuts</button>
    </fieldset>
    <fieldset disabled={pending} className="space-y-3 border-t border-line pt-5">
      <legend className="text-sm font-medium text-ink">Send protection</legend>
      <label className="flex items-center justify-between gap-4 text-sm text-ink">
        Clicking Send requires
        <select value={settings.sendClickModifier} onChange={(event) => void update({ sendClickModifier: event.target.value as SendClickModifier })}
          className="rounded border border-line bg-surface-2 px-3 py-1.5 text-ink">
          <option value="none">No modifier</option><option value="ctrl">Ctrl</option><option value="shift">Shift</option>
          <option value="alt">Alt</option><option value="meta">Command / Windows</option>
        </select>
      </label>
      <p className="text-xs text-ink-2">Applies to Send and Queue steer. Keyboard sending uses the shortcut above. Stop always works without a modifier.</p>
    </fieldset>
    {pending && <p role="status" className="text-xs text-ink-2">Saving…</p>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </section>;
}
