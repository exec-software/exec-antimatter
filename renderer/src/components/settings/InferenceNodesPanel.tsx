import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, HardDrive, LoaderCircle, Plus, Server, ShieldCheck, Trash2, Wifi, WifiOff, X } from 'lucide-react';
import type { NodeAgentStatus, NodePairingOfferView, PairedNodeView } from '../../../../src/api/nodeAgent';
import { DEFAULT_NODE_AGENT_PORT } from '../../../../src/api/nodeAgent';

/**
 * Inference nodes: ADR 0001 stage 5, both directions.
 *
 * The top half is this box answering questions about itself — one chosen interface, a port, and a
 * list of controllers it trusts. The bottom half is the boxes this one has paired with, which is
 * what turns a workload's Distribution section from liveness into capacity.
 *
 * The pairing code holds a one-time bearer and never reaches this component. Creating an offer
 * returns only its identifier and expiry; Copy asks main to put the code on the clipboard. Leaving
 * the section cancels the offer, so a code cannot outlive the screen that showed it.
 */

const EMPTY: NodeAgentStatus = {
  enabled: false,
  running: false,
  address: null,
  port: DEFAULT_NODE_AGENT_PORT,
  endpoint: null,
  certificatePin: null,
  interfaces: [],
  controllers: [],
  error: null,
};

const clean = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause))
    .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

const ago = (at: number | null): string => {
  if (at === null) return 'not yet';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
};

const field = 'h-8 rounded-md border border-line bg-surface-3 px-2 text-xs text-ink outline-none focus:border-primary';
const button =
  'flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11px] text-ink transition hover:border-primary/60 disabled:cursor-not-allowed disabled:opacity-40';

