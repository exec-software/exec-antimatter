import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Laptop, LoaderCircle, Plus, QrCode, ShieldCheck, Smartphone, Trash2, Wifi, WifiOff, X } from 'lucide-react';
import type { RemoteHostState, RemotePairingOfferView } from '../../types';
import { parseRemotePairingOffer } from './remotePairingOffer';

interface PresentedPairingOffer extends RemotePairingOfferView {
  existingDeviceIds: string[];
}

const EMPTY: RemoteHostState = {
  enabled: false,
  running: false,
  address: null,
  port: 43_128,
  keepAwake: false,
  endpoint: null,
  certificatePin: null,
  interfaces: [],
  devices: [],
  error: null,
};

export function RemoteConnectionsPanel() {
  const [state, setState] = useState<RemoteHostState>(EMPTY);
  const [offer, setOffer] = useState<PresentedPairingOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);
  const activeOfferId = useRef<string | null>(null);

  const refresh = useCallback(() => window.electronAPI.remote.state().then(setState).catch((error) => {
    setMessage((error as Error).message);
  }), []);

  useEffect(() => {
    void refresh();
    return window.electronAPI.onRemoteChanged(setState);
  }, [refresh]);

  useEffect(() => window.electronAPI.onRemotePairingInvalidated(({ offerId }) => {
    setOffer((current) => current?.id === offerId ? null : current);
  }), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (activeOfferId.current) void window.electronAPI.remote.cancelPairingOffer(activeOfferId.current);
    };
  }, []);

  useEffect(() => {
    if (!offer) return;
    activeOfferId.current = offer.id;
    setNow(Date.now());
    const delay = Math.max(0, offer.expiresAt - Date.now());
    const timer = window.setTimeout(() => {
      setOffer((current) => current?.id === offer.id ? null : current);
    }, delay);
    const ticker = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(ticker);
      if (activeOfferId.current === offer.id) activeOfferId.current = null;
      void window.electronAPI.remote.cancelPairingOffer(offer.id);
    };
  }, [offer]);

  useEffect(() => {
    if (!offer) return;
    const existing = new Set(offer.existingDeviceIds);
    const paired = state.devices.some((device) => device.revokedAt === null && !existing.has(device.id));
    if (!state.running || paired) setOffer(null);
  }, [offer, state.devices, state.running]);

  const selectable = useMemo(() => state.interfaces.filter((item) => !item.internal), [state.interfaces]);
  const change = async (patch: Parameters<typeof window.electronAPI.remote.configure>[0]) => {
    setBusy(true);
    setMessage('');
    try {
      setState(await window.electronAPI.remote.configure(patch));
      setOffer(null);
    } catch (error) {
      setMessage((error as Error).message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
    } finally {
      setBusy(false);
    }
  };

  const addDevice = async () => {
    setBusy(true);
    setMessage('');
    setOffer(null);
    try {
      const next = parseRemotePairingOffer(await window.electronAPI.remote.createPairingOffer() as unknown);
      if (!mounted.current) {
        void window.electronAPI.remote.cancelPairingOffer(next.id);
        return;
      }
      activeOfferId.current = next.id;
      setOffer({
        ...next,
        existingDeviceIds: state.devices.filter((device) => device.revokedAt === null).map((device) => device.id),
      });
    } catch (error) {
      if (mounted.current) {
        setMessage((error as Error).message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const expiresIn = offer ? Math.max(0, Math.ceil((offer.expiresAt - now) / 1_000)) : 0;
  const expiryLabel = `${Math.floor(expiresIn / 60)}:${String(expiresIn % 60).padStart(2, '0')}`;
  const capabilityLabel = offer?.capabilities
    .map((capability) => capability === 'approvals' ? 'approval' : capability)
    .join(' and ');
  const accessLabel = offer
    ? `${offer.maxAccess.charAt(0).toUpperCase()}${offer.maxAccess.slice(1)}`
    : '';

  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md border border-line bg-surface-3 p-2 text-primary">
          <Laptop size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-ink">Control this computer</h3>
            <span className={`flex items-center gap-1 text-[11px] ${state.running ? 'text-success' : 'text-ink-3'}`}>
              {state.running ? <Wifi size={11} /> : <WifiOff size={11} />}
              {state.running ? 'Available' : 'Off'}
            </span>
            <button
              type="button"
              disabled={busy || (!state.enabled && !state.address)}
              onClick={() => void change({ enabled: !state.enabled })}
              className="ml-auto rounded-md border border-line px-2.5 py-1 text-[11px] text-ink transition hover:border-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {state.enabled ? 'Turn off' : 'Allow connections'}
            </button>
          </div>
          <p className="mt-1 text-xs text-ink-2">
            Paired devices use this computer's projects, models, tools, credentials, and permission rules. Choose one LAN or VPN address; Antimatter never opens every interface automatically.
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_110px]">
        <label className="grid gap-1 text-[11px] text-ink-3">
          Network interface
          <select
            value={state.address ?? ''}
            disabled={busy}
            onChange={(event) => void change({ address: event.target.value || null })}
            className="h-8 rounded-md border border-line bg-surface-3 px-2 text-xs text-ink outline-none focus:border-primary"
          >
            <option value="">Choose an address…</option>
            {selectable.map((item) => (
              <option key={`${item.name}:${item.address}`} value={item.address}>
                {item.name} · {item.address}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[11px] text-ink-3">
          Port
          <input
            type="number"
            min={1024}
            max={65535}
            value={state.port}
            disabled={busy}
            onChange={(event) => void change({ port: Number(event.target.value) })}
            className="h-8 rounded-md border border-line bg-surface-3 px-2 text-xs text-ink outline-none focus:border-primary"
          />
        </label>
      </div>

      <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md border border-line bg-surface px-2.5 py-2 text-xs text-ink-2">
        <input
          type="checkbox"
          checked={state.keepAwake}
          disabled={busy}
          onChange={(event) => void change({ keepAwake: event.target.checked })}
          className="mt-0.5 accent-primary"
        />
        <span>
          <span className="block text-ink">Keep this computer awake while Remote is available</span>
          <span className="mt-0.5 block text-[11px] text-ink-3">The app can stay in the tray, but the computer and selected network must remain online for your phone to connect.</span>
        </span>
      </label>

      {state.endpoint && (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-2 font-mono text-[11px] text-ink-2">
          <ShieldCheck size={13} className="shrink-0 text-success" />
          <span className="truncate">{state.endpoint}</span>
        </div>
      )}
      {(state.error || message) && <p className="mt-2 text-xs text-danger">{message || state.error}</p>}

      {state.running && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="flex items-center gap-2">
            <div>
              <h4 className="text-xs font-medium text-ink">Devices that can control this computer</h4>
              <p className="mt-0.5 text-[11px] text-ink-3">Pair each phone once. You can revoke it here at any time.</p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void addDevice()}
              className="ml-auto flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-on-primary disabled:opacity-50"
            >
              {busy ? <LoaderCircle size={12} className="animate-spin" /> : <Plus size={12} />}
              Add device
            </button>
          </div>

          {offer && (
            <div className="mt-3 rounded-lg border border-primary/40 bg-surface-3 p-3">
              <div className="flex items-start gap-2">
                <QrCode size={15} className="mt-0.5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <h5 className="text-sm font-medium text-ink">Scan with Antimatter on Android</h5>
                  <p className="mt-1 text-xs text-ink-2">
                    Open <strong>Workspaces → Add workspace → Scan QR code</strong>. This single-use code allows {capabilityLabel} control, with <strong>{accessLabel}</strong> as the access ceiling; each task still follows its selected access mode.
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Cancel pairing"
                  onClick={() => setOffer(null)}
                  className="rounded p-1 text-ink-3 hover:bg-surface hover:text-ink"
                >
                  <X size={13} />
                </button>
              </div>
              <div className="mt-3 flex flex-col items-center gap-2 sm:flex-row sm:items-start">
                <div className="rounded-lg bg-white p-2 shadow-sm">
                  <img
                    src={offer.qrDataUrl}
                    alt="Antimatter pairing QR code"
                    className="h-64 w-64 [image-rendering:pixelated]"
                    draggable={false}
                  />
                </div>
                <div className="min-w-0 flex-1 text-center sm:text-left">
                  <p className="text-xs font-medium text-primary">Expires in {expiryLabel}</p>
                  <p className="mt-1 text-[11px] text-ink-3">Only scan this from the phone you want to trust. A new code invalidates this one.</p>
                  <p className="mt-2 truncate font-mono text-[10px] text-ink-3">{offer.endpoint}</p>
                  <button
                    type="button"
                    onClick={() => void window.electronAPI.remote.copyPairingCode(offer.id).then((copied) => {
                      if (!copied) setOffer(null);
                      setMessage(copied ? 'Private pairing code copied for manual setup.' : 'That pairing offer has expired.');
                    })}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 hover:text-ink"
                  >
                    <Copy size={11} /> Copy code instead
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="mt-3 grid gap-2">
            {!state.devices.length && !offer && <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-ink-3">No paired devices</p>}
            {state.devices.filter((device) => !device.revokedAt).map((device) => (
              <div key={device.id} className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
                <Smartphone size={14} className="text-ink-3" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-ink">{device.name}</div>
                  <div className="text-[10px] text-ink-3">{device.maxAccess} access · {device.lastSeenAt ? `seen ${new Date(device.lastSeenAt).toLocaleString()}` : 'not connected yet'}</div>
                </div>
                <button
                  type="button"
                  aria-label={`Revoke ${device.name}`}
                  onClick={() => void window.electronAPI.remote.revokeDevice(device.id).then(setState)}
                  className="rounded p-1.5 text-ink-3 hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
