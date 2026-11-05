import { useEffect, useState } from 'react';
import { ArrowUpRight, Smartphone } from 'lucide-react';
import type { AppearanceSettings } from '../../../../src/api/appearance';
import { setupError } from '../settings/AssistantPanel';

/**
 * The optional last step. Nothing here is required to finish setup, and nothing is turned on
 * without being asked for: the companion-app switch is recommended in words, not pre-enabled.
 *
 * The download link is a deliberate placeholder until the published app has a URL.
 */
const PHONE_APP_URL: string | null = null;

interface RemoteSummary {
  enabled: boolean;
  running: boolean;
  address: string | null;
  endpoint: string | null;
}

export function SetupExtras({ onOpenRemoteSettings, disabled = false }: {
  onOpenRemoteSettings(): void;
  disabled?: boolean;
}) {
  const [remote, setRemote] = useState<RemoteSummary | null>(null);
  const [appearance, setAppearance] = useState<AppearanceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.electronAPI.remote.state().catch(() => null),
      window.electronAPI.appearance.get().catch(() => null),
    ]).then(([state, look]) => {
      if (cancelled) return;
      if (state) setRemote(state as RemoteSummary);
      if (look) setAppearance(look);
    });
    return () => { cancelled = true; };
  }, []);

  const allowConnections = async (next: boolean) => {
    setBusy(true); setError('');
    try {
      setRemote(await window.electronAPI.remote.configure({ enabled: next }) as RemoteSummary);
    } catch (cause) { setError(setupError(cause)); }
    finally { setBusy(false); }
  };

  const chooseTheme = async (theme: 'dark' | 'light') => {
    setBusy(true); setError('');
    try { setAppearance(await window.electronAPI.appearance.update({ theme })); }
    catch (cause) { setError(setupError(cause)); }
    finally { setBusy(false); }
  };

  // Connections need an interface to bind to. Without one, the switch here would fail, so
  // point at the full panel rather than offering a control that cannot work yet.
  const bindable = remote !== null && (remote.enabled || remote.address !== null);

  return <div className="space-y-4">
    <p className="text-sm leading-relaxed text-ink-2">
      Optional. Everything here can be changed later in Settings, and you can finish setup without
      touching any of it.
    </p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}

    <section className="rounded-lg border border-line bg-surface-2 p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium text-ink">
        <Smartphone size={15} className="text-ink-3" />Use Antimatter from your phone
      </h3>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
        The companion app gives you your chats and agents on your phone. Recommended. Chats, tools,
        files, and credentials stay on this computer; the phone is a window onto it.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-ink-3">
        Allowing connections opens a port on your local network. Each phone must still be paired
        with a code you approve here, and you can revoke any device later.
      </p>
      {remote === null ? (
        <p role="status" className="mt-3 text-xs text-ink-3">Reading connection settings…</p>
      ) : <>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" disabled={disabled || busy || !bindable}
            onClick={() => void allowConnections(!remote.enabled)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${remote.enabled
              ? 'border border-line text-ink-2 hover:text-ink' : 'bg-primary text-on-primary'}`}>
            {busy ? 'Saving…' : remote.enabled ? 'Turn off connections' : 'Allow connections'}
          </button>
          <button type="button" disabled={disabled} onClick={onOpenRemoteSettings}
            className="flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-xs text-accent disabled:opacity-50">
            Pair a device<ArrowUpRight size={12} />
          </button>
          <span className={`text-xs ${remote.running ? 'text-success' : 'text-ink-3'}`}>
            {remote.running ? 'Available' : remote.enabled ? 'Starting…' : 'Off'}
          </span>
        </div>
        {!bindable && <p className="mt-2 text-xs text-ink-3">
          Choose which network to listen on under Pair a device first.
        </p>}
        {remote.endpoint && <p className="mt-2 break-all font-mono text-[11px] text-ink-3">{remote.endpoint}</p>}
      </>}
      <p className="mt-3 text-xs text-ink-3">
        {PHONE_APP_URL
          ? <a href={PHONE_APP_URL} className="text-accent hover:underline">Download the companion app</a>
          : 'Companion app download: link to be added before release.'}
      </p>
    </section>

    <details className="rounded-lg border border-line bg-surface-2 p-4">
      <summary className="cursor-pointer text-sm font-medium text-accent">Advanced</summary>
      <div className="mt-3 space-y-4">
        <div>
          <p className="text-xs font-medium text-ink">Theme</p>
          <div className="mt-2 flex gap-2">
            {(['dark', 'light'] as const).map((theme) => (
              <button key={theme} type="button" disabled={disabled || busy || appearance === null}
                onClick={() => void chooseTheme(theme)} aria-pressed={appearance?.theme === theme}
                className={`rounded-md border px-3 py-1.5 text-xs capitalize disabled:opacity-50 ${appearance?.theme === theme
                  ? 'border-primary/60 bg-surface-3 text-ink' : 'border-line text-ink-2 hover:text-ink'}`}>
                {theme}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs leading-relaxed text-ink-3">
          Voice replies, tool permissions, agent roles, and model generation settings all have their
          own sections in Settings. None of them need a decision now.
        </p>
      </div>
    </details>
  </div>;
}
