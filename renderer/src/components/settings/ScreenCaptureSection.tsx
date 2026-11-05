import { useEffect, useState } from 'react';
import type { ScreenCaptureSettings } from '../../types';
import { ScreenCapturePanel } from '../developer/ScreenCapturePanel';

const FALLBACK: ScreenCaptureSettings = { withoutAsking: true };

/**
 * What a model may photograph.
 *
 * In Settings rather than on the Developer page: that page is for switches that change how a
 * turn is run, and this decides whether the model can see at all. Someone looking for it is
 * asking a privacy question about their own screen, and will look here.
 *
 * It owns its read and write rather than taking them as props, so Settings does not have to
 * carry developer state through for one checkbox.
 */
export function ScreenCaptureSection() {
  const [value, setValue] = useState<ScreenCaptureSettings | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.developer
      .get()
      .then((stored) => {
        if (!cancelled) setValue(stored.screenCapture);
      })
      .catch((cause) => {
        if (cancelled) return;
        console.error('Could not read the screen capture setting:', cause);
        setError('Could not read this setting. It is unchanged.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Show the change at once and let the write follow, and keep what main stored rather than what
  // was clicked: a value it normalized must not stay on screen as though it had been accepted.
  const apply = (next: ScreenCaptureSettings) => {
    setValue(next);
    setError('');
    void window.electronAPI.developer
      .get()
      .then((stored) => window.electronAPI.developer.set({ ...stored, screenCapture: next }))
      .then((stored) => setValue(stored.screenCapture))
      .catch((cause) => {
        console.error('Could not save the screen capture setting:', cause);
        setError('Could not save that. It applies to this session but is not remembered.');
      });
  };

  return (
    <section className="mb-6">
      <h3 className="text-sm font-medium text-ink">Screen capture</h3>
      <p className="mb-3 mt-1 text-xs leading-5 text-ink-3">
        What a model may photograph, and whether you are asked each time. This is how it checks a page or program it
        has just built; without it a model tends to report work finished that it never looked at.
      </p>
      <ScreenCapturePanel value={value ?? FALLBACK} onChange={apply} disabled={!value} />
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
