import { useState } from 'react';
import { Cpu, HardDrive, MemoryStick, Microchip, Network, Thermometer, TriangleAlert } from 'lucide-react';
import type { TemperatureReading, VitalsSnapshot } from '../../types';
import { Meter, Sparkline, TONE_TEXT, type Tone } from './marks';
import { bytes, bytesPair, celsius, duration, percent, rate } from './format';
import { useVitals } from './history';

/**
 * A health readout for the machine Antimatter is running on.
 *
 * Every number here is a magnitude, so almost none of it is a chart: a figure with a meter under
 * it answers "how full" faster than any plot, and the plots are kept for the one question a
 * figure cannot answer — what it was doing a minute ago. Colour carries one meaning only, that
 * something has crossed a threshold the hardware itself published, and the figure beside it says
 * so too.
 */

/** Above this a share reads as pressure rather than use. Utilisation has no vendor threshold. */
const CRITICAL_SHARE = 0.9;

const toneFor = (fraction: number): Tone => (fraction >= CRITICAL_SHARE ? 'critical' : 'normal');

const temperatureTone = (reading: TemperatureReading): Tone =>
  reading.critical !== null && reading.celsius >= reading.critical * 0.92 ? 'critical' : 'normal';

/** CPU, GPU and drive first: the sensors anyone opens this panel to look at. */
const SENSOR_ORDER: TemperatureReading['source'][] = ['cpu', 'gpu', 'drive', 'battery', 'wireless', 'board', 'other'];

const rankSensors = (readings: TemperatureReading[]): TemperatureReading[] =>
  [...readings].sort(
    (a, b) => SENSOR_ORDER.indexOf(a.source) - SENSOR_ORDER.indexOf(b.source) || b.celsius - a.celsius
  );

const card = 'min-w-0 rounded-lg border border-line bg-surface-3/40 p-2.5';
const caption = 'text-[10px] font-medium uppercase tracking-wide text-ink-3';

interface TileProps {
  icon: typeof Cpu;
  label: string;
  value: string;
  detail?: string;
  fraction: number;
  tone?: Tone;
  secondary?: number;
  children?: React.ReactNode;
}

/** The headline figure, its meter, and whatever plot belongs under it. */
function Tile({ icon: Icon, label, value, detail, fraction, tone = 'normal', secondary, children }: TileProps) {
  return (
    <section className={card}>
      <div className="flex items-baseline gap-1.5">
        <Icon size={12} className="shrink-0 self-center text-ink-3" />
        <span className={`${caption} min-w-0 truncate`}>{label}</span>
        <span className={`ml-auto shrink-0 font-mono text-sm font-semibold tabular-nums ${TONE_TEXT[tone]}`}>{value}</span>
      </div>
      {detail && <p className="mt-0.5 truncate text-[10px] text-ink-3">{detail}</p>}
      <div className="mt-1.5">
        <Meter value={fraction} tone={tone} secondary={secondary} />
      </div>
      {children}
    </section>
  );
}

/** A two-series plot needs a legend; identity is never left to colour alone. */
function Legend({ entries }: { entries: { color: string; label: string; value: string }[] }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
      {entries.map((entry) => (
        <span key={entry.label} className="flex items-center gap-1 text-[10px] text-ink-3">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: entry.color }} />
          {entry.label}
          <span className="font-mono tabular-nums text-ink-2">{entry.value}</span>
        </span>
      ))}
    </div>
  );
}

