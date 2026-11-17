import { useEffect, useState } from 'react';
import { announceDeveloperSettings } from '../../lib/developerSettingsChanged';
import type { HardwareAccelerationSettings } from '../../types';
import { HardwareAccelerationPanel } from '../developer/HardwareAccelerationPanel';

const FALLBACK: HardwareAccelerationSettings = { enabled: true };

/**
 * Whether the interface may use the GPU.
 *
 * In Settings beside the other machine-level switches rather than on the Developer page: it is
 * not about how a turn is run, it is about what this computer lets the application do. Someone
 * hunting for it is asking why their WebGL page is blank, and will look here first.
 *
 * It owns its read and write rather than taking them as props, so Settings does not have to
 * carry developer state through for one checkbox.
 */
const STALE_BUILD =
  'This copy of Antimatter is running an older main process, which has no such setting — so there is nothing ' +
  'here to turn on yet. Restart Antimatter and it will appear.';

export function HardwareAccelerationSection() {
  const [value, setValue] = useState<HardwareAccelerationSettings | null>(null);
  const [error, setError] = useState('');

  /**
   * A main process that predates the setting answers without the field.
   *
   * It then has no value to show and nothing a click could change, and a checkbox that is merely
   * greyed out says none of that — it reads as a setting the person is not allowed to have. So the
   * absent field is distinguished from a slow read and named, because the fix is a restart and
   * nobody guesses that from a dead control.
   */
  const settled = (stored: { hardwareAcceleration?: HardwareAccelerationSettings }): boolean => {
    if (stored.hardwareAcceleration) {
      setValue(stored.hardwareAcceleration);
      return true;
    }
    setValue(null);
    setError(STALE_BUILD);
    return false;
  };

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.developer
      .get()
      .then((stored) => {
        if (!cancelled) settled(stored);
      })
      .catch((cause) => {
        if (cancelled) return;
        console.error('Could not read the GPU setting:', cause);
        setError('Could not read this setting. It is unchanged.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Show the change at once and let the write follow, and keep what main stored rather than what
  // was clicked: a value it normalized must not stay on screen as though it had been accepted.
  const apply = (next: HardwareAccelerationSettings) => {
    setValue(next);
    setError('');
    void window.electronAPI.developer
      .get()
      .then((stored) => window.electronAPI.developer.set({ ...stored, hardwareAcceleration: next }))
      .then((stored) => {
        const ok = settled(stored);
        // Tell anything showing one of these to re-read; the sidebar decides what the Desk lists.
        announceDeveloperSettings();
        return ok;
      })
      .catch((cause) => {
        console.error('Could not save the GPU setting:', cause);
        setError('Could not save that. It is unchanged.');
      });
  };

  return (
    <section className="mb-6">
      <h3 className="text-sm font-medium text-ink">Graphics</h3>
      <p className="mb-3 mt-1 text-xs leading-5 text-ink-3">
        Whether Antimatter&rsquo;s own window and the preview pane are drawn with the GPU. This is also what decides
        whether a WebGL page can run inside the preview at all.
      </p>
      <HardwareAccelerationPanel value={value ?? FALLBACK} onChange={apply} disabled={!value} />
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
