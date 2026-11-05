import { useEffect, useState } from 'react';
import { Activity, Copy, MemoryStick, TriangleAlert, X } from 'lucide-react';
import type { InferenceMetricsEvent } from '../../lib/inferenceMetrics';
import type { DeviceMemoryReading } from '../../types';
import { gttShare, throttling } from '../../../../src/api/deviceMemory';
import { bytes, bytesPair, percent } from '../../plugins/vitals/format';
import { InferencePromptStatus } from '../status/InferencePromptStatus';

interface Props {
  events: InferenceMetricsEvent[];
  active: boolean;
  sourceName?: string;
  onClose(): void;
}

const count = (value?: number): string => value === undefined ? '—' : value.toLocaleString();
const duration = (value?: number): string => value === undefined ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const rate = (value?: number): string => value === undefined ? '—' : `${value.toFixed(1)} tok/s`;

const share = (value: number | null): string => value === null ? '—' : percent(value);

/**
 * Where the loaded checkpoint is resident, and what is squeezing it.
 *
 * This exists because "the model is slow" has three possible causes that look identical from the
 * chat: it spilled out of VRAM into GTT, the GTT pool itself is capped lower than anyone expects,
 * or the serving unit's cgroup is reclaiming the mmap'd weights the GPU still needs. Each lives
 * in a different file under /sys, and reading them by hand during a slow answer is both awkward
 * and too late. A throttled cgroup is called out rather than left as a number to interpret.
 */
function DeviceResidency({ reading }: { reading: DeviceMemoryReading }) {
  if (!reading.supported) {
    return <p className="mt-2 text-[10px] leading-4 text-ink-3">
      Device residency is read from Linux sysfs and is not available on this platform.
    </p>;
  }
  // Only the engines matter here. A browser or a compositor holding a few hundred megabytes is
  // noise against a checkpoint, and listing it would bury the row worth reading.
  const engines = reading.clients.filter((client) => client.unit !== null || client.name === 'llama-server');
  return <div className="mt-3 space-y-2 border-t border-line pt-3 text-[10px] leading-4">
    <div className="flex items-center gap-1.5 text-ink-2">
      <MemoryStick size={11} className="text-accent" />
      <span className="font-semibold">Device residency</span>
    </div>

    {reading.devices.map((device) => <div key={device.card} className="text-ink-3">
      <p className="truncate text-ink-2" title={device.name ?? device.card}>{device.name ?? device.card}</p>
      <dl className="mt-0.5 grid grid-cols-2 gap-x-3">
        <div><dt className="inline text-ink-3">VRAM </dt>
          <dd className="inline font-mono text-ink">{device.vramUsed !== null && device.vramTotal !== null ? bytesPair(device.vramUsed, device.vramTotal) : '—'}</dd></div>
        <div><dt className="inline text-ink-3">GTT </dt>
          <dd className="inline font-mono text-ink">{device.gttUsed !== null && device.gttTotal !== null ? bytesPair(device.gttUsed, device.gttTotal) : '—'}</dd></div>
      </dl>
    </div>)}

    {reading.gttLimit !== null && <p className="text-ink-3">
      GTT ceiling <span className="font-mono text-ink">{bytes(reading.gttLimit)}</span> — the TTM
      limit, which defaults to half of system RAM and is lower than any GPU tool reports.
    </p>}

    {engines.length > 0 && <div className="space-y-1">
      {engines.map((client) => <div key={client.pid} className="text-ink-3">
        <p className="truncate text-ink-2" title={client.unit ?? client.name}>{client.unit ?? `${client.name} · ${client.pid}`}</p>
        <p className="font-mono text-ink">
          {bytes(client.vram ?? 0)} VRAM · {bytes(client.gtt ?? 0)} GTT
          <span className="ml-1 font-sans text-ink-3">({share(gttShare(client))} spilled)</span>
        </p>
      </div>)}
    </div>}

    {reading.cgroups.map((cgroup) => {
      const squeezed = throttling(cgroup);
      return <div key={cgroup.unit} className={squeezed ? 'text-danger' : 'text-ink-3'}>
        <p className="flex items-start gap-1">
          {squeezed && <TriangleAlert size={10} className="mt-0.5 shrink-0" />}
          <span className="truncate" title={cgroup.unit}>{cgroup.unit}</span>
        </p>
        <p className="font-mono">
          {bytes(cgroup.current ?? 0)} of {cgroup.high === null ? 'unlimited' : bytes(cgroup.high)}
          {cgroup.max !== null && <> · max {bytes(cgroup.max)}</>}
        </p>
        {squeezed && <p>
          Throttled {cgroup.highEvents?.toLocaleString()}× at its memory limit. A capped cgroup
          reclaims the mmap&apos;d weights the GPU reads through GTT, which shows up only as
          everything being slow. Raise MemoryHigh on this unit.
        </p>}
        {cgroup.oomKills !== null && cgroup.oomKills > 0 &&
          <p className="text-danger">OOM-killed {cgroup.oomKills.toLocaleString()}× in this cgroup.</p>}
      </div>;
    })}

    {!reading.devices.length && !engines.length &&
      <p className="text-ink-3">No accelerator is reporting memory, and no engine is holding any.</p>}
  </div>;
}