function CoreGrid({ perCore }: { perCore: number[] }) {
  if (perCore.length < 2) return null;
  return (
    <div className="mt-2">
      <p className={`${caption} mb-1`}>{perCore.length} threads</p>
      {/* One bar per thread: small multiples, not a stacked bar — these do not sum to anything. */}
      <div className="flex h-8 items-end gap-[2px]">
        {perCore.map((usage, index) => (
          <div
            key={index}
            title={`Thread ${index}: ${percent(usage)}`}
            className="min-w-0 flex-1 rounded-t-[2px] bg-surface-0"
            style={{ height: '100%' }}
          >
            <div
              className="w-full rounded-t-[2px] transition-[height] duration-500"
              style={{
                height: `${Math.max(3, usage * 100)}%`,
                marginTop: `${100 - Math.max(3, usage * 100)}%`,
                background: usage >= CRITICAL_SHARE ? 'rgb(var(--color-danger))' : 'rgb(var(--color-accent))',
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function Temperatures({ readings }: { readings: TemperatureReading[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!readings.length) return null;

  const ranked = rankSensors(readings);
  const shown = expanded ? ranked : ranked.slice(0, 4);

  return (
    <section className={card}>
      <div className="flex items-center gap-1.5">
        <Thermometer size={12} className="shrink-0 text-ink-3" />
        <span className={`${caption} min-w-0 truncate`}>Temperatures</span>
        {ranked.length > 4 && (
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="ml-auto shrink-0 text-[10px] text-ink-3 underline transition hover:text-ink"
          >
            {expanded ? 'fewer' : `all ${ranked.length}`}
          </button>
        )}
      </div>
      <div className="mt-1.5 grid gap-1">
        {shown.map((reading) => {
          const tone = temperatureTone(reading);
          return (
            <div key={reading.label} className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink-2" title={reading.label}>
                {reading.label}
              </span>
              {tone === 'critical' && <TriangleAlert size={10} className="shrink-0 text-danger" />}
              <span className={`font-mono text-[11px] tabular-nums ${TONE_TEXT[tone]}`}>{celsius(reading.celsius)}</span>
              <span className="w-10 shrink-0 text-right font-mono text-[10px] text-ink-3">
                {reading.critical === null ? '—' : `/${celsius(reading.critical)}`}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Processes({ snapshot }: { snapshot: VitalsSnapshot }) {
  const [view, setView] = useState<'machine' | 'antimatter'>('machine');
  const rows =
    view === 'machine'
      ? snapshot.processes.map((entry) => ({ key: String(entry.pid), name: entry.name, cpu: entry.cpu, memory: entry.memory }))
      : snapshot.app
          .map((entry) => ({ key: String(entry.pid), name: entry.type, cpu: entry.cpu, memory: entry.memory }))
          .sort((a, b) => b.cpu - a.cpu || b.memory - a.memory);

  return (
    <section className={card}>
      <div className="flex items-center gap-1.5">
        <span className={`${caption} min-w-0 truncate`}>Busiest</span>
        <div className="ml-auto flex shrink-0 gap-1">
          {(['machine', 'antimatter'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setView(option)}
              className={`rounded px-1.5 py-0.5 text-[10px] capitalize transition ${
                view === option ? 'bg-primary/15 text-primary' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="mt-1.5 text-[10px] text-ink-3">Nothing measured yet.</p>
      ) : (
        <table className="mt-1.5 w-full">
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="max-w-0 truncate pr-2 text-[11px] text-ink-2" title={row.name}>
                  {row.name}
                </td>
                <td className="w-12 text-right font-mono text-[11px] tabular-nums text-ink">{percent(row.cpu, 1)}</td>
                <td className="w-14 text-right font-mono text-[10px] tabular-nums text-ink-3">{bytes(row.memory)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function VitalsPanel() {
  const { snapshot, history, error } = useVitals();
  const [hover, setHover] = useState<number | null>(null);

  if (error) {
    return (
      <p className="flex items-start gap-1.5 p-3 text-[11px] text-danger">
        <TriangleAlert size={12} className="mt-0.5 shrink-0" />
        {error}
      </p>
    );
  }

  if (!snapshot) return <p className="p-3 text-[11px] text-ink-3">Reading the machine…</p>;

  const at = (series: number[]) => (hover !== null && hover < series.length ? series[hover] : series[series.length - 1] ?? 0);
  const memoryShare = snapshot.memory.total ? snapshot.memory.used / snapshot.memory.total : 0;
  const swapShare = snapshot.memory.swapTotal ? snapshot.memory.swapUsed / snapshot.memory.swapTotal : 0;
  const gpu = snapshot.gpus[0] ?? null;
  const netTotal = Math.max(1, ...history.rx, ...history.tx);
  const diskTotal = Math.max(1, ...history.diskRead, ...history.diskWrite);

  return (
    <div className="grid min-w-0 gap-2 p-2.5">
      <Tile
        icon={Cpu}
        label="CPU"
        value={percent(at(history.cpu), 1)}
        detail={`${snapshot.cpu.model}${snapshot.cpu.load ? ` · load ${snapshot.cpu.load.map((entry) => entry.toFixed(2)).join(' ')}` : ''}`}
        fraction={snapshot.cpu.usage}
        tone={toneFor(snapshot.cpu.usage)}
      >
        <div className="mt-1.5">
          <Sparkline values={history.cpu} max={1} onHover={setHover} label="CPU usage over the last minute" />
        </div>
        <CoreGrid perCore={snapshot.cpu.perCore} />
      </Tile>

      <Tile
        icon={MemoryStick}
        label="Memory"
        value={bytesPair(snapshot.memory.used, snapshot.memory.total)}
        detail={
          snapshot.memory.swapTotal
            ? `${bytes(snapshot.memory.available)} available · swap ${bytes(snapshot.memory.swapUsed)} of ${bytes(snapshot.memory.swapTotal)}`
            : `${bytes(snapshot.memory.available)} available`
        }
        fraction={memoryShare}
        tone={toneFor(memoryShare)}
        secondary={swapShare}
      >
        <div className="mt-1.5">
          <Sparkline values={history.memory} max={1} onHover={setHover} label="Memory in use over the last minute" />
        </div>
      </Tile>

      {gpu && (
        <Tile
          icon={Microchip}
          label="GPU"
          value={gpu.usage === null ? '—' : percent(at(history.gpu), 1)}
          detail={[
            gpu.name,
            gpu.memoryTotal ? `${bytesPair(gpu.memoryUsed ?? 0, gpu.memoryTotal)} VRAM` : null,
            gpu.watts !== null ? `${gpu.watts.toFixed(1)} W` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          fraction={gpu.usage ?? 0}
          tone={toneFor(gpu.usage ?? 0)}
        >
          <div className="mt-1.5">
            <Sparkline values={history.gpu} max={1} onHover={setHover} label="GPU usage over the last minute" />
          </div>
        </Tile>
      )}

      <Temperatures readings={snapshot.temperatures} />

      {snapshot.network.length > 0 && (
        <section className={card}>
          <div className="flex items-center gap-1.5">
            <Network size={12} className="shrink-0 text-ink-3" />
            <span className={`${caption} shrink-0`}>Network</span>
            <span className="ml-auto min-w-0 truncate text-[10px] text-ink-3">
              {snapshot.network.slice(0, 2).map((entry) => entry.name).join(', ')}
            </span>
          </div>
          <div className="mt-1.5">
            <Sparkline values={history.rx} secondary={history.tx} max={netTotal} onHover={setHover} label="Network throughput over the last minute" />
          </div>
          <Legend
            entries={[
              { color: 'rgb(var(--color-accent))', label: 'in', value: rate(at(history.rx)) },
              { color: 'rgb(var(--color-accent-strong))', label: 'out', value: rate(at(history.tx)) },
            ]}
          />
        </section>
      )}

      {snapshot.mounts.map((mount) => {
        const share = mount.total ? mount.used / mount.total : 0;
        return (
          <Tile
            key={mount.mount}
            icon={HardDrive}
            label={mount.mount}
            value={bytesPair(mount.used, mount.total)}
            detail={`${bytes(mount.total - mount.used)} free on ${mount.device}`}
            fraction={share}
            tone={toneFor(share)}
          />
        );
      })}

      {snapshot.diskIo && (
        <section className={card}>
          <div className="flex items-center gap-1.5">
            <HardDrive size={12} className="shrink-0 text-ink-3" />
            <span className={`${caption} min-w-0 truncate`}>Disk activity</span>
          </div>
          <div className="mt-1.5">
            <Sparkline
              values={history.diskRead}
              secondary={history.diskWrite}
              max={diskTotal}
              onHover={setHover}
              label="Disk throughput over the last minute"
            />
          </div>
          <Legend
            entries={[
              { color: 'rgb(var(--color-accent))', label: 'read', value: rate(at(history.diskRead)) },
              { color: 'rgb(var(--color-accent-strong))', label: 'write', value: rate(at(history.diskWrite)) },
            ]}
          />
        </section>
      )}

      <Processes snapshot={snapshot} />

      <p className="px-0.5 text-[10px] leading-relaxed text-ink-3">
        {snapshot.host.name} · {snapshot.host.release} · up {duration(snapshot.host.uptimeSeconds)}
      </p>

      {snapshot.unavailable.map((reason) => (
        <p key={reason} className="flex items-start gap-1.5 px-0.5 text-[10px] text-ink-3">
          <TriangleAlert size={10} className="mt-0.5 shrink-0" />
          {reason}
        </p>
      ))}
    </div>
  );
}
