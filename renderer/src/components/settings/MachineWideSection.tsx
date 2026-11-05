import { useEffect, useState } from 'react';
import type { MachineWideSettings } from '../../types';
import { MachineWidePanel } from '../developer/MachineWidePanel';

const FALLBACK: MachineWideSettings = { withoutAsking: false };

/**
 * What a model may change outside the project.
 *
 * Beside Screen capture rather than on the Developer page, for the same reason: that page is for
 * switches that change how a turn is run, and this one answers a question about the machine the
 * turn is running on. Someone looking for it is asking what an agent is allowed to do to their
 * computer, and will look here.
 *
 * It owns its read and write rather than taking them as props, so Settings does not have to carry
 * developer state through for one checkbox.
 */
const STALE_BUILD =
  'This copy of Antimatter is running an older main process, which has no such setting — so there is nothing ' +
  'here to turn on yet. Restart Antimatter and it will appear.';

export function MachineWideSection() {
  const [value, setValue] = useState<MachineWideSettings | null>(null);
  const [error, setError] = useState('');

  /**
   * A main process that predates the setting answers without the field.
   *
   * It then has no value to show and nothing a click could change, and a checkbox that is merely
   * greyed out says none of that — it reads as a setting the person is not allowed to have. So the
   * absent field is distinguished from a slow read and named, because the fix is a restart and
   * nobody guesses that from a dead control.
   */
  const settled = (stored: { machineWide?: MachineWideSettings }): boolean => {
    if (stored.machineWide) {
      setValue(stored.machineWide);
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
        console.error('Could not read the machine-wide command setting:', cause);
        setError('Could not read this setting. It is unchanged.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Show the change at once and let the write follow, and keep what main stored rather than what
  // was clicked: a value it normalized must not stay on screen as though it had been accepted.
  const apply = (next: MachineWideSettings) => {
    setValue(next);
    setError('');
    void window.electronAPI.developer
      .get()
      .then((stored) => window.electronAPI.developer.set({ ...stored, machineWide: next }))
      .then(settled)
      .catch((cause) => {
        console.error('Could not save the machine-wide command setting:', cause);
        setError('Could not save that. It applies to this session but is not remembered.');
      });
  };

  return (
    <section className="mb-6">
      <h3 className="text-sm font-medium text-ink">Commands that change the machine</h3>
      <p className="mb-3 mt-1 text-xs leading-5 text-ink-3">
        Full access is permission over the project. A command that reaches past it — installing a system package,
        running something as root — is put to you anyway, unless you answer here in advance.
      </p>
      <MachineWidePanel value={value ?? FALLBACK} onChange={apply} disabled={!value} />
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
