import { useEffect, useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import type { DeveloperSettings } from '../../types';
import { AutoContinuePanel } from './AutoContinuePanel';
import { ModelTestPromptsPanel } from './ModelTestPromptsPanel';

/** What the page shows before main has answered, and the base a patch is applied to. */
const FALLBACK: DeveloperSettings = {
  autoContinue: { enabled: false, maxContinues: 3, onRoundLimit: true },
  screenCapture: { withoutAsking: true },
  machineWide: { withoutAsking: false },
};

interface Props {
  onClose: () => void;
}

/**
 * Developer: the switches that change how Antimatter runs a turn.
 *
 * Its own page rather than a section of Settings, because the two answer different questions.
 * Settings is where sources, models, connections and updates are configured — the things that
 * decide *what* answers. This is where the behaviour around whatever is answering is changed,
 * and those are the settings worth being able to find quickly and turn off again.
 */
export function DeveloperPage({ onClose }: Props) {
  const [settings, setSettings] = useState<DeveloperSettings | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.developer
      .get()
      .then((stored) => {
        if (!cancelled) setSettings(stored);
      })
      .catch((cause) => {
        if (cancelled) return;
        console.error('Could not read developer settings:', cause);
        setError('Could not read these settings. They are unchanged.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Show the change at once and let the write follow. Main normalizes and returns what it stored,
   * which is what the page then shows: a value it clamped is a value the page must not keep
   * displaying as if it had been accepted.
   */
  const apply = (patch: Partial<DeveloperSettings>) => {
    // A patch rather than a whole object: each panel owns one switch and must not carry the others
    // back to main from whatever it last rendered.
    const next: DeveloperSettings = { ...(settings ?? FALLBACK), ...patch };
    setSettings(next);
    setError('');
    window.electronAPI.developer
      .set(next)
      .then(setSettings)
      .catch((cause) => {
        console.error('Could not save developer settings:', cause);
        setError('Could not save that. It will apply to this session but is not remembered.');
      });
  };

  return (
    <div className="absolute inset-0 overflow-y-auto bg-surface">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
        <SlidersHorizontal size={16} className="text-primary" />
        <h1 className="text-sm font-semibold text-ink">Developer</h1>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink"
        >
          <X size={12} />
          Done
        </button>
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 py-5">
        {error && (
          <p role="alert" className="mb-4 rounded-md border border-danger/50 bg-danger/5 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}

        <section>
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-3">Turns</h2>
          <p className="mt-1 text-xs text-ink-2">
            How far Antimatter goes on its own once you have sent a message. These change every turn, on every model,
            including the ones agents and scheduled runs take.
          </p>
          <div className="mt-3">
            <AutoContinuePanel
              value={settings?.autoContinue ?? FALLBACK.autoContinue}
              onChange={(autoContinue) => apply({ autoContinue })}
              disabled={!settings}
            />
          </div>
        </section>

        <ModelTestPromptsPanel />
      </div>
    </div>
  );
}
