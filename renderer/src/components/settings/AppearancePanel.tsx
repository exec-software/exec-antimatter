import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Clock, LayoutDashboard, Moon, Sun } from 'lucide-react';
import { appearanceEquals, DEFAULT_APPEARANCE, minutesOfDay, nextThemeBoundary, resolveTheme, type AppearanceSettings, type AppearanceTheme } from '../../../../src/api/appearance';
import { getAppearance, saveAppearance, subscribeAppearance } from '../../appearance';
import { accentPresets, paletteFor } from '../../theme';
import { FontsSection } from './FontsSection';

function ThemePreview({ theme, accent }: { theme: AppearanceTheme; accent: string }) {
  // A preview always shows one lightness, so it deliberately ignores any active schedule.
  const p = paletteFor({ theme, secondaryAccent: accent, autoTheme: false });
  return <span aria-hidden="true" className="flex h-24 overflow-hidden rounded-md border" style={{ background: p.surface, borderColor: p.line }}>
    <span className="flex w-1/4 flex-col gap-2 border-r p-2.5" style={{ background: p.surface2, borderColor: p.line }}>
      <span className="mb-1 h-1.5 w-4 rounded-sm" style={{ background: p.primary }} />
      {[0, 1, 2].map((i) => <span key={i} className="h-1 rounded-sm" style={{ background: p.line, width: i === 1 ? '70%' : '90%' }} />)}
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-2 p-3">
      <span className="ml-auto h-3 w-1/2 rounded-sm" style={{ background: p.surface3 }} />
      <span className="h-1 w-3/4 rounded-sm" style={{ background: p.ink2 }} />
      <span className="h-1 w-1/2 rounded-sm" style={{ background: p.accent }} />
      <span className="mt-auto flex h-4 items-center justify-end rounded-sm border px-1" style={{ borderColor: p.line, background: p.surface2 }}>
        <span className="h-2 w-2 rounded-sm" style={{ background: p.primary }} />
      </span>
    </span>
  </span>;
}

/** "4h 12m", "12m", or a floor for the last minute, so the countdown never reads "0m". */
function untilLabel(target: Date, now: Date): string {
  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (minutes < 1) return 'in under a minute';
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `in ${hours}h ${minutes % 60}m` : `in ${minutes}m`;
}

