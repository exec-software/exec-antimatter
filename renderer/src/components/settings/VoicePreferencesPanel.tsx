import { useEffect, useState } from 'react';
import type { VoiceConfiguration } from '../../../../src/api/voice';
import { VoiceSettingsPanel } from '../chat/VoiceSettingsPanel';

/** Settings configures speech, never starts the microphone. Chat owns the live session. */
export function VoicePreferencesPanel({ active, onSaved }: { active: boolean; onSaved(config: VoiceConfiguration): void }) {
  const [config, setConfig] = useState<VoiceConfiguration | null>(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let changed = false;
    const unsubscribe = window.electronAPI.voice.onState((state) => { changed = true; setVoiceActive(state.active); });
    setError('');
    void window.electronAPI.voice.get().then((next) => {
      if (!alive) return;
      setConfig(next);
      if (!changed) setVoiceActive(next.state.active);
    }).catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { alive = false; unsubscribe(); };
  }, [active, retry]);
  return <>
    <p className="mb-5 text-xs leading-5 text-ink-2">Start a voice conversation from the microphone beside the chat composer or from your desktop avatar. Nothing here enables microphone capture.</p>
    {error && <p role="alert" className="mb-4 text-xs text-danger">{error} <button type="button" onClick={() => setRetry((value) => value + 1)} className="underline">Retry</button></p>}
    {config ? <VoiceSettingsPanel config={config} disabled={voiceActive} embedded onSaved={(next) => { setConfig(next); onSaved(next); }} />
      : !error && <p role="status" className="text-xs text-ink-3">Loading voice settings…</p>}
  </>;
}
