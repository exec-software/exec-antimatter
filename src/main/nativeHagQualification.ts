import { createHash } from 'node:crypto';
import { closeSync, createReadStream, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { load } from 'js-yaml';
import { validateHagContainment, type HagContainment, type HagPrivateMemory } from './hagProcess';

type Record_ = Record<string, unknown>;
const record = (value: unknown): value is Record_ => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  const text = JSON.stringify(value);
  if (text === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid native HAG configuration value.');
  return text;
}

/** Excludes host-specific paths: the runtime pins checkpoint bytes and validates the actual device. */
export function nativeHagSettingsSha256(models: Record_[]): string {
  return digest(canonical([...models].sort((a, b) => String(a.id).localeCompare(String(b.id))).map((model) => {
    const { path: _path, hag, ...rest } = model;
    if (!record(hag)) throw new Error('Native HAG device settings are missing.');
    const { device: _device, ...settings } = hag;
    return { ...rest, hag: settings };
  })));
}

export interface NativeHagPlan {
  modelId: string;
  containment: HagContainment;
  privateMemory: HagPrivateMemory;
  expectedModels: Array<{ id: string; maxEvaluatedTokens?: number }>;
  binaryBytes: number;
  binarySha256: string;
}

/**
 * CPU-only catalogs preserve their existing launch path. A HAG catalog requires a shipped
 * qualification bound to its HAG settings and binary. Unrelated CPU Hub additions are excluded
 * from that pin, and every expected catalog id is read afresh for the cold-start handshake.
 */
export function nativeHagPlan(configText: string, manifest: unknown): NativeHagPlan | null {
  const config = load(configText);
  if (!record(config) || !Array.isArray(config.models)) return null;
  const models = config.models;
  const hagModels = models.filter((model): model is Record_ => record(model) && model.execution_backend === 'hag');
  if (!hagModels.length) return null;
  if (hagModels.length !== 1 || hagModels[0].id !== 'openmythos-27b-hag' || !record(hagModels[0].hag_qwen35)) {
    throw new Error('This native HAG package admits only the qualified OpenMythos profile.');
  }
  const model = hagModels[0];
  if (typeof model.path !== 'string' || !isAbsolute(model.path) || !record(model.hag) ||
      typeof model.hag.device !== 'string' || !/^\/dev\/dri\/renderD\d+$/.test(model.hag.device) ||
      !Number.isSafeInteger(model.memory_budget_bytes) || Number(model.memory_budget_bytes) <= 0 ||
      !Number.isSafeInteger(model.runtime_headroom_bytes) || Number(model.runtime_headroom_bytes) <= 0 ||
      !Number.isSafeInteger(model.hag.memory_budget_bytes) || Number(model.hag.memory_budget_bytes) <= 0 ||
      !Number.isSafeInteger(model.hag.context_capacity) || Number(model.hag.context_capacity) <= 0) {
    throw new Error('The native HAG profile requires explicit paths, capacity and memory budgets.');
  }
  const qualification = record(manifest) ? manifest.nativeHagQualification : null;
  if (!record(qualification) || qualification.schemaVersion !== 1 || !sha256(qualification.receiptSha256) ||
      qualification.hagSettingsSha256 !== nativeHagSettingsSha256(hagModels) || !record(qualification.containment)) {
    throw new Error('This HAG profile does not match the packaged native qualification. Keep the Vulkan profile or install a qualified native build.');
  }
  const containment = { ...qualification.containment } as unknown as HagContainment;
  validateHagContainment(containment);
  const forecastBytes = Number(qualification.forecastBytes);
  const sourceFileBytes = Number(qualification.sourceFileBytes);
  const deviceChargeBytes = Number(qualification.deviceChargeBytes);
  const GiB = 1024 ** 3;
  if (!Number.isSafeInteger(qualification.forecastBytes) || !Number.isSafeInteger(qualification.sourceFileBytes) ||
      !Number.isSafeInteger(qualification.deviceChargeBytes) || deviceChargeBytes <= 0 || deviceChargeBytes > Number(model.hag.memory_budget_bytes) ||
      sourceFileBytes !== 16_547_399_872 || forecastBytes <= sourceFileBytes || deviceChargeBytes > forecastBytes - sourceFileBytes || forecastBytes >= containment.memoryHighBytes ||
      Number(model.memory_budget_bytes) > containment.memoryMaxBytes || forecastBytes > Number(model.memory_budget_bytes)) {
    throw new Error('Native HAG needs a qualified full forecast below the early memory limit and within its process budget.');
  }
  const requiredAvailable = Math.max(forecastBytes, 8 * GiB + (forecastBytes - sourceFileBytes) + GiB);
  if (containment.startGpuTemperatureC === undefined || containment.activeGpuTemperatureC === undefined ||
      containment.activeAvailableBytes < 8 * GiB || containment.startAvailableBytes < requiredAvailable ||
      containment.startTemperatureC > 60 || containment.startGpuTemperatureC > 55 ||
      containment.activeTemperatureC > 85 || containment.activeGpuTemperatureC > 85) {
    throw new Error('Native HAG needs the qualified host reserve and CPU/GPU temperature safeguards.');
  }
  const artifacts = record(manifest) && Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const binaries = artifacts.filter((entry) => record(entry) && entry.path === 'bin/beholdd');
  if (binaries.length !== 1 || !record(binaries[0]) || !sha256(binaries[0].sha256) ||
      !Number.isSafeInteger(binaries[0].bytes) || Number(binaries[0].bytes) <= 0) {
    throw new Error('The native HAG binary has no exact packaged identity.');
  }
  const contextCapacity = Number(model.hag.context_capacity);
  const ids = new Set<string>();
  const expectedModels = models.map((entry) => {
    if (!record(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) throw new Error('The native model catalog has missing or duplicate identities.');
    ids.add(entry.id);
    return entry === model ? { id: entry.id, maxEvaluatedTokens: contextCapacity } : { id: entry.id };
  });
  return { modelId: String(model.id), containment, privateMemory: { forecastBytes, sourceFileBytes, deviceChargeBytes }, expectedModels,
    binaryBytes: Number(binaries[0].bytes), binarySha256: String(binaries[0].sha256) };
}

/** Configuration is metadata, never a checkpoint or an unbounded read. */
export function nativeConfigText(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const file = fstatSync(fd);
    const maximum = 1024 * 1024;
    if (!file.isFile() || file.size > maximum) throw new Error('The native configuration must be a regular file no larger than 1 MiB.');
    const bytes = Buffer.alloc(maximum + 1); let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > maximum) throw new Error('The native configuration grew beyond its bounded read.');
    return bytes.subarray(0, count).toString('utf8');
  } finally { closeSync(fd); }
}

