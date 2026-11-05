import {
  cpuTimes,
  diskCounters,
  gpus,
  hasProc,
  host,
  isLinux,
  loadAverage,
  memory,
  mounts,
  networkCounters,
  processTimes,
  temperatures,
  topProcesses,
  toRates,
  type Counters,
  type CpuTimes,
  type ProcessTimes,
} from './sources';
import type {
  AppProcessReading,
  GpuReading,
  MountReading,
  ProcessReading,
  TemperatureReading,
  VitalsSnapshot,
} from './types';

/**
 * The sampler.
 *
 * Everything interesting here is a rate, and a rate needs two readings: this holds the previous
 * counters and turns the difference into per-second numbers. The renderer pulls rather than
 * subscribes, so closing the panel stops the work with nothing to unregister — and a snapshot
 * taken twice in quick succession is served from cache, so two panels polling at once cannot
 * divide a counter delta by a few milliseconds and invent a spike.
 */

const CACHE_MS = 250;
/** Filesystem usage and the process table move slowly; sampling them every tick is waste. */
const MOUNTS_MS = 10_000;
const PROCESS_MS = 2_000;
const GPU_MS = 2_000;
/**
 * Reading a thermal sensor goes through ACPI or SMBus and costs about half a millisecond each;
 * a full pass over this machine's fourteen sensors is ~12ms. Temperatures also do not move fast
 * enough to be worth that every second.
 */
const TEMPERATURE_MS = 2_000;
const TOP_PROCESSES = 8;

export type AppMetrics = () => AppProcessReading[];

interface Previous {
  at: number;
  cpu: CpuTimes[];
  network: Counters;
  disk: { read: number; write: number } | null;
}

export class Sampler {
  private previous: Previous | null = null;
  private cached: VitalsSnapshot | null = null;
  private mountsCache: { at: number; value: MountReading[] } = { at: 0, value: [] };
  private gpuCache: { at: number; value: GpuReading[] } = { at: 0, value: [] };
  private temperatureCache: { at: number; value: TemperatureReading[] } = { at: 0, value: [] };
  private processCache: ProcessReading[] = [];
  /** Kept apart from `previous` because the process table runs on its own, slower clock. */
  private processState: { at: number; times: ProcessTimes } = { at: 0, times: new Map() };
  private inFlight: Promise<VitalsSnapshot> | null = null;

  constructor(private readonly appMetrics?: AppMetrics) {}

  async sample(): Promise<VitalsSnapshot> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached;
    // Two callers arriving together share one reading rather than racing for the counters.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.read(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async read(now: number): Promise<VitalsSnapshot> {
    const unavailable: string[] = [];
    const { cores, model, speedMhz } = cpuTimes();
    const previous = this.previous;
    const seconds = previous ? (now - previous.at) / 1000 : 0;

    const perCore = cores.map((core, index) => {
      const before = previous?.cpu[index];
      if (!before) return 0;
      const total = core.total - before.total;
      // A core that reported no ticks between samples was idle, not busy.
      return total > 0 ? Math.min(1, Math.max(0, (core.busy - before.busy) / total)) : 0;
    });

    const network = networkCounters();
    const disk = diskCounters();

    if (!isLinux()) {
      unavailable.push('Temperatures, per-process CPU, disk and network rates need Linux.');
    } else if (!hasProc()) {
      unavailable.push('/proc is not mounted, so most counters are unreadable.');
    }

    if (now - this.mountsCache.at > MOUNTS_MS) {
      this.mountsCache = { at: now, value: await mounts().catch(() => []) };
    }
    if (now - this.gpuCache.at > GPU_MS) {
      this.gpuCache = { at: now, value: await gpus().catch(() => []) };
    }
    if (now - this.temperatureCache.at > TEMPERATURE_MS) {
      this.temperatureCache = { at: now, value: temperatures() };
    }

    const processes = this.sampleProcesses(now, cores.length);

    const snapshot: VitalsSnapshot = {
      at: now,
      platform: process.platform,
      host: host(),
      cpu: {
        model,
        cores: cores.length,
        usage: perCore.length ? perCore.reduce((total, value) => total + value, 0) / perCore.length : 0,
        perCore,
        load: loadAverage(),
        speedMhz,
      },
      memory: memory(),
      temperatures: this.temperatureCache.value,
      mounts: this.mountsCache.value,
      diskIo:
        previous?.disk && disk && seconds > 0
          ? {
              read: Math.max(0, (disk.read - previous.disk.read) / seconds),
              write: Math.max(0, (disk.write - previous.disk.write) / seconds),
            }
          : null,
      network: previous ? toRates(previous.network, network, seconds) : [],
      gpus: this.gpuCache.value,
      processes,
      app: this.appMetrics?.() ?? [],
      unavailable,
    };

    this.previous = { at: now, cpu: cores, network, disk };
    this.cached = snapshot;
    return snapshot;
  }

  /**
   * The process table on its own slower clock. A one-second window is too short to rank
   * processes stably anyway — everything that woke up once looks busy.
   */
  private sampleProcesses(now: number, cores: number): ProcessReading[] {
    const last = this.processState;
    if (now - last.at < PROCESS_MS) return this.processCache;

    const times = processTimes();
    // The first pass has nothing to diff against, so the table fills in on the pass after it.
    if (last.times.size) {
      this.processCache = topProcesses(last.times, times, (now - last.at) / 1000, cores, TOP_PROCESSES);
    }
    this.processState = { at: now, times };
    return this.processCache;
  }
}
