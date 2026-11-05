import { useEffect, useRef, useState } from 'react';
import { Bell, Music, Play, Volume2 } from 'lucide-react';
import {
  BUILT_IN_SOUNDS,
  MAX_CUSTOM_SOUND_BYTES,
  type NotificationSettings,
  type NotificationSoundId,
} from '../../../../src/api/notifications';
import { forgetCustomSound, previewNotificationSound } from '../../notifications';

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

const toggle = 'mt-0.5 shrink-0 accent-[rgb(var(--color-primary))]';

/**
 * Whether, and how, Antimatter says a turn has finished.
 *
 * In General rather than on a page of its own: it is one decision with a few parts, and the
 * question someone arrives with ("why didn't it tell me?", "how do I stop the noise?") is a
 * preference about this window, which is what this category is.
 *
 * The two channels are listed before the sound, and the sound choices stay visible with the
 * sound switched off. A list of sounds that vanishes the moment you turn sound off is a list you
 * cannot audition before deciding, and the preview button works either way on purpose.
 */
export function NotificationsPanel() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  /**
   * Which file the decoded copy came from.
   *
   * Every save broadcasts, including a volume nudge, so throwing the decoded sound away on each
   * change would re-read a two-megabyte file over IPC to hear the same sound. Only a different
   * file is a reason to forget it.
   */
  const decoded = useRef<string | null>(null);
  const noteSound = (next: NotificationSettings) => {
    const key = next.customSound ? `${next.customSound.path}|${next.customSound.bytes}` : null;
    if (key === decoded.current) return;
    decoded.current = key;
    forgetCustomSound();
  };

  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.electronAPI.notifications.onChanged((next) => {
      noteSound(next);
      if (alive.current) setSettings(next);
    });
    window.electronAPI.notifications.get()
      .then((next) => { noteSound(next); if (alive.current) setSettings(next); })
      .catch((cause) => {
        console.error('Could not read notification settings:', cause);
        if (alive.current) setError('Could not read these settings. They are unchanged.');
      });
    return () => { alive.current = false; unsubscribe(); };
  }, []);

  /** Show the change at once, then keep whatever main stored rather than what was clicked. */
  const apply = (patch: Partial<NotificationSettings>) => {
    if (!settings) return;
    setSettings({ ...settings, ...patch });
    setError('');
    void window.electronAPI.notifications.update(patch)
      .then((next) => { if (alive.current) setSettings(next); })
      .catch((cause) => {
        console.error('Could not save notification settings:', cause);
        if (alive.current) setError('Could not save that. It applies to this session but is not remembered.');
      });
  };

  const chooseSound = () => {
    setBusy(true);
    setError('');
    void window.electronAPI.notifications.chooseSound()
      .then((next) => {
        // Null is a cancelled picker, which is not a change and not a failure.
        if (!next) return;
        noteSound(next);
        if (alive.current) setSettings(next);
      })
      .catch((cause) => {
        console.error('Could not use that sound:', cause);
        if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not use that sound.');
      })
      .finally(() => { if (alive.current) setBusy(false); });
  };

  const clearSound = () => {
    setError('');
    void window.electronAPI.notifications.clearSound()
      .then((next) => { noteSound(next); if (alive.current) setSettings(next); })
      .catch((cause) => {
        console.error('Could not remove that sound:', cause);
        if (alive.current) setError('Could not remove that sound.');
      });
  };

  const choices: { id: NotificationSoundId; label: string; description: string }[] = [
    ...BUILT_IN_SOUNDS.map((sound) => ({ id: sound.id as NotificationSoundId, label: sound.label, description: sound.description })),
    ...(settings?.customSound
      ? [{ id: 'custom' as NotificationSoundId, label: settings.customSound.name, description: `Your own sound · ${megabytes(settings.customSound.bytes)}` }]
      : []),
  ];

  return (
    <section className="mb-6 border-t border-line pt-6">
      <h3 className="text-sm font-medium text-ink">Notifications</h3>
      <p className="mb-3 mt-1 text-xs leading-5 text-ink-3">
        How Antimatter tells you a chat has finished while you are doing something else. A long turn on a local
        model is minutes of nothing to look at, so neither of these waits for the window to be in front of you.
      </p>
      {error && <p role="alert" className="mb-3 text-xs text-danger">{error}</p>}
      <div className="space-y-3 rounded-lg border border-line bg-surface-2 p-3">
        <label className="flex cursor-pointer items-start gap-2">
          <input type="checkbox" aria-label="Desktop notification" className={toggle} disabled={!settings}
            checked={settings?.desktop ?? false} onChange={(event) => apply({ desktop: event.target.checked })} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-medium text-ink"><Bell size={14} className="text-primary" aria-hidden="true" />Desktop notification</span>
            <span className="mt-1 block text-xs leading-relaxed text-ink-2">
              A notice from your desktop naming the conversation and how long the turn took. Clicking it brings
              Antimatter forward and opens that chat. Whether it appears at all is your desktop&rsquo;s decision —
              a do-not-disturb mode will swallow it.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2">
          <input type="checkbox" aria-label="Notification sound" className={toggle} disabled={!settings}
            checked={settings?.sound ?? false} onChange={(event) => apply({ sound: event.target.checked })} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-medium text-ink"><Volume2 size={14} className="text-primary" aria-hidden="true" />Sound</span>
            <span className="mt-1 block text-xs leading-relaxed text-ink-2">Played by Antimatter itself, so it carries whether or not the notice does.</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2">
          <input type="checkbox" aria-label="Notify only when you are not watching that chat" className={toggle}
            disabled={!settings} checked={settings?.onlyWhenUnfocused ?? false}
            onChange={(event) => apply({ onlyWhenUnfocused: event.target.checked })} />
          <span className="min-w-0">
            <span className="text-sm font-medium text-ink">Only when you are not watching that chat</span>
            <span className="mt-1 block text-xs leading-relaxed text-ink-2">
              Stays quiet while Antimatter has focus <em>and</em> the finished conversation is the one on screen.
              A turn finishing in another chat still announces itself: from where you are sitting it is just as
              invisible as one finishing behind a browser.
            </span>
          </span>
        </label>
      </div>

      <div className="mt-3 rounded-lg border border-line bg-surface-2 p-3">
        <div className="mb-2 flex items-center gap-2">
          <h4 className="flex-1 text-xs font-medium text-ink">Which sound</h4>
          <button type="button" disabled={!settings}
            onClick={() => { if (settings) void previewNotificationSound(settings); }}
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-2 transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">
            <Play size={12} aria-hidden="true" />Play
          </button>
        </div>
        <div role="radiogroup" aria-label="Which notification sound" className="grid gap-1 sm:grid-cols-2">
          {choices.map((choice) => <label key={choice.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-3">
            <input type="radio" name="notification-sound" value={choice.id} className={toggle} disabled={!settings}
              checked={settings?.soundId === choice.id}
              onChange={() => {
                if (!settings) return;
                // Auditioned on selection: choosing a sound you cannot hear is choosing blind.
                apply({ soundId: choice.id });
                void previewNotificationSound({ ...settings, soundId: choice.id });
              }} />
            <span className="min-w-0">
              <span className="block truncate text-xs text-ink">{choice.label}</span>
              <span className="block truncate text-[11px] text-ink-3">{choice.description}</span>
            </span>
          </label>)}
        </div>
        <label className="mt-3 flex items-center gap-3">
          <span className="w-16 shrink-0 text-xs text-ink-2">Volume</span>
          <input type="range" aria-label="Notification volume" min={0} max={1} step={0.05} disabled={!settings} value={settings?.volume ?? 0}
            onChange={(event) => apply({ volume: Number(event.target.value) })}
            className="h-1 min-w-0 flex-1 accent-[rgb(var(--color-primary))]" />
          <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-ink-3">
            {settings ? `${Math.round(settings.volume * 100)}%` : '—'}
          </span>
        </label>
        {settings && settings.volume === 0 && <p className="mt-1 text-[11px] text-ink-3">At zero nothing is played, even with sound switched on.</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Music size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
          <p className="min-w-40 flex-1 text-[11px] leading-4 text-ink-3">
            {settings?.customSound
              ? <>Using <span className="text-ink-2">{settings.customSound.name}</span>. Antimatter keeps its own copy, so moving or deleting the original is safe.</>
              : <>Or use your own: a WAV, MP3, Ogg, FLAC or M4A file under {megabytes(MAX_CUSTOM_SOUND_BYTES)}.</>}
          </p>
          <button type="button" disabled={!settings || busy} onClick={chooseSound}
            className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-2 transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">
            {busy ? 'Choosing…' : settings?.customSound ? 'Replace…' : 'Choose a file…'}
          </button>
          {settings?.customSound && <button type="button" onClick={clearSound}
            className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-2 transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            Remove
          </button>}
        </div>
      </div>
    </section>
  );
}
