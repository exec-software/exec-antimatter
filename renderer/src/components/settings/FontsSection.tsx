import { useEffect, useMemo, useState } from 'react';
import { Type } from 'lucide-react';
import {
  BUNDLED_FONTS,
  DEFAULT_FONTS,
  FONT_ROLES,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  SYSTEM_FAMILY,
  fontStack,
  type FontRole,
  type FontSettings,
  type SystemFontFamily,
} from '../../../../src/api/fonts';

const LABELS: Record<FontRole, { name: string; hint: string; sample: string }> = {
  ui: {
    name: 'Interface',
    hint: 'Menus, buttons, sidebars and labels. Not the wordmark, which keeps its own face.',
    sample: 'Settings · Models · Inference servers',
  },
  chat: {
    name: 'Chat',
    hint: 'The model’s prose, which is read rather than operated.',
    sample: 'The quick brown fox jumps over the lazy dog.',
  },
  mono: {
    name: 'Code',
    hint: 'Fenced blocks, inline code and the terminal. Kept separate so a display face on the interface cannot reach a diff.',
    sample: 'const l1I = 0O; // 1l I0 O0',
  },
};

const control = 'rounded-md border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink';

export function FontsSection({ fonts, onChange, disabled }: {
  fonts: FontSettings;
  onChange(next: FontSettings): void;
  disabled?: boolean;
}) {
  const [system, setSystem] = useState<SystemFontFamily[]>([]);
  const [enumerated, setEnumerated] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.systemFonts.list()
      .then((families) => { if (!cancelled) { setSystem(families); setEnumerated(true); } })
      // Enumeration is an enhancement: the bundled faces and the system default still work.
      .catch(() => { if (!cancelled) setEnumerated(false); });
    return () => { cancelled = true; };
  }, []);

  // The code picker leads with fixed-advance families, because a proportional face there is
  // almost always a mistake rather than a preference.
  const grouped = useMemo(() => {
    const mono = system.filter((entry) => entry.monospace);
    const rest = system.filter((entry) => !entry.monospace);
    return { mono, rest };
  }, [system]);

  const set = (role: FontRole, patch: Partial<{ family: string; size: number }>): void =>
    onChange({ ...fonts, [role]: { ...fonts[role], ...patch } });

  return <section className="space-y-3">
    <header>
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-ink"><Type size={13} className="text-accent" />Fonts</h3>
      <p className="mt-1 text-xs leading-5 text-ink-2">
        Three faces, the way an IDE splits them: one for the interface, one for reading, one for
        code. Bundled faces always work; the rest are what this machine has installed.
      </p>
    </header>

    {FONT_ROLES.map((role) => {
      const choice = fonts[role];
      const offered = BUNDLED_FONTS.filter((font) => font.roles.includes(role));
      const bundledNote = offered.find((font) => font.family === choice.family)?.note;
      return <div key={role} className="rounded-lg border border-line bg-surface-2 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-xs font-semibold text-ink">{LABELS[role].name}</h4>
          <span className="text-[10px] text-ink-3">{choice.family || 'System default'} · {choice.size}px</span>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-ink-3">{LABELS[role].hint}</p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[10px] text-ink-3">
            <span className="sr-only">{LABELS[role].name} font family</span>
            <select
              aria-label={`${LABELS[role].name} font family`}
              className={`${control} min-w-0 flex-1`}
              value={choice.family}
              disabled={disabled}
              onChange={(event) => set(role, { family: event.target.value })}
            >
              <option value={SYSTEM_FAMILY}>System default</option>
              {offered.length > 0 && <optgroup label="Bundled">
                {offered.map((font) => <option key={font.family} value={font.family}>{font.label}</option>)}
              </optgroup>}
              {role === 'mono' && grouped.mono.length > 0 && <optgroup label="Installed · fixed width">
                {grouped.mono.map((font) => <option key={font.family} value={font.family}>{font.family}</option>)}
              </optgroup>}
              {grouped.rest.length > 0 && <optgroup label="Installed">
                {grouped.rest.map((font) => <option key={font.family} value={font.family}>{font.family}</option>)}
              </optgroup>}
              {role !== 'mono' && grouped.mono.length > 0 && <optgroup label="Installed · fixed width">
                {grouped.mono.map((font) => <option key={font.family} value={font.family}>{font.family}</option>)}
              </optgroup>}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-ink-3">
            Size
            <input
              type="number"
              aria-label={`${LABELS[role].name} font size in pixels`}
              className={`${control} w-16`}
              min={MIN_FONT_SIZE}
              max={MAX_FONT_SIZE}
              step={1}
              value={choice.size}
              disabled={disabled}
              onChange={(event) => {
                const size = Number(event.target.value);
                if (Number.isInteger(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE) set(role, { size });
              }}
            />
          </label>
        </div>

        {/*
          The preview paints in the chosen face at the chosen size, from the same `fontStack`
          the application uses, so what is shown here is what will be applied -- including the
          fallback, which is the part a 7 KB pixel font makes visible.
        */}
        <p
          className="mt-2 overflow-hidden text-ellipsis whitespace-nowrap rounded-md border border-line-soft bg-surface-3 px-2 py-1.5 text-ink-2"
          style={{ fontFamily: fontStack(role, choice.family), fontSize: `${choice.size}px` }}
        >
          {LABELS[role].sample}
        </p>
        {bundledNote && <p className="mt-1 text-[10px] leading-4 text-ink-3">{bundledNote}</p>}
      </div>;
    })}

    {enumerated === false && <p className="text-[11px] leading-4 text-ink-3">
      Installed fonts could not be listed on this machine, so only the bundled faces and the
      system default are offered.
    </p>}

    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange({ ...DEFAULT_FONTS })}
      className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-2 hover:text-ink disabled:opacity-50"
    >
      Reset to defaults
    </button>
  </section>;
}