/** Server counters are shown only when reported; browser latency never stands in for prefill. */
export function InferenceDebugOverlay({ events, active, sourceName, onClose }: Props) {
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const runId = events[0]?.id;
  useEffect(() => { setSelectedRound(null); setCopied(false); }, [runId]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [active]);
  /**
   * Residency is polled only while this overlay is mounted, which is the whole reason it polls
   * rather than subscribes: a closed overlay asks for nothing and leaves nothing to unregister.
   * Faster while a request is in flight, because that is when a spill or a throttle is visible.
   */
  const [memory, setMemory] = useState<DeviceMemoryReading | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = () => void window.electronAPI.deviceMemory.sample()
      .then((reading) => { if (!cancelled) setMemory(reading); })
      // A reading that cannot be taken keeps the last one rather than blanking the section:
      // residency is diagnostic, and a gap in it must not look like a measurement of zero.
      .catch(() => undefined);
    poll();
    const timer = window.setInterval(poll, active ? 1_000 : 2_500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active]);
  const event = events.find((entry) => entry.round === selectedRound) ?? events[events.length - 1];
  const metrics = event?.metrics;
  const elapsed = metrics ? (active && metrics.phase !== 'complete'
    ? Math.max(metrics.requestDurationMs, now - metrics.requestStartedAt) : metrics.requestDurationMs) : undefined;
  const rows = [
    ['Observed TTFT', duration(metrics?.firstTokenMs)],
    ['Request time', duration(elapsed)],
    ['Prefill time', duration(metrics?.promptMs)],
    ['Prefill speed', rate(metrics?.promptTokensPerSecond)],
    ['Decode time', duration(metrics?.decodeMs)],
    ['Decode speed', rate(metrics?.decodeTokensPerSecond)],
    ['Input tokens', count(metrics?.promptTokens)],
    ['Prefill tokens', count(metrics?.prefillTokens)],
    ['Output tokens', count(metrics?.completionTokens)],
    ['Reused prompt tokens', count(metrics?.cachedPromptTokens)],
    ['Reasoning tokens', count(metrics?.reasoningTokens)],
  ];
  return <aside aria-label="Inference debug overlay" className="absolute bottom-4 right-4 z-40 max-h-[70%] w-[340px] max-w-[calc(100%-2rem)] overflow-y-auto rounded-xl border border-line bg-surface-2 p-3 shadow-2xl">
    <header className="flex items-center gap-2">
      <Activity size={14} className="text-accent" />
      <h2 className="flex-1 text-xs font-semibold text-ink">Inference debug</h2>
      <button type="button" disabled={!events.length} aria-label="Copy inference diagnostics" title="Copy timings as JSON" className="rounded p-1 text-ink-3 hover:text-ink disabled:opacity-40" onClick={() => {
        setCopyError('');
        // Residency rides along: a slow timing and the spill that caused it are one report.
        void navigator.clipboard.writeText(JSON.stringify({ events, deviceMemory: memory }, null, 2)).then(() => setCopied(true))
          .catch(() => setCopyError('Could not copy diagnostics.'));
      }}><Copy size={13} /></button>
      <button type="button" onClick={onClose} aria-label="Close inference debug overlay" className="rounded p-1 text-ink-3 hover:text-ink"><X size={14} /></button>
    </header>
    {event ? <>
      <p className="mt-2 truncate text-[11px] text-ink-2" title={`${sourceName ?? event.providerId} / ${event.model}`}>{sourceName ?? event.providerId} · {event.model}</p>
      <div className="mt-2 flex items-center gap-2 text-[10px] text-ink-3">
        <label className="flex flex-1 items-center gap-2">Request
          <select aria-label="Inference request" className="min-w-0 rounded border border-line bg-surface px-1 py-0.5 text-ink" value={selectedRound ?? 'latest'} onChange={(e) => setSelectedRound(e.target.value === 'latest' ? null : Number(e.target.value))}>
            <option value="latest">Latest ({events[events.length - 1].round})</option>
            {events.map((entry) => <option key={entry.round} value={entry.round}>{entry.round}</option>)}
          </select>
        </label>
        <span>{metrics?.phase === 'complete' ? 'Complete' : active ? metrics?.phase === 'started' ? 'Waiting' : metrics?.phase === 'prefill' ? 'Processing prompt' : 'Streaming' : 'Interrupted'}</span>
      </div>
      <InferencePromptStatus metrics={metrics} active={active && event === events[events.length - 1]} />
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-y border-line py-3 text-[11px] tabular-nums">
        {rows.map(([label, value]) => <div key={label}><dt className="text-ink-3">{label}</dt><dd className="mt-0.5 font-mono text-ink">{value}</dd></div>)}
      </dl>
      <p className="mt-2 text-[10px] leading-4 text-ink-3">TTFT measures the first received {metrics?.firstTokenKind ?? 'text, reasoning, or tool'} fragment. Prefill, decode, and token counts come from the server; — means unreported. Each tool-loop request is measured separately.</p>
      {memory && <DeviceResidency reading={memory} />}
    </> : <>
      <p className="mt-3 text-xs leading-5 text-ink-3">Send a message to see inference timings for this conversation.</p>
      {/* Residency does not need a request to be meaningful: a checkpoint is resident, or
          spilled, or being reclaimed, whether or not anything is asking it a question. */}
      {memory && <DeviceResidency reading={memory} />}
    </>}
    {(copied || copyError) && <p role="status" className={`mt-2 text-[10px] ${copyError ? 'text-danger' : 'text-accent'}`}>{copyError || 'Diagnostics copied.'}</p>}
  </aside>;
}
