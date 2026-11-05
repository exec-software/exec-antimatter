import { assertNodeKey } from './nodes';
import { isThinkingLevel } from './thinking';
import type { ThinkingLevel } from './types';

/**
 * A workload is a named, launchable configuration of one model: ADR 0001's middle level, between
 * the model (what inference exists) and an orchestration profile (who runs what).
 *
 * It is what a per-model override used to be, with an identity. One model may have several — a
 * wide-window workload for long reading and a many-slot one for fanning work out are the same
 * checkpoint used two ways — and exactly one is the default, which is what resolves when nothing
 * more specific is chosen.
 */
export interface WorkloadSettings {
  thinkingLevel?: ThinkingLevel;
  instructions?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  maxToolCallsPerMessage?: number;
  compaction?: 'summarize' | 'drop';
  /**
   * The boxes this workload expects to run across, as `host:port` keys — ADR 0001 stage 4.
   *
   * Distribution belongs to a workload rather than to a source because the same checkpoint is
   * local in one workload and striped in another; today that difference is expressed only by
   * having two unrelated source entries.
   *
   * This **records and reports**. Selecting boxes does not reconfigure a server: the runtime
   * takes its RPC peers on the command line, and restarting servers Antimatter did not spawn is
   * out of scope for the same reason a workload carries no slot count. The UI shows whether the
   * declared boxes are answering; making a server adopt them needs the node agent.
   */
  nodes?: string[];
}

export interface ModelWorkload {
  id: string;
  name: string;
  /** Free text: a workload describes an intended use that its name cannot carry. */
  description: string;
  settings: WorkloadSettings;
}

export interface ModelWorkloadsView {
  providerId: string;
  modelId: string;
  /** Always one of `workloads`, and always present once any workload exists. */
  defaultId: string;
  workloads: ModelWorkload[];
}

/** The id reserved for the workload a pre-ADR-0001 override migrates into. */
export const DEFAULT_WORKLOAD_ID = 'default';
export const WORKLOAD_NAME_LIMIT = 60;
export const WORKLOAD_DESCRIPTION_LIMIT = 500;

/** Ids reach a JSON object key and the renderer, never a path, but stay strict regardless. */
export function assertWorkloadId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new Error('A workload id is lowercase letters, digits and dashes.');
  }
  return value;
}

const text = (value: unknown, limit: number, label: string): string => {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid workload ${label}.`);
  }
  const trimmed = value.replace(/\r\n/g, '\n').trim();
  if (trimmed.length > limit) throw new Error(`Keep the workload ${label} under ${limit} characters.`);
  return trimmed;
};

export const assertWorkloadName = (value: unknown): string => {
  const name = text(value, WORKLOAD_NAME_LIMIT, 'name');
  if (!name || name.includes('\n')) throw new Error('Choose a workload name.');
  return name;
};

export const assertWorkloadDescription = (value: unknown): string =>
  text(value ?? '', WORKLOAD_DESCRIPTION_LIMIT, 'description');

const NUMERIC = ['contextTokens', 'maxOutputTokens', 'maxToolCallsPerMessage'] as const;
const KEYS = ['thinkingLevel', 'instructions', ...NUMERIC, 'compaction', 'nodes'] as const;

/**
 * Settings are validated here rather than at the store so the same rules apply to a renderer
 * patch and to a value read back from disk. Bounds belong to resolution, not to validation: a
 * window larger than the model's is clamped when the profile resolves, not refused on the way in.
 */
export function assertWorkloadSettings(value: unknown): WorkloadSettings {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Workload settings must be an object.');
  const input = value as Record<string, unknown>;
  for (const found of Object.keys(input)) {
    if (!(KEYS as readonly string[]).includes(found)) throw new Error(`Unknown workload setting "${found}".`);
  }
  const settings: WorkloadSettings = {};
  if (Object.hasOwn(input, 'thinkingLevel')) {
    if (!isThinkingLevel(input.thinkingLevel)) throw new Error('Unknown thinking level.');
    settings.thinkingLevel = input.thinkingLevel;
  }
  if (Object.hasOwn(input, 'instructions')) {
    if (typeof input.instructions !== 'string') throw new Error('Workload instructions must be text.');
    settings.instructions = input.instructions.replace(/\r\n/g, '\n');
  }
  for (const field of NUMERIC) {
    if (!Object.hasOwn(input, field)) continue;
    const found = input[field];
    // Finite numbers only, but no range check: an out-of-range figure is clamped when the
    // profile resolves, where the window and the tool-call cap are actually known. Refusing it
    // here would reject a zero that the store has always accepted and resolution reads as
    // "use the default".
    if (typeof found !== 'number' || !Number.isFinite(found)) {
      throw new Error(`Workload ${field} must be a number.`);
    }
    settings[field] = Math.trunc(found);
  }
  if (Object.hasOwn(input, 'compaction')) {
    if (input.compaction !== 'summarize' && input.compaction !== 'drop') throw new Error('Unknown compaction mode.');
    settings.compaction = input.compaction;
  }
  if (Object.hasOwn(input, 'nodes')) {
    if (!Array.isArray(input.nodes)) throw new Error('Workload nodes must be a list.');
    if (input.nodes.length > 16) throw new Error('Keep a workload to 16 nodes or fewer.');
    // Same rule as a preset's RPC target: a node is a host:port and nothing else, so a stored
    // value can never become an injected runtime flag.
    const keys = input.nodes.map((node) => assertNodeKey(node));
    settings.nodes = [...new Set(keys)];
  }
  return settings;
}

export interface ModelWorkloadsAPI {
  list(providerId: string, modelId: string): Promise<ModelWorkloadsView>;
  create(providerId: string, modelId: string, input: { name: string; description?: string; settings?: WorkloadSettings }): Promise<ModelWorkloadsView>;
  update(providerId: string, modelId: string, id: string, patch: { name?: string; description?: string; settings?: WorkloadSettings }): Promise<ModelWorkloadsView>;
  remove(providerId: string, modelId: string, id: string): Promise<ModelWorkloadsView>;
  setDefault(providerId: string, modelId: string, id: string): Promise<ModelWorkloadsView>;
  storeInfo(): Promise<{ path: string }>;
}
