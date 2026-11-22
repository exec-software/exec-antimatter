import { useEffect, useState } from 'react';
import { announceDeveloperSettings } from '../../lib/developerSettingsChanged';
import type { GuardrailSettings } from '../../types';
import { GuardrailsPanel } from '../developer/GuardrailsPanel';

/**
 * The shipped behaviour, shown only while a main process too old to have the setting is answering.
 * Never written back: a value this page invented must not become the stored one.
 */
const FALLBACK: GuardrailSettings = {
  turnBudget: { enabled: true, limit: 2048 },
  batchOverrun: { enabled: true, limit: 3 },
  repeatedCalls: { enabled: true, limit: 3 },
  completionClaims: { enabled: true, limit: 3 },
  repeatedValidation: { enabled: true, limit: 3 },
  thinkingRetries: { enabled: true, limit: 2 },
  thinkingOnlyRetries: { enabled: true, limit: 2 },
  duplicateReads: { enabled: true },
};

const STALE_BUILD =
  'This copy of Antimatter is running an older main process, which has no such settings — so there is nothing ' +
  'here to change yet. Restart Antimatter and they will appear.';

/**
 * Guardrails: the tool-loop stop conditions.
 *
 * In Settings rather than on the Developer page, unlike auto-continue, because these are not one
 * switch about turn behaviour — they are the whole list, and the list is the point. Somebody
 * wondering why a turn ended in a grey note should be able to find every mechanism that could
 * have ended it in one place.
 *
 * It owns its read and write rather than taking them as props, like the other sections here, so
 * Settings does not have to carry developer state through for it.
 */
export function GuardrailsSection() {
  const [value, setValue] = useState<GuardrailSettings | null>(null);
  const [error, setError] = useState('');

  const settled = (stored: { guardrails?: GuardrailSettings }): boolean => {
    if (stored.guardrails) {
      setValue(stored.guardrails);
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
        console.error('Could not read the guardrail settings:', cause);
        setError('Could not read these settings. They are unchanged.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Show the change at once and let the write follow, and keep what main stored rather than what
  // was clicked: a limit it clamped must not stay on screen as though it had been accepted.
  const apply = (next: GuardrailSettings) => {
    setValue(next);
    setError('');
    void window.electronAPI.developer
      .get()
      .then((stored) => window.electronAPI.developer.set({ ...stored, guardrails: next }))
      .then((stored) => {
        const ok = settled(stored);
        announceDeveloperSettings();
        return ok;
      })
      .catch((cause) => {
        console.error('Could not save the guardrail settings:', cause);
        setError('Could not save that. It is unchanged.');
      });
  };

  return (
    <section className="mb-6">
      <h3 className="text-sm font-medium text-ink">Guardrails</h3>
      <p className="mb-3 mt-1 text-xs leading-5 text-ink-3">
        What ends a turn besides the model finishing it. Each rail was added for a model that needed it; a model
        that does not needs none of them, and this is where you say so. Changes apply to the next message you send.
      </p>
      <GuardrailsPanel value={value ?? FALLBACK} onChange={apply} disabled={!value} />
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}
