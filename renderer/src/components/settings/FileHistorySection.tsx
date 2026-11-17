import { useEffect, useState } from 'react';
import { announceDeveloperSettings } from '../../lib/developerSettingsChanged';
import type { FileHistorySettings } from '../../types';
import { FileHistoryPanel } from '../developer/FileHistoryPanel';

const FALLBACK: FileHistorySettings = { enabled: false };

/**
 * Experimental local file history, and the shared scratch area beside it.
 *
 * In Settings with the other switches about what this machine lets Antimatter do, rather than on
 * the Developer page: it is not about how a turn is run, it is about what gets written where.
 *
 * It owns its read and write rather than taking them as props, so Settings does not have to
 * carry developer state through for one checkbox.
 */
const STALE_BUILD =
  'This copy of Antimatter is running an older main process, which has no such setting — so there is nothing ' +
  'here to turn on yet. Restart Antimatter and it will appear.';

export function FileHistorySection() {
  const [value, setValue] = useState<FileHistorySettings | null>(null);
  const [error, setError] = useState('');

  /**
   * A main process that predates the setting answers without the field.
   *
   * It then has no value to show and nothing a click could change, and a checkbox that is merely
   * greyed out says none of that — it reads as a setting the person is not allowed to have. So the
   * absent field is distinguished from a slow read and named, because the fix is a restart and
   * nobody guesses that from a dead control.
   */
  const settled = (stored: { fileHistory?: FileHistorySettings }): boolean => {
    if (stored.fileHistory) {
      setValue(stored.fileHistory);
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
        console.error('Could not read the file-history setting:', cause);
        setError('Could not read this setting. It is unchanged.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Show the change at once and let the write follow, and keep what main stored rather than what
  // was clicked: a value it normalized must not stay on screen as though it had been accepted.
  const apply = (next: FileHistorySettings) => {
    setValue(next);
    setError('');
    void window.electronAPI.developer
      .get()
      .then((stored) => window.electronAPI.developer.set({ ...stored, fileHistory: next }))
      .then((stored) => {
        const ok = settled(stored);
        // Tell anything showing one of these to re-read; the sidebar decides what the Desk lists.
        announceDeveloperSettings();
        return ok;
      })
      .catch((cause) => {
        console.error('Could not save the file-history setting:', cause);
        setError('Could not save that. It is unchanged.');
      });
  };

  return (
    <section className="mb-6">
      <h3 className="text-sm font-medium text-ink">File history</h3>
      <p className="mb-3 mt-1 text-xs leading-5 text-ink-3">
        Whether a local, versioned copy of every file a tool changes is kept beside the project, so a change can be
        undone long after the turn that made it.
      </p>
      <FileHistoryPanel value={value ?? FALLBACK} onChange={apply} disabled={!value} />
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