const stamp = (path: string) => {
  const info = statSync(path, { bigint: true });
  if (!info.isFile()) throw new Error('The qualified HAG input is not a regular file.');
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
};

/** Bounded executable verification; the checkpoint is opened only by the first actual request. */
export async function nativeHagIdentity(binary: string, config: string, configText: string, plan: NativeHagPlan): Promise<{
  verifyIdentity(): Promise<void>; identityUnchanged(): void;
}> {
  const before = stamp(binary);
  if (statSync(binary).size !== plan.binaryBytes) throw new Error('The packaged native HAG binary size changed.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(binary, { highWaterMark: 64 * 1024 })) hash.update(chunk);
  if (stamp(binary) !== before || hash.digest('hex') !== plan.binarySha256) throw new Error('The packaged native HAG binary hash changed.');
  const configHash = digest(configText);
  const checkConfig = () => {
    if (digest(nativeConfigText(config)) !== configHash) throw new Error('The HAG configuration changed during startup. Retry after saving it.');
  };
  let starting = true;
  return {
    verifyIdentity: async () => { if (stamp(binary) !== before) throw new Error('The native HAG executable changed.'); checkConfig(); },
    identityUnchanged: () => {
      if (stamp(binary) !== before) throw new Error('The native HAG executable changed. Restart with a qualified build.');
      if (starting) { checkConfig(); starting = false; }
    },
  };
}
