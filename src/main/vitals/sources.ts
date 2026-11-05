import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statfs } from 'node:fs';
import { cpus, freemem, loadavg, platform, release, totalmem, uptime, hostname } from 'node:os';
import { join } from 'node:path';
import type {
  GpuReading,
  MountReading,
  NetworkReading,
  ProcessReading,
  TemperatureReading,
} from './types';

/**
 * Where the numbers come from.
 *
 * Linux keeps all of this in procfs and sysfs, which are in-memory files: reading them is cheap
 * enough to do once a second and simple enough to need no dependency. Everything here degrades
 * to what `node:os` can answer, so the panel still works on a Mac — with less in it, and saying
 * so, rather than inventing figures.
 */

const LINUX = platform() === 'linux';
/** Kernel jiffies per second. 100 on every Linux kernel anyone runs. */
const HZ = 100;

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const readNumber = (path: string): number | null => {
  const text = readText(path)?.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

const listDir = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

export interface CpuTimes {
  busy: number;
  total: number;
}

/**
 * Per-core cumulative busy/total, from `os.cpus()` so it works everywhere. Usage is the delta
 * between two of these, never the absolute value — which is uptime, not load.
 */
export function cpuTimes(): { cores: CpuTimes[]; model: string; speedMhz: number | null } {
  const cores = cpus();
  return {
    model: cores[0]?.model?.trim() ?? 'Unknown CPU',
    speedMhz: cores[0]?.speed || null,
    cores: cores.map(({ times }) => {
      const total = times.user + times.nice + times.sys + times.idle + times.irq;
      return { busy: total - times.idle, total };
    }),
  };
}

export const loadAverage = (): [number, number, number] | null => {
  const [one, five, fifteen] = loadavg();
  // Windows has no load average and reports zeroes; treat that as "not available".
  return one || five || fifteen ? [one, five, fifteen] : null;
};

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * MemAvailable is the number that matters: free memory alone counts the page cache as used and
 * makes a healthy machine look full. Where it is missing, fall back to free and say nothing more.
 */
export function memory() {
  const meminfo = LINUX ? readText('/proc/meminfo') : null;
  if (!meminfo) {
    const total = totalmem();
    const free = freemem();
    return { total, available: free, used: total - free, swapTotal: 0, swapUsed: 0 };
  }

  const fields = new Map<string, number>();
  for (const line of meminfo.split('\n')) {
    const [key, value] = line.split(':');
    if (key && value) fields.set(key.trim(), Number.parseInt(value.trim(), 10) * 1024);
  }

  const total = fields.get('MemTotal') ?? totalmem();
  const available = fields.get('MemAvailable') ?? fields.get('MemFree') ?? freemem();
  const swapTotal = fields.get('SwapTotal') ?? 0;
  return {
    total,
    available,
    used: Math.max(0, total - available),
    swapTotal,
    swapUsed: Math.max(0, swapTotal - (fields.get('SwapFree') ?? swapTotal)),
  };
}

// ---------------------------------------------------------------------------
// Temperatures
// ---------------------------------------------------------------------------

/** hwmon driver names, mapped to the thing they are actually measuring. */
const SENSOR_KIND: [RegExp, TemperatureReading['source']][] = [
  [/^(k10temp|coretemp|zenpower|cpu_thermal)/, 'cpu'],
  [/^(amdgpu|nouveau|radeon|nvidia)/, 'gpu'],
  [/^(nvme|drivetemp)/, 'drive'],
  [/^(iwlwifi|mt79|ath1)/, 'wireless'],
  [/^(BAT|bat)/, 'battery'],
  [/^(acpitz|pch|soc)/, 'board'],
];

const sensorKind = (driver: string): TemperatureReading['source'] =>
  SENSOR_KIND.find(([pattern]) => pattern.test(driver))?.[1] ?? 'other';

/**
 * Above this, a "critical" threshold is a sentinel rather than a temperature. NVMe drives
 * publish temp*_max as 65261.85°C to mean "no limit set", and taking that at face value would
 * paint every drive as comfortably cool forever.
 */
const PLAUSIBLE_CRITICAL = 200;

interface Sensor {
  path: string;
  label: string;
  source: TemperatureReading['source'];
  critical: number | null;
}

/** Discovering which files exist costs far more than reading them, so it is done rarely. */
let sensors: { at: number; value: Sensor[] } = { at: 0, value: [] };
const SENSOR_RESCAN_MS = 60_000;

function findSensors(): Sensor[] {
  const found: Sensor[] = [];
  for (const entry of listDir('/sys/class/hwmon')) {
    const dir = join('/sys/class/hwmon', entry);
    const driver = readText(join(dir, 'name'))?.trim() ?? entry;

    for (const file of listDir(dir)) {
      const match = /^(temp\d+)_input$/.exec(file);
      if (!match) continue;
      if (readNumber(join(dir, file)) === null) continue;

      const label = readText(join(dir, `${match[1]}_label`))?.trim();
      // The sensor's own limit, never a rule of thumb: 85°C alarms a CPU and bores an NVMe.
      const limit = readNumber(join(dir, `${match[1]}_crit`)) ?? readNumber(join(dir, `${match[1]}_max`));
      const critical = limit === null ? null : limit / 1000;

      found.push({
        path: join(dir, file),
        label: label ? `${driver} ${label}` : driver,
        source: sensorKind(driver),
        critical: critical !== null && critical > 0 && critical < PLAUSIBLE_CRITICAL ? critical : null,
      });
    }
  }
  return found;
}

/** Every hwmon temperature the kernel exposes, read from a layout discovered once a minute. */
export function temperatures(): TemperatureReading[] {
  if (!LINUX) return [];

  const now = Date.now();
  if (now - sensors.at > SENSOR_RESCAN_MS) sensors = { at: now, value: findSensors() };

  const readings: TemperatureReading[] = [];
  for (const sensor of sensors.value) {
    const millidegrees = readNumber(sensor.path);
    if (millidegrees === null) continue;
    readings.push({
      label: sensor.label,
      source: sensor.source,
      celsius: millidegrees / 1000,
      critical: sensor.critical,
    });
  }
  return readings;
}

// ---------------------------------------------------------------------------
// Network and disk counters
// ---------------------------------------------------------------------------

export type Counters = Map<string, { rx: number; tx: number }>;

/** Cumulative bytes per interface. Loopback is skipped: it is the app talking to itself. */
export function networkCounters(): Counters {
  const counters: Counters = new Map();
  const contents = LINUX ? readText('/proc/net/dev') : null;
  if (!contents) return counters;

  for (const line of contents.split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!name || !rest) continue;
    const columns = rest.trim().split(/\s+/).map(Number);
    const interfaceName = name.trim();
    if (interfaceName === 'lo' || !Number.isFinite(columns[0])) continue;
    counters.set(interfaceName, { rx: columns[0], tx: columns[8] });
  }
  return counters;
}