export function InferenceNodesPanel() {
  const [status, setStatus] = useState<NodeAgentStatus>(EMPTY);
  const [paired, setPaired] = useState<PairedNodeView[]>([]);
  const [offer, setOffer] = useState<NodePairingOfferView | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [grantVitals, setGrantVitals] = useState(false);
  const [grantEngines, setGrantEngines] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const liveOffer = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [next, boxes] = await Promise.all([
        window.electronAPI.nodeAgent.status(),
        window.electronAPI.nodeAgent.listPaired(),
      ]);
      setStatus(next);
      setPaired(boxes);
    } catch (cause) {
      setMessage(clean(cause));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // A controller pairing from the other box changes this list without anyone clicking here.
  useEffect(() => window.electronAPI.onNodeAgentChanged(setStatus), []);

  // A code written down somewhere must stop working when the screen that produced it goes away.
  useEffect(() => () => {
    if (liveOffer.current) void window.electronAPI.nodeAgent.cancelPairingOffer(liveOffer.current);
  }, []);

  useEffect(() => {
    if (!offer) return;
    liveOffer.current = offer.id;
    const ticker = window.setInterval(() => setNow(Date.now()), 1000);
    const timer = window.setTimeout(() => setOffer(null), Math.max(0, offer.expiresAt - Date.now()));
    return () => {
      window.clearInterval(ticker);
      window.clearTimeout(timer);
      if (liveOffer.current === offer.id) liveOffer.current = null;
      void window.electronAPI.nodeAgent.cancelPairingOffer(offer.id);
    };
  }, [offer]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (cause) {
      setMessage(clean(cause));
    } finally {
      setBusy(false);
    }
  };

  const configure = (patch: Parameters<typeof window.electronAPI.nodeAgent.configure>[0]) =>
    act(async () => {
      setOffer(null);
      setStatus(await window.electronAPI.nodeAgent.configure(patch));
    });

  const selectable = status.interfaces.filter((item) => !item.internal);
  const expiresIn = offer ? Math.max(0, Math.ceil((offer.expiresAt - now) / 1000)) : 0;
  const controllers = status.controllers.filter((controller) => controller.revokedAt === null);

  return <div className="space-y-4">
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md border border-line bg-surface-3 p-2 text-primary"><Server size={16} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-ink">Answer as an inference node</h3>
            <span className={`flex items-center gap-1 text-[11px] ${status.running ? 'text-success' : 'text-ink-3'}`}>
              {status.running ? <Wifi size={11} /> : <WifiOff size={11} />}{status.running ? 'Answering' : 'Off'}
            </span>
            <button type="button" className={`${button} ml-auto`} disabled={busy || (!status.enabled && !status.address)}
              onClick={() => void configure({ enabled: !status.enabled })}>
              {status.enabled ? 'Turn off' : 'Start answering'}
            </button>
          </div>
          <p className="mt-1 text-xs leading-5 text-ink-2">
            Pair a controller to share accelerator memory and prepared checkpoints. Vitals and engine control require explicit permission below.
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_110px]">
        <label className="grid gap-1 text-[11px] text-ink-3">Network interface
          <select className={field} value={status.address ?? ''} disabled={busy}
            onChange={(event) => void configure({ address: event.target.value || null })}>
            <option value="">Choose an address…</option>
            {selectable.map((item) => (
              <option key={`${item.name}:${item.address}`} value={item.address}>{item.name} · {item.address}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[11px] text-ink-3">Port
          <input className={field} type="number" min={1024} max={65535} value={status.port} disabled={busy}
            onChange={(event) => void configure({ port: Number(event.target.value) })} />
        </label>
      </div>

      {status.endpoint && <p className="mt-2 break-all text-[11px] text-ink-3">{status.endpoint}</p>}
      {status.error && <p role="alert" className="mt-2 text-[11px] text-danger">{status.error}</p>}

      <div className="mt-3 border-t border-line pt-3">
        <fieldset disabled={busy || !!offer} className="mb-3 space-y-2 text-xs text-ink-2"><legend className="mb-2 font-medium text-ink">New pairing permissions</legend>
          <p className="text-ink-3">Inventory is always included. Existing controllers keep their current permissions.</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={grantVitals} onChange={(event) => setGrantVitals(event.target.checked)} />Share CPU, memory, GPU, storage, and network vitals</label>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={grantEngines} onChange={(event) => setGrantEngines(event.target.checked)} /><span>Allow starting, stopping, and restarting registered inference engines, including interrupting active work</span></label>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="flex-1 text-xs font-medium text-ink">Controllers that may ask
            <span className="ml-1 font-normal text-ink-3">{controllers.length}</span></h4>
          <button type="button" className={button} disabled={busy || !status.running}
            onClick={() => void act(async () => {
              setCopied(false);
              setOffer(await window.electronAPI.nodeAgent.createPairingOffer(['inventory', ...(grantVitals ? ['vitals' as const] : []), ...(grantEngines ? ['manage-engines' as const] : [])]));
            })}><Plus size={11} />Pairing code</button>
        </div>

        {offer && <div className="mt-2 rounded-md border border-accent/40 bg-surface-3 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex-1 text-[11px] text-ink-2">
              Copy this code and paste it into <em>Boxes this computer uses</em> on the other machine.
              It works once, and expires in {Math.floor(expiresIn / 60)}:{String(expiresIn % 60).padStart(2, '0')}.
            </p>
            <button type="button" className={button} disabled={busy}
              onClick={() => void act(async () => {
                setCopied(await window.electronAPI.nodeAgent.copyPairingCode(offer.id));
              })}><Copy size={11} />{copied ? 'Copied' : 'Copy code'}</button>
            <button type="button" className={button} onClick={() => setOffer(null)}><X size={11} />Close</button>
          </div>
        </div>}

        {controllers.length === 0
          ? <p className="mt-2 text-[11px] text-ink-3">No other machine can ask this one anything.</p>
          : <ul className="mt-2 divide-y divide-line">
            {controllers.map((controller) => <li key={controller.id} className="flex items-center gap-2 py-2">
              <ShieldCheck size={13} className="shrink-0 text-success" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-ink">{controller.name}</p>
                <p className="text-[10px] text-ink-3">
                  {controller.scopes.join(', ')} · last asked {ago(controller.lastSeenAt)}
                </p>
              </div>
              <button type="button" className={button} disabled={busy}
                onClick={() => void act(async () => { setStatus(await window.electronAPI.nodeAgent.revokeController(controller.id)); })}>
                <Trash2 size={11} />Revoke
              </button>
            </li>)}
          </ul>}
      </div>
    </div>

    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md border border-line bg-surface-3 p-2 text-primary"><HardDrive size={16} /></div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-ink">Boxes this computer uses</h3>
          <p className="mt-1 text-xs leading-5 text-ink-2">
            Paste a pairing code from another machine. Once paired, a workload's Distribution
            section shows that box's real free memory instead of only whether a port answers.
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <input className={`${field} min-w-56 flex-1`} value={code} disabled={busy} spellCheck={false}
          aria-label="Pairing code from another box" placeholder="ANTIMATTER-NODE-V1?…"
          onChange={(event) => setCode(event.target.value)} />
        <button type="button" className={button} disabled={busy || !code.trim()}
          onClick={() => void act(async () => {
            await window.electronAPI.nodeAgent.pair(code.trim());
            setCode('');
            await refresh();
          })}>{busy ? <LoaderCircle size={11} className="animate-spin" /> : <Plus size={11} />}Pair box</button>
      </div>

      {paired.length === 0
        ? <p className="mt-3 text-[11px] text-ink-3">No paired boxes. Recipe peers still appear in a workload's Distribution section; they just cannot report capacity.</p>
        : <ul className="mt-3 divide-y divide-line">
          {paired.map((box) => <li key={box.key} className="flex items-center gap-2 py-2">
            <Server size={13} className="shrink-0 text-ink-3" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-ink">{box.name}</p>
              <p className="truncate text-[10px] text-ink-3">{box.key} · answered {ago(box.lastSeenAt)}</p><p className="text-[10px] text-ink-3">{(box.scopes ?? ['inventory']).join(', ')}</p>
              {box.lastError && <p className="mt-0.5 text-[10px] text-danger">{box.lastError}</p>}
            </div>
            <button type="button" className={button} disabled={busy}
              onClick={() => void act(async () => { setPaired(await window.electronAPI.nodeAgent.forget(box.key)); })}>
              <Trash2 size={11} />Forget
            </button>
          </li>)}
        </ul>}
    </div>

    {message && <p role="alert" className="text-[11px] text-danger">{message}</p>}
    <p className="text-[10px] leading-relaxed text-ink-3">
      Connections are TLS with a pinned certificate carried in the pairing code, so a box whose
      certificate changes is refused rather than re-trusted quietly. Bearers are stored by the
      operating-system keyring and never reach this window.
    </p>
  </div>;
}
