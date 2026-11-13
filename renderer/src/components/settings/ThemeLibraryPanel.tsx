import { useRef, useState } from 'react';
import type { AppearanceSettings } from '../../../../src/api/appearance';
import { THEME_PRESETS, themeDefinitionFor, validateThemeDefinition } from '../../../../src/api/themes';
import { themeVariantFor } from '../../theme';

const MAX_THEME_BYTES = 24 * 1024;
const button = 'rounded border border-line px-3 py-1.5 text-xs text-ink hover:bg-surface-3 disabled:opacity-40';

export function ThemeLibraryPanel({ settings, disabled, onChange }: {
  settings: AppearanceSettings; disabled: boolean; onChange(patch: Partial<AppearanceSettings>): Promise<void>;
}) {
  const [editor, setEditor] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const template = () => {
    const source = themeDefinitionFor(settings);
    return { ...source, id: 'my-theme', name: 'My theme', dark: themeVariantFor({ ...settings, theme: 'dark', autoTheme: false }), light: themeVariantFor({ ...settings, theme: 'light', autoTheme: false }) };
  };
  const apply = async (text: string) => {
    setError('');
    try {
      if (new TextEncoder().encode(text).length > MAX_THEME_BYTES) throw new Error('Theme files must be 24 KB or smaller.');
      const customTheme = validateThemeDefinition(JSON.parse(text));
      await onChange({ customTheme, themePreset: 'custom', useThemeAccent: true });
      setEditor(JSON.stringify(customTheme, null, 2));
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load theme.'); }
  };
  const download = () => {
    const theme = settings.themePreset === 'custom' ? { ...template(), id: settings.customTheme!.id, name: settings.customTheme!.name } : { ...template(), id: themeDefinitionFor(settings).id, name: themeDefinitionFor(settings).name };
    const url = URL.createObjectURL(new Blob([JSON.stringify(theme, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${theme.id}.antimatter-theme.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <fieldset disabled={disabled} className="mt-5 border-t border-line pt-4">
    <legend className="text-xs font-medium text-ink">Workspace palette</legend>
    <p className="mt-1 text-xs text-ink-2">Colors for the app, code editor, and terminal. Every palette has dark and light variants.</p>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {THEME_PRESETS.map((theme) => <button key={theme.id} type="button" aria-pressed={settings.themePreset === theme.id}
        onClick={() => { setError(''); void onChange({ themePreset: theme.id as AppearanceSettings['themePreset'], useThemeAccent: true }); }}
        className={`rounded border p-3 text-left text-xs ${settings.themePreset === theme.id ? 'border-primary' : 'border-line'}`}
        style={{ background: theme[settings.theme].ui.surface, color: theme[settings.theme].ui.ink }}>
        <span className="block font-medium">{theme.name}</span>
        <span aria-hidden="true" className="mt-2 flex gap-1">{(['primary', 'accent', 'warning', 'danger', 'ink'] as const).map((key) => <span key={key} className="h-2 w-5 rounded-sm" style={{ background: theme[settings.theme].ui[key] }} />)}</span>
      </button>)}
      {settings.customTheme && <button type="button" aria-pressed={settings.themePreset === 'custom'} onClick={() => void onChange({ themePreset: 'custom', useThemeAccent: true })} className={`${button} ${settings.themePreset === 'custom' ? 'border-primary' : ''}`}>{settings.customTheme.name}</button>}
    </div>
    <details className="mt-3 rounded border border-line p-3">
      <summary className="cursor-pointer text-xs font-medium text-ink">Custom themes</summary>
      <p className="mt-2 text-xs leading-5 text-ink-2">Import a theme, or edit a copy of the current palette. Version 1 defines UI, syntax, and all 16 terminal colors for both modes. Colors use six-digit hex values.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={button} onClick={() => input.current?.click()}>Import JSON</button>
        <button type="button" className={button} onClick={download}>Export current theme</button>
        <button type="button" className={button} onClick={() => { setEditor(JSON.stringify(template(), null, 2)); setError(''); }}>Edit a copy</button>
      </div>
      <input ref={input} type="file" accept=".json,application/json" hidden onChange={async (event) => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
        if (file.size > MAX_THEME_BYTES) { setError('Theme files must be 24 KB or smaller.'); return; }
        try { await apply(await file.text()); } catch { setError('Could not read theme file.'); }
      }} />
      {editor && <><label className="mt-3 block text-xs text-ink-2">Theme JSON<textarea aria-label="Theme JSON" value={editor} onChange={(event) => setEditor(event.target.value)} spellCheck={false} className="mt-1 h-64 w-full resize-y rounded border border-line bg-surface-0 p-2 font-mono text-xs text-ink" /></label>
        <button type="button" className={`${button} mt-2`} onClick={() => void apply(editor)}>Validate and apply</button></>}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </details>
  </fieldset>;
}