/**
 * Cumulative bytes read and written across real block devices. Partitions and virtual devices
 * are skipped so a disk is not counted twice.
 */
export function diskCounters(): { read: number; write: number } | null {
  const contents = LINUX ? readText('/proc/diskstats') : null;
  if (!contents) return null;

  let read = 0;
  let write = 0;
  for (const line of contents.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 10) continue;

    const device = columns[2];
    // Whole devices only: sda but not sda1, nvme0n1 but not nvme0n1p1, nothing virtual.
    if (/^(loop|ram|dm-|zram|sr)/.test(device)) continue;
    if (/^(sd[a-z]+|hd[a-z]+|vd[a-z]+)\d+$/.test(device) || /^nvme\d+n\d+p\d+$/.test(device)) continue;

    read += Number(columns[5]) * 512;
    write += Number(columns[9]) * 512;
  }
  return { read, write };
}

export const toRates = (
  previous: Counters,
  current: Counters,
  seconds: number
): NetworkReading[] => {
  if (seconds <= 0) return [];
  const rates: NetworkReading[] = [];
  for (const [name, now] of current) {
    const before = previous.get(name);
    if (!before) continue;
    rates.push({
      name,
      // A counter that went backwards means the interface was reset; report nothing rather than
      // a spike of nonsense.
      rx: Math.max(0, (now.rx - before.rx) / seconds),
      tx: Math.max(0, (now.tx - before.tx) / seconds),
    });
  }
  return rates.sort((a, b) => b.rx + b.tx - (a.rx + a.tx));
};

// ---------------------------------------------------------------------------
// Filesystems
// ---------------------------------------------------------------------------

/** Pseudo filesystems tell you nothing about disk space, so they are not listed. */
const REAL_FS = /^(ext[234]|xfs|btrfs|f2fs|zfs|vfat|exfat|ntfs3?|apfs|hfs)$/;

export function mounts(): Promise<MountReading[]> {
  const contents = LINUX ? readText('/proc/mounts') : null;
  const wanted = contents
    ? contents
        .split('\n')
        .map((line) => line.split(/\s+/))
        .filter(([device, mount, type]) => device?.startsWith('/') && REAL_FS.test(type ?? ''))
        // /boot and /boot/efi are real filesystems that nobody is watching for free space.
        .filter(([, mount]) => !mount.startsWith('/boot'))
        .map(([device, mount]) => ({ device, mount: mount.replace(/\\040/g, ' ') }))
    : [{ device: '/', mount: '/' }];

  // One mount per device: a bind-mounted or subvolume-mounted disk is still one disk.
  const seen = new Set<string>();
  const unique = wanted.filter(({ device }) => !seen.has(device) && seen.add(device));

  return Promise.all(
    unique.map(
      ({ device, mount }) =>
        new Promise<MountReading | null>((resolve) => {
          statfs(mount, (error, stats) => {
            if (error || !stats) return resolve(null);
            const total = Number(stats.blocks) * Number(stats.bsize);
            const free = Number(stats.bavail) * Number(stats.bsize);
            resolve(total > 0 ? { mount, device, total, used: total - free } : null);
          });
        })
    )
  ).then((results) => results.filter((entry): entry is MountReading => entry !== null));
}

