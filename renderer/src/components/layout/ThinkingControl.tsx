import { useEffect, useRef, useState } from 'react';
import { Brain } from 'lucide-react';
import { thinkingSupport } from '../../../../src/api/thinking';
import type { ProviderConfig, ThinkingLevel } from '../../types';

/**
 * The thinking level for the model this conversation is using, in the header.
 *
 * The control itself already existed, but only inside a model card's Edit settings and the
 * Settings model-profile editor - both several clicks from the conversation, and both framed as
 * editing a model rather than steering the turn you are about to send. The setting it writes is
 * the same per-model profile override, so a change here shows up there and survives a restart.
 *
 * Hidden entirely when the source/model pair has no known control, rather than shown disabled:
 * `thinkingSupport` is deliberately conservative, and an inert dropdown reads as a broken
 * feature instead of an absent one.
 */
const LABELS: Record<ThinkingLevel, string> = {
  default: 'Model default',
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** The level in a word, for the collapsed button. */
const SHORT: Record<ThinkingLevel, string> = {
  default: 'Auto',
  off: 'Off',
  low: 'Low',
  medium: 'Med',
  high: 'High',
};

export function ThinkingControl({ source, modelId }: { source: ProviderConfig | null; modelId: string }) {
  const [level, setLevel] = useState<ThinkingLevel>('default');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const container = useRef<HTMLDivElement>(null);

  const sourceId = source?.id ?? '';
  const support = source && modelId ? thinkingSupport(source, modelId) : null;
  const available = support !== null && support.levels.length > 1;

  // Load the saved override whenever the conversation's model changes, so the header always
  // shows the level the next request will actually carry.
  useEffect(() => {
    if (!available || !sourceId || !modelId) return;
    let cancelled = false;
    void window.electronAPI.modelWorkloads.resolve(sourceId, modelId)
      .then((profile) => { if (!cancelled) setLevel(profile?.thinkingLevel ?? 'default'); })
      .catch(() => { /* An unreadable profile leaves the control at the model default. */ });
    return () => { cancelled = true; };
  }, [available, sourceId, modelId]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);

  if (!available || !support) return null;

  const choose = async (next: ThinkingLevel) => {
    setBusy(true); setError('');
    const previous = level;
    setLevel(next);
    try {
      // `default` clears the override rather than storing a level, so the model's own behaviour
      // comes back instead of being pinned to whatever it happened to be.
      await window.electronAPI.modelWorkloads.setDefaultSettings(sourceId, modelId, { thinkingLevel: next });
      setOpen(false);
    } catch (cause) {
      setLevel(previous);
      setError(cause instanceof Error ? cause.message : 'Could not save the thinking level.');
    } finally {
      setBusy(false);
    }
  };

  return <div ref={container} className="relative">
    <button type="button" onClick={() => setOpen((current) => !current)} disabled={busy}
      aria-haspopup="menu" aria-expanded={open}
      title={`Thinking level: ${LABELS[level]}. ${support.description}`}
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition hover:text-ink disabled:opacity-50 ${
        level === 'default' ? 'text-ink-3' : 'text-primary'}`}>
      <Brain size={13} />
      {SHORT[level]}
    </button>
    {open && <div role="menu" aria-label="Thinking level"
      className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-line bg-surface p-1 shadow-xl">
      {support.levels.map((option) => (
        <button key={option} type="button" role="menuitemradio" aria-checked={option === level}
          disabled={busy} onClick={() => void choose(option)}
          className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs disabled:opacity-50 ${
            option === level ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`}>
          {LABELS[option]}
          {option === level && <span className="text-[10px] text-primary">current</span>}
        </button>
      ))}
      <p className="px-2 pb-1 pt-1.5 text-[10px] leading-relaxed text-ink-3">{support.description}</p>
      <p className="px-2 pb-1 text-[10px] leading-relaxed text-ink-3">
        Saved for this model and used by its next request, including agent runs.
      </p>
      {error && <p role="alert" className="px-2 pb-1 text-[10px] text-danger">{error}</p>}
    </div>}
  </div>;
}
