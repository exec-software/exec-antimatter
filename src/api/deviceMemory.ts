/**
 * Where a loaded checkpoint actually sits, and what is squeezing it.
 *
 * On a unified-memory box the interesting question is not "how much VRAM is free" but "how much
 * of this model is in VRAM, how much spilled to GTT, and what is the ceiling on the spill". Those
 * three numbers live in three unrelated places — the amdgpu card, the TTM module parameters, and
 * the serving unit's cgroup — and reading them meant three shell commands. This is that reading
 * as one value.
 *
 * Every field is nullable and null always means *not published*, never zero. A box with no
 * amdgpu card, or a non-Linux one, reports empty lists rather than inventing figures.
 */

/** One accelerator's own memory counters, in bytes. */
export interface DeviceMemoryDevice {
  /** `card1`, so a two-card box stays legible. */
  card: string;
  name: string | null;
  vramUsed: number | null;
  vramTotal: number | null;
  /**
   * GTT is system memory the GPU may address. On a UMA part it is the same physical DRAM as the
   * VRAM carveout, so a spill into it is not a disaster — but it is capped far lower, and the cap
   * is the one people trip over.
   */
  gttUsed: number | null;
  gttTotal: number | null;
}

/** A process holding accelerator memory, as the DRM driver attributes it. */
export interface DeviceMemoryClient {
  pid: number;
  /** `/proc/<pid>/comm`. */
  name: string;
  /** The systemd unit from the process's cgroup, where it is in one. */
  unit: string | null;
  vram: number | null;
  gtt: number | null;
}

/**
 * The memory cgroup a serving unit runs in. `high` throttles, `max` kills, and `highEvents`
 * counting up while a model serves is the signature of a unit being reclaimed to death: the
 * weights the GPU needs through GTT must stay resident and the cgroup will not let them.
 */
export interface DeviceMemoryCgroup {
  unit: string;
  current: number | null;
  peak: number | null;
  /** Null means `max`, i.e. no limit set. */
  high: number | null;
  max: number | null;
  /** Times the kernel throttled this cgroup for exceeding `high`. */
  highEvents: number | null;
  /** Times an allocation was refused at `max`. */
  maxEvents: number | null;
  oomKills: number | null;
}

export interface DeviceMemoryReading {
  /** Null on a platform this cannot read, which the overlay says out loud. */
  supported: boolean;
  devices: DeviceMemoryDevice[];
  /**
   * The TTM ceiling on GTT across all of them, which defaults to half of system RAM and is not
   * visible from any GPU tool.
   */
  gttLimit: number | null;
  clients: DeviceMemoryClient[];
  cgroups: DeviceMemoryCgroup[];
  sampledAt: number;
}

export interface DeviceMemoryAPI {
  sample(): Promise<DeviceMemoryReading>;
}

/**
 * How much of what this client holds is in the slower pool. Null unless both halves are known,
 * because a share computed from a missing number is worse than no share at all.
 */
export function gttShare(client: Pick<DeviceMemoryClient, 'vram' | 'gtt'>): number | null {
  if (client.vram === null || client.gtt === null) return null;
  const total = client.vram + client.gtt;
  return total > 0 ? client.gtt / total : 0;
}

/** True when a cgroup is at or over the limit that throttles it rather than the one that kills. */
export function throttling(cgroup: DeviceMemoryCgroup): boolean {
  return cgroup.highEvents !== null && cgroup.highEvents > 0;
}