// ---------------------------------------------------------------------------
// GPUs
// ---------------------------------------------------------------------------

/** amdgpu publishes everything in sysfs, so no tool has to be installed for it to work. */
function amdGpus(): GpuReading[] {
  const readings: GpuReading[] = [];
  for (const card of listDir('/sys/class/drm')) {
    if (!/^card\d+$/.test(card)) continue;

    const device = join('/sys/class/drm', card, 'device');
    const busy = readNumber(join(device, 'gpu_busy_percent'));
    if (busy === null) continue;

    const hwmonRoot = join(device, 'hwmon');
    const hwmon = listDir(hwmonRoot)[0];
    const sensors = hwmon ? join(hwmonRoot, hwmon) : null;
    const microwatts = sensors ? readNumber(join(sensors, 'power1_average')) : null;

    const driver = /DRIVER=(\S+)/.exec(readText(join(device, 'uevent')) ?? '')?.[1];
    readings.push({
      name:
        readText(join(device, 'product_name'))?.trim() ||
        readText(join(device, 'label'))?.trim() ||
        (driver ? `${driver} ${card}` : `AMD ${card}`),
      usage: busy / 100,
      memoryUsed: readNumber(join(device, 'mem_info_vram_used')),
      memoryTotal: readNumber(join(device, 'mem_info_vram_total')),
      celsius: sensors ? (readNumber(join(sensors, 'temp1_input')) ?? 0) / 1000 || null : null,
      watts: microwatts === null ? null : microwatts / 1_000_000,
    });
  }
  return readings;
}

/**
 * NVIDIA keeps its counters behind nvidia-smi. Written from its documented CSV output and not
 * exercised here — this machine has an AMD card — so it fails quiet rather than loud.
 */
function nvidiaGpus(): Promise<GpuReading[]> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits'],
      { timeout: 2000 },
      (error, stdout) => {
        if (error || !stdout.trim()) return resolve([]);

        resolve(
          stdout
            .trim()
            .split('\n')
            .map((line) => {
              const [name, usage, used, total, celsius, watts] = line.split(',').map((cell) => cell.trim());
              const number = (value: string) => (Number.isFinite(Number(value)) ? Number(value) : null);
              return {
                name,
                usage: number(usage) === null ? null : number(usage)! / 100,
                memoryUsed: number(used) === null ? null : number(used)! * 1024 * 1024,
                memoryTotal: number(total) === null ? null : number(total)! * 1024 * 1024,
                celsius: number(celsius),
                watts: number(watts),
              };
            })
        );
      }
    );
  });
}

let nvidiaPresent: boolean | null = null;

export async function gpus(): Promise<GpuReading[]> {
  const amd = LINUX ? amdGpus() : [];
  if (nvidiaPresent === false) return amd;

  const nvidia = await nvidiaGpus();
  // Probe once: if nvidia-smi is not here, stop paying for a spawn every sample.
  if (nvidiaPresent === null) nvidiaPresent = nvidia.length > 0;
  return [...amd, ...nvidia];
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

export type ProcessTimes = Map<number, { jiffies: number; name: string; rss: number }>;

/**
 * One read of /proc/<pid>/stat per process. The command name is in parentheses and may itself
 * contain spaces and brackets, so the fields are taken relative to the last ')' rather than by
 * splitting the line.
 */
export function processTimes(): ProcessTimes {
  const times: ProcessTimes = new Map();
  if (!LINUX) return times;

  for (const entry of listDir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;

    const line = readText(`/proc/${entry}/stat`);
    if (!line) continue;

    const close = line.lastIndexOf(')');
    const open = line.indexOf('(');
    if (close === -1 || open === -1) continue;

    const fields = line.slice(close + 2).split(' ');
    // After the comm field, /proc(5) numbers these from 3: utime is 14, stime 15, rss 24.
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const rssPages = Number(fields[21]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) continue;

    times.set(Number(entry), {
      jiffies: utime + stime,
      name: line.slice(open + 1, close),
      rss: Number.isFinite(rssPages) ? rssPages * 4096 : 0,
    });
  }
  return times;
}

export function topProcesses(
  previous: ProcessTimes,
  current: ProcessTimes,
  seconds: number,
  cores: number,
  limit: number
): ProcessReading[] {
  if (seconds <= 0) return [];

  const readings: ProcessReading[] = [];
  for (const [pid, now] of current) {
    const before = previous.get(pid);
    // A process first seen this sample has no delta yet; it appears on the next one.
    if (!before) continue;
    readings.push({
      pid,
      name: now.name,
      cpu: Math.max(0, (now.jiffies - before.jiffies) / (seconds * HZ * cores)),
      memory: now.rss,
    });
  }

  return readings.sort((a, b) => b.cpu - a.cpu || b.memory - a.memory).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export const host = () => ({ name: hostname(), release: release(), uptimeSeconds: uptime() });

export const isLinux = () => LINUX;

export const hasProc = () => LINUX && existsSync('/proc/stat');
