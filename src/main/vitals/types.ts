/**
 * What one reading of the machine looks like.
 *
 * Every field a platform cannot answer is null or empty rather than zero, and the reason lands
 * in `unavailable`. A monitor that shows a confident 0°C because it could not find a sensor is
 * worse than one that says it has no sensors.
 */

export interface CpuReading {
  model: string;
  cores: number;
  /** 0..1 across the whole package. */
  usage: number;
  /** 0..1 per logical core, in order. */
  perCore: number[];
  /** 1, 5 and 15 minute load, where the platform keeps it. */
  load: [number, number, number] | null;
  speedMhz: number | null;
}

export interface MemoryReading {
  total: number;
  /** Total minus what the kernel says is available, so cache does not read as pressure. */
  used: number;
  available: number;
  swapTotal: number;
  swapUsed: number;
}

export interface TemperatureReading {
  label: string;
  /** Which piece of hardware this belongs to, for ordering and grouping. */
  source: 'cpu' | 'gpu' | 'drive' | 'board' | 'wireless' | 'battery' | 'other';
  celsius: number;
  /** The sensor's own critical point, when it publishes one. Never a guess. */
  critical: number | null;
}

export interface MountReading {
  mount: string;
  device: string;
  total: number;
  used: number;
}

export interface RateReading {
  /** Bytes per second, averaged over the gap between the last two samples. */
  read: number;
  write: number;
}

export interface NetworkReading {
  name: string;
  rx: number;
  tx: number;
}

export interface GpuReading {
  name: string;
  /** 0..1, or null where the driver does not publish a busy percentage. */
  usage: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  celsius: number | null;
  watts: number | null;
}

export interface ProcessReading {
  pid: number;
  name: string;
  /** 0..1 of the whole machine, so the column sums to something meaningful. */
  cpu: number;
  memory: number;
}

export interface AppProcessReading {
  pid: number;
  type: string;
  cpu: number;
  memory: number;
}

export interface VitalsSnapshot {
  at: number;
  platform: NodeJS.Platform;
  host: { name: string; release: string; uptimeSeconds: number };
  cpu: CpuReading;
  memory: MemoryReading;
  temperatures: TemperatureReading[];
  mounts: MountReading[];
  diskIo: RateReading | null;
  network: NetworkReading[];
  gpus: GpuReading[];
  processes: ProcessReading[];
  /** Antimatter's own processes, from Electron's metrics. */
  app: AppProcessReading[];
  /** Human-readable reasons a section is missing, shown rather than swallowed. */
  unavailable: string[];
}