export function AppearancePanel() {
  const settings = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const [draft, setDraft] = useState(settings.secondaryAccent);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const saving = useRef(false);
  const alive = useRef(true);
  // Main drives the actual switch; this clock only keeps the status line honest while the pane is open.
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setDraft(settings.secondaryAccent); }, [settings.secondaryAccent]);
  useEffect(() => {
    setClock(new Date());
    if (!settings.autoTheme) return;
    const timer = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(timer);
  }, [settings.autoTheme, settings.autoLightFrom, settings.autoDarkFrom]);
  const valid = /^#[\da-f]{6}$/i.test(draft);
  // By value, not by identity: `fonts` is an object, and comparing it with === would report
  // "changed" forever and leave the reset link permanently enabled.
  const atDefaults = appearanceEquals(settings, DEFAULT_APPEARANCE);

  const active = resolveTheme(settings, clock);
  const palette = useMemo(() => paletteFor(settings, clock), [settings, clock]);
  const boundary = nextThemeBoundary(settings, clock);
  const presets = accentPresets(active);
  // Seeds stay brand-true, so some are still re-toned for contrast. Painting and comparing the
  // adapted tone keeps the swatch honest and lets the stored seed light its own chip.
  const appliedAccent = (color: string) => paletteFor({ ...settings, secondaryAccent: color }, clock).accent;
  const sameTimes = minutesOfDay(settings.autoLightFrom) === minutesOfDay(settings.autoDarkFrom);

  async function update(patch: Partial<AppearanceSettings>) {
    if (saving.current) return;
    saving.current = true; setPending(true); setError(''); setNotice('');
    try {
      const saved = await saveAppearance(patch);
      if (alive.current) {
        if (patch.secondaryAccent !== undefined) setDraft(saved.secondaryAccent);
        setNotice('Appearance saved.');
      }
    } catch {
      if (alive.current) setError('Could not save appearance. Your previous settings are unchanged. Please try again.');
    } finally {
      saving.current = false;
      if (alive.current) setPending(false);
    }
  }

  return <section aria-labelledby="appearance-title" className="mb-7 border-b border-line pb-6">
    <h3 id="appearance-title" className="text-sm font-medium text-ink">Appearance</h3>
    <p className="mt-1 text-xs leading-5 text-ink-2">The same flat Antimatter workspace, in dark or light. Changes apply across your desktop app.</p>
    <fieldset disabled={pending} className="mt-4">
      <legend className="mb-2 text-xs font-medium text-ink">Theme</legend>
      <div className="grid max-w-lg grid-cols-2 gap-3">
        {(['dark', 'light'] as const).map((theme) => {
          const Icon = theme === 'dark' ? Moon : Sun;
          const label = theme === 'dark' ? 'Dark' : 'Light';
          return <label key={theme} className={`relative min-w-0 ${pending ? 'cursor-wait' : 'cursor-pointer'}`}>
            {/* Choosing a theme by hand is an override, so it also ends the schedule. */}
            <input className="peer sr-only" type="radio" name="appearance-theme" value={theme} aria-label={`${label} theme`}
              checked={active === theme} onChange={() => void update({ theme, autoTheme: false })} />
            <span className={`block rounded-lg border p-2 transition peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface ${active === theme ? 'border-primary' : 'border-line hover:border-ink-3'}`}>
              <ThemePreview theme={theme} accent={settings.secondaryAccent} />
              <span className="mt-2 flex flex-wrap items-center gap-1.5 px-1 text-xs text-ink"><Icon size={13} />{label}
                {theme === 'dark' && <span className="text-[10px] text-ink-2">Default</span>}
                {active === theme && <Check size={13} className="ml-auto text-primary" />}
              </span>
            </span>
          </label>;
        })}
      </div>
    </fieldset>
    <div className="mt-4 max-w-lg rounded-lg border border-line p-3">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span id="auto-theme-label" className="flex items-center gap-1.5 text-xs font-medium text-ink"><Clock size={13} />Switch automatically by time of day</span>
          <span id="auto-theme-help" className="mt-1 block text-xs leading-5 text-ink-2">Antimatter follows your computer&rsquo;s local clock. Picking a theme above turns this back off.</span>
        </span>
        <button type="button" role="switch" aria-checked={settings.autoTheme} aria-labelledby="auto-theme-label" aria-describedby="auto-theme-help"
          disabled={pending} onClick={() => void update({ autoTheme: !settings.autoTheme })}
          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-40 ${settings.autoTheme ? 'border-primary bg-primary' : 'border-line bg-surface-3'}`}>
          <span aria-hidden="true" className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${settings.autoTheme ? 'left-[1.125rem] bg-on-primary' : 'left-0.5 bg-ink-3'}`} />
        </button>
      </div>
      {settings.autoTheme && <fieldset disabled={pending} className="mt-3 border-t border-line-soft pt-3">
        <legend className="sr-only">Automatic theme schedule</legend>
        <div className="flex flex-wrap items-end gap-3">
          {([['autoLightFrom', 'Light from', Sun], ['autoDarkFrom', 'Dark from', Moon]] as const).map(([key, label, Icon]) => <label key={key} className="flex flex-col gap-1 text-[11px] text-ink-2">
            <span className="flex items-center gap-1"><Icon size={11} />{label}</span>
            <input type="time" aria-label={label} value={settings[key]} step={60}
              onChange={(event) => {
                const next = event.target.value;
                if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next) || next === settings[key]) return;
                void update({ [key]: next });
              }}
              className="h-8 rounded border border-line bg-surface-2 px-2 font-mono text-xs text-ink focus:border-primary focus:outline-none" />
          </label>)}
        </div>
        <p role="status" className="mt-2 text-[11px] text-ink-2">
          {sameTimes ? 'Choose two different times to switch between.'
            : boundary ? <>Now {active}. Switches to {active === 'dark' ? 'light' : 'dark'} {untilLabel(boundary, clock)}.</>
              : `Now ${active}.`}
        </p>
      </fieldset>}
    </div>
    <div className="mt-4 max-w-lg rounded-lg border border-line p-3">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span id="prompt-dock-label" className="flex items-center gap-1.5 text-xs font-medium text-ink"><LayoutDashboard size={13} />Widget band beside the prompt</span>
          <span id="prompt-dock-help" className="mt-1 block text-xs leading-5 text-ink-2">
            The prompt is held to a readable width, which leaves the space either side of it idle.
            Turn this on to dock panels there &mdash; performance, sources, agents &mdash; and drag the
            row taller. Turn it off and the prompt floats over the conversation instead.
          </span>
        </span>
        <button type="button" role="switch" aria-checked={settings.promptDock} aria-labelledby="prompt-dock-label" aria-describedby="prompt-dock-help"
          disabled={pending} onClick={() => void update({ promptDock: !settings.promptDock })}
          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-40 ${settings.promptDock ? 'border-primary bg-primary' : 'border-line bg-surface-3'}`}>
          <span aria-hidden="true" className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${settings.promptDock ? 'left-[1.125rem] bg-on-primary' : 'left-0.5 bg-ink-3'}`} />
        </button>
      </div>
      {settings.promptDock && <p className="mt-2 border-t border-line-soft pt-2 text-[11px] leading-4 text-ink-3">
        Move a panel into the band from the dropdown in its own title bar, then pick how that side
        arranges them: stacked, side by side, a grid, or a honeycomb.
      </p>}
    </div>
    <fieldset disabled={pending} className="mt-5">
      <legend className="text-xs font-medium text-ink">Accent color</legend>
      <p id="accent-help" className="mt-1 max-w-lg text-xs leading-5 text-ink-2">Apply your color to buttons, focus rings, highlights, editor, terminal, and desktop windows. The tone adapts for contrast.</p>
      <div className="mt-3 flex flex-wrap gap-2" aria-label={`Accent presets for the ${active} theme`}>
        {presets.map((preset) => {
          const tone = appliedAccent(preset.color);
          return <button key={preset.color} type="button" aria-pressed={tone === palette.accent}
            onClick={() => void update({ secondaryAccent: preset.color })}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${tone === palette.accent ? 'border-accent bg-accent/10' : 'border-line hover:bg-surface-2'}`}>
            <span aria-hidden="true" className="h-3 w-3 rounded-full border border-black/10" style={{ background: tone }} />{preset.name}
          </button>;
        })}
      </div>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (valid) void update({ secondaryAccent: draft.toLowerCase() }); }}>
        <label className="flex flex-col gap-1 text-[11px] text-ink-2">Custom color
          <input type="color" aria-label="Custom accent color" value={valid ? draft : settings.secondaryAccent} onChange={(event) => { setDraft(event.target.value); setError(''); setNotice(''); }}
            className="h-8 w-9 cursor-pointer rounded border border-line bg-surface-2 p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-ink-2">Hex value
          <input type="text" aria-label="Accent hex value" aria-describedby="accent-help accent-validation" aria-invalid={!valid}
            value={draft} spellCheck={false} maxLength={7} onChange={(event) => { setDraft(event.target.value); setError(''); setNotice(''); }}
            className="h-8 w-24 rounded border border-line bg-surface-2 px-2 font-mono text-xs text-ink focus:border-primary focus:outline-none" />
        </label>
        <button type="submit" disabled={!valid || draft.toLowerCase() === settings.secondaryAccent}
          className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-strong disabled:cursor-default disabled:opacity-40">Apply color</button>
      </form>
      {!valid && <p id="accent-validation" className="mt-2 text-xs text-danger">Use a six-digit hex color, for example #33b7a6.</p>}
    </fieldset>
    <div className="mt-5 border-t border-line pt-5">
      <FontsSection fonts={settings.fonts} disabled={pending} onChange={(fonts) => void update({ fonts })} />
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" disabled={pending || atDefaults && draft === DEFAULT_APPEARANCE.secondaryAccent}
        onClick={() => void update({ ...DEFAULT_APPEARANCE })}
        className="rounded text-[11px] text-ink-2 underline decoration-line underline-offset-4 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default disabled:opacity-40">Reset to dark &amp; teal</button>
      <p role="status" className="text-[11px] text-ink-2">{pending ? 'Saving appearance…' : notice}</p>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </section>;
}
