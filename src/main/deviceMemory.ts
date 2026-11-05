import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import type {
  DeviceMemoryCgroup,
  DeviceMemoryClient,
  DeviceMemoryDevice,
  DeviceMemoryReading,
} from '../api/deviceMemory';

/**
 * Reads the three unrelated places that together say where a checkpoint is resident.
 *
 * All of it is sysfs and procfs — in-memory files, no tool to install, nothing to spawn. The
 * same reasoning as vitals/sources.ts: cheap enough to poll while a panel is open, and it
 * degrades to "not supported" rather than to fabricated zeros.
 *
 * `root` exists so the tests can point the whole reader at a fixture tree instead of needing a
 * GPU. Nothing else should pass it.
 */
export interface DeviceMemoryOptions {
  root?: string;
  now?(): number;
  /** Guards against pathological /proc sizes; a developer overlay must not stall the main process. */
  maxProcesses?: number;
}

const PAGE_SIZE = 4096;
const DEFAULT_MAX_PROCESSES = 4096;

const readText = (path: string): string | null => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

const readNumber = (path: string): number | null => {
  const text = readText(path)?.trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

/** cgroup limits read `max` when unset, which is not a number and is not zero either. */
const readLimit = (path: string): number | null => {
  const text = readText(path)?.trim();
  if (!text || text === 'max') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

const listDir = (path: string): string[] => {
  try { return readdirSync(path); } catch { return []; }
};

/** `0::/user.slice/.../llama-mistral-small-4.service` → that path. Only the v2 unified line. */
export function cgroupPath(content: string): string | null {
  for (const line of content.split('\n')) {
    const parts = line.split(':');
    if (parts.length >= 3 && parts[0] === '0' && parts[1] === '' && parts[2].startsWith('/')) {
      return parts[2].trim();
    }
  }
  return null;
}

/** The unit a cgroup path ends in, ignoring the slices above it. */
export function unitFromCgroup(path: string | null): string | null {
  if (!path) return null;
  const last = path.split('/').filter(Boolean).pop();
  return last && last.endsWith('.service') ? last : null;
}

/**
 * amdgpu's fdinfo reports *client* totals, repeated identically on every fd that client holds.
 * Summing them would multiply one model by its file-descriptor count — which is exactly the bug
 * a naive reading produces, so group by the PCI device and take the maximum within each group,
 * then sum across distinct devices. A process with fds on two cards is counted once per card.
 */
export function totalsFromFdinfo(blocks: string[]): { vram: number | null; gtt: number | null } {
  /** Null is "not reported" and must survive a merge; a reported 0 must not be turned into null. */
  const merge = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : Math.max(a, b);
  const byDevice = new Map<string, { vram: number | null; gtt: number | null }>();
  for (const block of blocks) {
    let device = '';
    let vram: number | null = null;
    let gtt: number | null = null;
    for (const line of block.split('\n')) {
      const at = line.indexOf(':');
      if (at < 0) continue;
      const key = line.slice(0, at).trim();
      const raw = line.slice(at + 1).trim();
      if (key === 'drm-pdev') { device = raw; continue; }
      if (key !== 'drm-memory-vram' && key !== 'drm-memory-gtt') continue;
      // Values are `<number> KiB`; the unit is always KiB for amdgpu but is read rather than
      // assumed, because a block that ever says otherwise must not be silently scaled wrong.
      const [amount, unit] = raw.split(/\s+/);
      const value = Number(amount);
      if (!Number.isFinite(value)) continue;
      const bytes = unit === 'KiB' || unit === undefined ? value * 1024
        : unit === 'MiB' ? value * 1024 * 1024
        : unit === 'B' ? value
        : null;
      if (bytes === null) continue;
      if (key === 'drm-memory-vram') vram = bytes; else gtt = bytes;
    }
    if (vram === null && gtt === null) continue;
    const seen = byDevice.get(device);
    byDevice.set(device, {
      vram: merge(seen?.vram ?? null, vram),
      gtt: merge(seen?.gtt ?? null, gtt),
    });
  }
  let vram: number | null = null;
  let gtt: number | null = null;
  for (const entry of byDevice.values()) {
    if (entry.vram !== null) vram = (vram ?? 0) + entry.vram;
    if (entry.gtt !== null) gtt = (gtt ?? 0) + entry.gtt;
  }
  return { vram, gtt };
}

function devices(root: string): DeviceMemoryDevice[] {
  const readings: DeviceMemoryDevice[] = [];
  for (const card of listDir(join(root, 'sys/class/drm'))) {
    if (!/^card\d+$/.test(card)) continue;
    const device = join(root, 'sys/class/drm', card, 'device');
    const vramTotal = readNumber(join(device, 'mem_info_vram_total'));
    const gttTotal = readNumber(join(device, 'mem_info_gtt_total'));
    // A DRM node with no memory counters is a display-only or render-only node, not a card
    // worth a row. Omitting it beats a row of dashes.
    if (vramTotal === null && gttTotal === null) continue;
    readings.push({
      card,
      // Same ladder the Vitals panel walks: integrated parts publish no product_name, so fall
      // back to the driver rather than showing a card with no name at all.
      name: readText(join(device, 'product_name'))?.trim()
        || readText(join(device, 'label'))?.trim()
        || /DRIVER=(\S+)/.exec(readText(join(device, 'uevent')) ?? '')?.[1]
        || null,
      vramUsed: readNumber(join(device, 'mem_info_vram_used')),
      vramTotal,
      gttUsed: readNumber(join(device, 'mem_info_gtt_used')),
      gttTotal,
    });
  }
  return readings;
}

/**
 * Only processes that actually hold a DRM fd are inspected, found by reading the fd symlinks
 * rather than every fdinfo file. On this box that is a handful out of several hundred processes.
 */
function clients(root: string, maxProcesses: number): DeviceMemoryClient[] {
  const procRoot = join(root, 'proc');
  const found: DeviceMemoryClient[] = [];
  let examined = 0;
  for (const entry of listDir(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    if (++examined > maxProcesses) break;
    const pid = Number(entry);
    const fdDir = join(procRoot, entry, 'fd');
    const blocks: string[] = [];
    for (const fd of listDir(fdDir)) {
      let target: string;
      try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
      if (!target.startsWith('/dev/dri/')) continue;
      const block = readText(join(procRoot, entry, 'fdinfo', fd));
      if (block) blocks.push(block);
    }
    if (!blocks.length) continue;
    const totals = totalsFromFdinfo(blocks);
    if (totals.vram === null && totals.gtt === null) continue;
    found.push({
      pid,
      name: readText(join(procRoot, entry, 'comm'))?.trim() || String(pid),
      unit: unitFromCgroup(cgroupPath(readText(join(procRoot, entry, 'cgroup')) ?? '')),
      vram: totals.vram,
      gtt: totals.gtt,
    });
  }
  // Biggest holder first: the question being asked is always "what is using the carveout".
  return found.sort((a, b) => ((b.vram ?? 0) + (b.gtt ?? 0)) - ((a.vram ?? 0) + (a.gtt ?? 0)));
}

/** `low 0\nhigh 7\nmax 0\n…` → the counters that matter. */
export function parseMemoryEvents(content: string): Pick<DeviceMemoryCgroup, 'highEvents' | 'maxEvents' | 'oomKills'> {
  const values = new Map<string, number>();
  for (const line of content.split('\n')) {
    const [key, raw] = line.trim().split(/\s+/);
    const value = Number(raw);
    if (key && Number.isFinite(value)) values.set(key, value);
  }
  return {
    highEvents: values.get('high') ?? null,
    maxEvents: values.get('max') ?? null,
    oomKills: values.get('oom_kill') ?? null,
  };
}

/**
 * The cgroups of the units named, resolved through the pids already found holding GPU memory.
 * A unit that is not running has no cgroup and is simply absent, which is the honest answer:
 * there is no pressure on a server that is not loaded.
 */
function cgroups(root: string, units: string[], found: DeviceMemoryClient[]): DeviceMemoryCgroup[] {
  const wanted = new Set(units);
  const paths = new Map<string, string>();
  for (const client of found) {
    if (!client.unit || !wanted.has(client.unit) || paths.has(client.unit)) continue;
    const path = cgroupPath(readText(join(root, 'proc', String(client.pid), 'cgroup')) ?? '');
    if (path) paths.set(client.unit, path);
  }
  const readings: DeviceMemoryCgroup[] = [];
  for (const [unit, path] of paths) {
    const dir = join(root, 'sys/fs/cgroup', path);
    readings.push({
      unit,
      current: readNumber(join(dir, 'memory.current')),
      peak: readNumber(join(dir, 'memory.peak')),
      high: readLimit(join(dir, 'memory.high')),
      max: readLimit(join(dir, 'memory.max')),
      ...parseMemoryEvents(readText(join(dir, 'memory.events')) ?? ''),
    });
  }
  return readings;
}

/**
 * One reading. `units` names the serving units whose cgroup pressure is worth reporting —
 * normally the engines the lifecycle has started, since those are the ones a slow answer would
 * be blamed on.
 */
export function readDeviceMemory(units: string[] = [], options: DeviceMemoryOptions = {}): DeviceMemoryReading {
  const root = options.root ?? '/';
  const now = options.now ?? Date.now;
  const supported = options.root !== undefined || platform() === 'linux';
  if (!supported) {
    return { supported: false, devices: [], gttLimit: null, clients: [], cgroups: [], sampledAt: now() };
  }
  const found = clients(root, options.maxProcesses ?? DEFAULT_MAX_PROCESSES);
  const pages = readNumber(join(root, 'sys/module/ttm/parameters/pages_limit'));
  return {
    supported: true,
    devices: devices(root),
    gttLimit: pages === null ? null : pages * PAGE_SIZE,
    clients: found,
    cgroups: cgroups(root, units, found),
    sampledAt: now(),
  };
}
