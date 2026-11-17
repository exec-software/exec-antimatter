import { useEffect, useState } from 'react';
import type { WhiteboardSettings } from '../../types';
import { WhiteboardPanel } from '../developer/WhiteboardPanel';

const FALLBACK: WhiteboardSettings = { enabled: false };

/**
 * The whiteboard experiment.
 *
 * In Settings beside the other switches about what this machine lets Antimatter do, rather than
 * on the Developer page: it adds a surface and a per-conversation document, which is a question
 * about what gets written where and not about how a turn is run.
 */
const STALE_BUILD =
  'This copy of Antimatter is running an older main process, which has no such setting — so there is nothing ' +
  'here to turn on yet. Restart Antimatter and it will appear.';

export function WhiteboardSection() {
  const [value, setValue] = useState<WhiteboardSettings | null>(null);
  const [error, setError] = useState('');

  /**
   * A main process that predates the setting answers without the field.
   *
   * It then has no value to show and nothing a click could change, and a checkbox that is merely
   * greyed out says none of that — it reads as a setting the person is not allowed to have. So the
   * absent field is distinguished from a slow read and named, because the fix is a restart and
   * nobody guesses that from a dead control.
   */
  const settled = (stored: { whiteboard?: WhiteboardSettings }): boolean => {
    if (stored.whiteboard) {
      setValue(stored.whiteboard);
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
        console.error('Could not read the whiteboard setting:', cause);
        setError('Could not read this setting. It is unchanged.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Show the change at once and let the write follow, and keep what main stored rather than what
  // was clicked: a value it normalized must not stay on screen as though it had been accepted.
  const apply = (next: WhiteboardSettings) => {
    setValue(next);
    setError('');
    void window.electronAPI.developer
      .get()
      .then((stored) => window.electronAPI.developer.set({ ...stored, whiteboard: next }))
      .then(settled)
      .catch((cause) => {
        console.error('Could not save the whiteboard setting:', cause);
        setError('Could not save that. It is unchanged.');
      });
  };

  return (
    <section className="mb-6">
      <h3 className="text-sm font-medium text-ink">Whiteboard</h3>
      <p className="mb-3 mt-1 text-xs leading-5 text-ink-3">
        A planning surface each conversation gets, that you and the model can both put things on.
      </p>
      <WhiteboardPanel value={value ?? FALLBACK} onChange={apply} disabled={!value} />
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
