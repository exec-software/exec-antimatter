import { isThinkingLevel } from '../api/thinking';
import {
  assertWorkloadDescription,
  assertWorkloadId,
  assertWorkloadName,
  assertWorkloadSettings,
  DEFAULT_WORKLOAD_ID,
  type ModelWorkload,
  type ModelWorkloadsView,
  type WorkloadSettings,
} from '../api/modelWorkloads';
import type { Model, ThinkingLevel } from '../api/types';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_MAX_TOOL_CALLS, toolCallCap } from '../api/toolArguments';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from './privateState';

/**
 * What each model can actually hold.
 *
 * Antimatter used to send `max_tokens: 4096` to everything and never think about the context
 * window at all, which is wrong in both directions: it caps a model that could write far more,
 * and it says nothing about the input side, so a long conversation silently overflows whatever
 * the server's real limit is.
 *
 * A profile is per model, not per app. It is resolved from the most specific thing that knows:
 *
 *   override   what you set by hand in Settings
 *   server     what the server reported when the source was probed — the only authority
 *   known      a table of published windows, matched on the model id
 *   default    a deliberately small, safe guess for a model nobody recognises
 *
 * A separately reported execution cap bounds all of these, including an override. The source
 * is carried through to the UI so a number nobody verified never looks like one that was measured.
 */

export type ProfileSource = 'override' | 'server' | 'known' | 'default';

export interface ModelProfile {
  thinkingLevel: ThinkingLevel;
  modelId: string;
  /** Optional model-specific standing brief, composed before Antimatter's safety grounding. */
  instructions?: string;
  /** Total tokens the model can attend to, prompt plus completion. */
  contextTokens: number;
  /** Server's hard evaluated-position cap; prompt estimates do not establish exact admission. */
  maxEvaluatedTokens?: number;
  /** Ceiling on one reply. Never more than a sensible slice of the window. */
  maxOutputTokens: number;
  /** The most tool calls one reply of this model's may ask for at once. */
  maxToolCallsPerMessage: number;
  contextSource: ProfileSource;
  outputSource: ProfileSource;
  toolCallSource: ProfileSource;
  /** Summarize what is about to fall out of the window rather than dropping it. */
  compaction: 'summarize' | 'drop';
}

/**
 * The settings a workload applies. Kept as an alias of the shared type so the renderer, the
 * store and the IPC validators all agree on one shape — see ADR 0001.
 */
export type ProfileOverride = WorkloadSettings;

/** A smaller engine allocation must leave prompt space as well as fit the completion itself. */
export function withEngineContext(profile: ModelProfile, contextLimit: number | null): ModelProfile {
  if (!contextLimit || profile.contextTokens <= contextLimit) return profile;
  const outputLimit = Math.max(1, Math.floor(contextLimit / 4));
  return { ...profile, contextTokens: contextLimit, contextSource: 'server',
    maxOutputTokens: Math.min(profile.maxOutputTokens, outputLimit),
    ...(profile.maxOutputTokens > outputLimit ? { outputSource: 'server' as const } : {}) };
}

/** One model's workloads. `defaultId` always names a present entry. */
interface StoredModel {
  defaultId: string;
  workloads: Record<string, ModelWorkload>;
}

interface StoreFile {
  version: 2;
  /**
   * Keyed `<providerId>::<modelId>`, so the same model name on two servers stays separate.
   *
   * That separation is deliberate and ADR 0001 keeps it: what a model can actually do — its
   * window, its slots — is a property of the server holding it, not of the checkpoint. The same
   * weights behind two endpoints are two different capabilities and get their own workloads.
   */
  models: Record<string, StoredModel>;
}

/** The shape written before ADR 0001: one anonymous override per model. */
interface LegacyStoreFile {
  version: 1;
  overrides: Record<string, WorkloadSettings>;
}

/**
 * Published context windows, matched longest-pattern-first against the model id. These are the
 * model's own documented limit, which is not always what a given server will accept — a server
 * that reports its own number overrides all of this.
 */
const KNOWN: [RegExp, number][] = [
  // First match wins, so the omni line has to precede the general `qwen3` one below. Its
  // window really is 65536 (`qwen3vlmoe.context_length` in the checkpoint) — a quarter of
  // what its coder siblings carry, and half of what `qwen3` alone would have claimed here.
  // Overstating a window is the expensive direction: the prompt is built to fill it and the
  // server truncates the far end, so the turn loses its oldest messages without saying so.
  [/qwen3-omni/i, 65_536],
  [/qwen3-coder|qwen3\.5|qwen3-next/i, 262_144],
  [/qwen3|qwen-?3/i, 131_072],
  [/qwen2\.5-coder|qwen2\.5/i, 131_072],
  [/llama-?3\.[123]|llama-?3\.3/i, 131_072],
  [/llama-?3/i, 8_192],
  // DeepSeek V4 Flash carries 1,048,576 — `deepseek4.context_length` in the checkpoint, which
  // YaRN reaches at factor 16 over a 65,536 training window. It needs a line of its own: the
  // `v?[23]` pattern below never matched a v4 id, so a model with the largest window in this
  // table fell all the way through to DEFAULT_CONTEXT's 8,192. beholdd reports `ctx_size` and
  // so overrides this with whatever BEHOLDD_CTX it was started on (131,072 here); the number
  // below is the model's own documented limit, for a source that reports nothing.
  [/deepseek-?v?4/i, 1_048_576],
  [/deepseek-?(coder-?)?v?[23]/i, 131_072],
  [/mistral-?(large|nemo)|mixtral/i, 131_072],
  [/codestral/i, 262_144],
  [/gemma-?[23]/i, 8_192],
  [/phi-?4/i, 16_384],
  [/gpt-oss/i, 131_072],
  [/nemotron/i, 131_072],
  [/gpt-4\.1|gpt-4o|o[34]-/i, 128_000],
  [/claude/i, 200_000],
];

/**
 * How wide a batch each model may ask for, matched longest-pattern-first against the model id.
 *
 * A cap is not a judgement about a model's ability; it is what its failure looks like. Most
 * models that overreach do so by a few calls. Some do it by a thousand: MiMo, asked to read its
 * way around a repository with a nearly full window, twice emitted a batch of degenerate
 * `read_file` calls — 1,306 on one reply, 433 on another — walking the same handful of files at
 * drifting line offsets. Every one of those was decoded at the same cost as any other token, so
 * the turn spent sixteen and then thirty-four minutes producing calls that the window could
 * never have carried, and from the outside it looked like a hang with the GPUs at forty percent.
 *
 * So the number to pick is the one comfortably above what the model asks for when it is working
 * and far below what it asks for when it is lost. MiMo's healthy rounds here used one to six
 * calls, which makes sixteen generous and still cuts a runaway in about half a minute.
 */
const KNOWN_TOOL_CALLS: [RegExp, number][] = [[/mimo/i, 16]];

/**
 * How long one reply may run for a model whose thinking is billed as output, matched
 * longest-pattern-first against the model id.
 *
 * `OUTPUT_CEILING` below is a lid on what any reply may ask for. This is the narrower question of
 * what a particular model does with that lid, and it is a two-sided number, because the output
 * reservation is taken out of the same window the prompt has to live in — see `promptBudget`.
 *
 * Measured here, on a four-hour MiMo session that read 207 files and wrote nothing. Its decode
 * held 16 tok/s from the first turn to the last, so nothing was slow; each turn simply spent
 * 11,000-12,400 tokens deliberating and emitted about 300 of them as text and tool calls. At the
 * 32,768 lid one turn may run thirty-four minutes at that rate. The reservation cost as much as
 * the delay did: on a 131,072 window it left a prompt that compacted to 57,043 tokens, so files
 * fell out of the window faster than the model could read them — 73% of its reads were re-reads,
 * and `src/main/index.ts` was read twenty-eight times.
 *
 * Giving reservation back is exactly 0.9 tokens of budget per token, and 0.7 of that again in
 * room before compaction. Cutting 32,768 to 12,288 did what it was meant to: on the next session
 * re-reads fell from 73% to 35% and tool results from 195,000 tokens to 66,000.
 *
 * But 12,288 was set at the top of the observed range rather than above it, and carbon e2b3a672
 * then spent 811 seconds thinking in one round, hit the lid with nothing written, and ended a
 * turn that was 97 tool calls and an hour and a half deep. The range was never a ceiling: MiMo's
 * per-round deliberation grows with the conversation — 600 tokens early, 10,439 at the fifty-
 * minute mark — so a cap level with the peak is a cap that gets hit.
 *
 * 16,384 clears the largest round yet measured by about a third and still returns 16,384 tokens
 * of reservation against the original. It is the second line of defence rather than the first:
 * the loop now carries a turn on through a round the lid cut off (see RAN_OUT_THINKING), so
 * reaching this costs a round rather than the turn.
 *
 * Qwen3-Coder is here for the other reason. It does not think aloud, so its replies are answer
 * and tool arguments and nothing else — across 319 rounds of `qwen3-coder-30b` on this box the
 * largest was 5,473 tokens. Left at the share it would reserve 32,768 for output it never writes
 * and hand the conversation a budget of 81,496 against MiMo's 96,242, which is the smaller window
 * and the sooner compaction for no gain at all. 16,384 is three times the largest reply measured
 * — clear of the peak rather than level with it, which is the mistake the line above records.
 */
const KNOWN_OUTPUT: [RegExp, number][] = [
  [/mimo/i, 16_384],
  [/qwen3-coder/i, 16_384],
];

/** Small enough to be safe on a server nobody has asked, large enough to hold a conversation. */
const DEFAULT_CONTEXT = 8_192;
/** Output is capped at a share of the window so a reply can never crowd out its own prompt. */
const OUTPUT_SHARE = 0.25;
/**
 * The most a reply may be allowed, whatever the window.
 *
 * Raised from 8192, which a reasoning model reaches without writing much: its thinking is
 * billed as completion, so a long deliberation followed by a whole-file `write_file` ran out
 * mid-call and had to be recovered from. The share above still does the real work — a small
 * model's window is unaffected — and this only lifts the lid for the large ones.
 */
const OUTPUT_CEILING = 32_768;
const OUTPUT_FLOOR = 512;

/** Electron owns the real userData path; main sets it once at startup. */
let configPath = join(homedir(), '.antimatter', 'model-profiles.json');
let cache: StoreFile | null = null;

export const useConfigPath = (path: string): void => {
  configPath = path;
  cache = null;
};

const key = (providerId: string, modelId: string) => `${providerId}::${modelId}`;

const read = (): StoreFile => {
  if (cache) return cache;
  const ownsDirectory = migratePrivateDirectory(dirname(configPath));
  if (!existsSync(configPath)) {
    cache = EMPTY();
    return cache;
  }
  if (ownsDirectory) migratePrivateFile(configPath);
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    cache = adopt(parsed);
  } catch (error) {
    console.error('[profiles] unreadable store, starting empty:', error);
    cache = EMPTY();
  }
  return cache;
};

const EMPTY = (): StoreFile => ({ version: 2, models: {} });

/** One workload, built from settings that were already on disk or already validated. */
const workload = (id: string, name: string, settings: WorkloadSettings, description = ''): ModelWorkload =>
  ({ id, name, description, settings });

/**
 * Accept either shape. ADR 0001's migration contract: a pre-existing override becomes that
 * model's single workload, named `Default`, marked default, with its settings unchanged — so a
 * store written by an older build resolves to exactly the same profile it did before.
 *
 * A malformed entry is dropped rather than failing the whole store. Losing one model's override
 * degrades to resolution from server and catalog facts; refusing to read the file would discard
 * every other model's too.
 */
function adopt(parsed: unknown): StoreFile {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY();
  const file = parsed as { version?: unknown; overrides?: unknown; models?: unknown };

  if (file.version === 1 && file.overrides && typeof file.overrides === 'object') {
    const models: Record<string, StoredModel> = {};
    for (const [slot, settings] of Object.entries(file.overrides as LegacyStoreFile['overrides'])) {
      try {
        models[slot] = {
          defaultId: DEFAULT_WORKLOAD_ID,
          workloads: { [DEFAULT_WORKLOAD_ID]: workload(DEFAULT_WORKLOAD_ID, 'Default', assertWorkloadSettings(settings)) },
        };
      } catch { /* An unreadable override is dropped; the model resolves from server facts. */ }
    }
    return { version: 2, models };
  }

  if (file.version !== 2 || !file.models || typeof file.models !== 'object' || Array.isArray(file.models)) return EMPTY();
  const models: Record<string, StoredModel> = {};
  for (const [slot, stored] of Object.entries(file.models as StoreFile['models'])) {
    try {
      if (!stored || typeof stored !== 'object' || !stored.workloads || typeof stored.workloads !== 'object') continue;
      const kept: Record<string, ModelWorkload> = {};
      for (const [id, entry] of Object.entries(stored.workloads)) {
        const checked = assertWorkloadId(id);
        kept[checked] = workload(checked, assertWorkloadName(entry?.name),
          assertWorkloadSettings(entry?.settings), assertWorkloadDescription(entry?.description));
      }
      const ids = Object.keys(kept);
      if (!ids.length) continue;
      // A `defaultId` naming a workload that is gone would make resolution undefined; the
      // first remaining entry is a better answer than none.
      models[slot] = { defaultId: ids.includes(stored.defaultId) ? stored.defaultId : ids[0], workloads: kept };
    } catch { /* Same reasoning as above: drop the model, keep the store. */ }
  }
  return { version: 2, models };
}

const write = (next: StoreFile) => {
  writePrivateFileAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  cache = next;
};

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;

const knownContext = (modelId: string): number | null =>
  KNOWN.find(([pattern]) => pattern.test(modelId))?.[1] ?? null;

const knownToolCalls = (modelId: string): number | null =>
  KNOWN_TOOL_CALLS.find(([pattern]) => pattern.test(modelId))?.[1] ?? null;

const knownOutput = (modelId: string): number | null =>
  KNOWN_OUTPUT.find(([pattern]) => pattern.test(modelId))?.[1] ?? null;

/** A reply may use a quarter of the window, within reason, so the prompt keeps the rest. */
const defaultOutput = (contextTokens: number, executionCapped = false): number =>
  Math.max(executionCapped ? 1 : OUTPUT_FLOOR, Math.min(OUTPUT_CEILING, Math.floor(contextTokens * OUTPUT_SHARE)));

const executionCap = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

export interface ResolveInput {
  providerId: string;
  modelId: string;
  /** What the source reported for this model when it was last probed, if anything. */
  serverContextTokens?: number | null;
  /** Fixed execution storage reported by the server, independent of curated context metadata. */
  serverMaxEvaluatedTokens?: number | null;
  /**
   * Which workload to resolve. Absent, or naming one that is gone, falls back to the model's
   * default — a conversation whose workload was deleted keeps answering rather than breaking.
   */
  workloadId?: string;
}

export function resolve({ providerId, modelId, serverContextTokens, serverMaxEvaluatedTokens, workloadId }: ResolveInput): ModelProfile {
  const override = settingsFor(providerId, modelId, workloadId);
  const fromServer = positive(serverContextTokens);
  const fromKnown = knownContext(modelId);

  const requestedContext = positive(override.contextTokens) ?? fromServer ?? fromKnown ?? DEFAULT_CONTEXT;
  const maxEvaluatedTokens = executionCap(serverMaxEvaluatedTokens);
  const contextTokens = maxEvaluatedTokens === null ? requestedContext : Math.min(requestedContext, maxEvaluatedTokens);
  const limitedByExecution = maxEvaluatedTokens !== null && maxEvaluatedTokens <= requestedContext;
  const contextSource: ProfileSource = limitedByExecution
    ? 'server'
    : positive(override.contextTokens)
      ? 'override'
      : fromServer
        ? 'server'
        : fromKnown
          ? 'known'
          : 'default';

  const overrideOutput = positive(override.maxOutputTokens);
  const overrideToolCalls = positive(override.maxToolCallsPerMessage);
  const fromKnownToolCalls = knownToolCalls(modelId);
  // A model-specific cap is a ceiling on the share, never a floor under it: a 16k window's
  // quarter is smaller than any entry in the table and stays smaller.
  const fromKnownOutput = knownOutput(modelId);
  const outputDefault = defaultOutput(contextTokens, maxEvaluatedTokens !== null);
  const output = overrideOutput ?? Math.min(fromKnownOutput ?? OUTPUT_CEILING, outputDefault);
  return {
    modelId,
    thinkingLevel: isThinkingLevel(override.thinkingLevel) ? override.thinkingLevel : 'default',
    instructions: typeof override.instructions === 'string' ? override.instructions.trim() : '',
    contextTokens,
    ...(maxEvaluatedTokens === null ? {} : { maxEvaluatedTokens }),
    // An override is still bounded by the window: asking for more output than the model can
    // hold is not a preference, it is a request the server will reject.
    maxOutputTokens: Math.min(output, contextTokens),
    maxToolCallsPerMessage: toolCallCap(overrideToolCalls ?? fromKnownToolCalls ?? DEFAULT_MAX_TOOL_CALLS),
    contextSource,
    outputSource: limitedByExecution && output > contextTokens
      ? 'server'
      : overrideOutput
        ? 'override'
        : fromKnownOutput && fromKnownOutput < outputDefault
          ? 'known'
          : contextSource,
    toolCallSource: overrideToolCalls ? 'override' : fromKnownToolCalls ? 'known' : 'default',
    compaction: override.compaction ?? 'summarize',
  };
}

/** Effective server profile for an exact source catalog and model; never use for editable preferences. */
export function resolveSourceProfile(
  models: readonly Model[], providerId: string, modelId: string, workloadId?: string
): ModelProfile {
  const model = models.find((entry) => entry.id === modelId);
  return resolve({
    providerId, modelId, workloadId,
    serverContextTokens: model?.contextWindow,
    serverMaxEvaluatedTokens: model?.maxEvaluatedTokens,
  });
}

/**
 * The settings that resolution uses: the default workload's, or none.
 *
 * Stage 1 of ADR 0001 deliberately resolves the *default* workload rather than an active one.
 * Choosing which workload a turn runs under is a selection, like choosing a model, and belongs
 * with the work that introduces launching — until then this keeps behaviour identical to the
 * single-override store it replaced.
 */
function settingsFor(providerId: string, modelId: string, workloadId?: string): WorkloadSettings {
  const stored = read().models[key(providerId, modelId)];
  if (!stored) return {};
  return (workloadId ? stored.workloads[workloadId] : undefined)?.settings
    ?? stored.workloads[stored.defaultId]?.settings
    ?? {};
}

/** Whether a chosen workload still exists, so a caller can say so rather than silently differ. */
export const hasWorkload = (providerId: string, modelId: string, workloadId: string): boolean =>
  !!read().models[key(providerId, modelId)]?.workloads[workloadId];

/** Merge into the default workload, creating it when the model has none yet. */
export function setOverride(providerId: string, modelId: string, patch: ProfileOverride | null): void {
  const settings = patch === null ? null : assertWorkloadSettings(patch);
  const current = read();
  const slot = key(providerId, modelId);
  const models = { ...current.models };
  const stored = models[slot];

  if (settings === null) {
    // Clearing removes the whole model's workloads, which is what deleting its only override
    // used to do. A model with several keeps them: dropping a named workload the person made
    // because a metadata reset touched its model would be a surprise.
    if (!stored || Object.keys(stored.workloads).length <= 1) delete models[slot];
    else models[slot] = { ...stored, workloads: {
      ...stored.workloads,
      [stored.defaultId]: { ...stored.workloads[stored.defaultId], settings: {} },
    } };
    write({ ...current, models });
    return;
  }

  if (!stored) {
    models[slot] = { defaultId: DEFAULT_WORKLOAD_ID,
      workloads: { [DEFAULT_WORKLOAD_ID]: workload(DEFAULT_WORKLOAD_ID, 'Default', settings) } };
  } else {
    const target = stored.workloads[stored.defaultId];
    models[slot] = { ...stored, workloads: {
      ...stored.workloads,
      [stored.defaultId]: { ...target, settings: { ...target.settings, ...settings } },
    } };
  }
  write({ ...current, models });
}

// --- Workloads: ADR 0001's middle level. ------------------------------------------------------

const view = (providerId: string, modelId: string, stored?: StoredModel): ModelWorkloadsView => ({
  providerId,
  modelId,
  defaultId: stored?.defaultId ?? '',
  workloads: stored ? Object.values(stored.workloads).map((entry) => structuredClone(entry)) : [],
});

export const listWorkloads = (providerId: string, modelId: string): ModelWorkloadsView =>
  view(providerId, modelId, read().models[key(providerId, modelId)]);

/** A fresh id derived from the name, kept unique within the model. */
function freshId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workload';
  const stem = /^[a-z0-9]/.test(base) ? base : `w-${base}`;
  if (!taken.includes(stem)) return stem;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
  throw new Error('Too many workloads with that name.');
}

export function createWorkload(providerId: string, modelId: string,
  input: { name: unknown; description?: unknown; settings?: unknown }): ModelWorkloadsView {
  const name = assertWorkloadName(input.name);
  const description = assertWorkloadDescription(input.description);
  const settings = assertWorkloadSettings(input.settings);
  const current = read();
  const slot = key(providerId, modelId);
  const stored = current.models[slot];
  const id = freshId(name, Object.keys(stored?.workloads ?? {}));
  const models = { ...current.models, [slot]: {
    // The first workload a model gets becomes its default; later ones do not displace it.
    defaultId: stored?.defaultId ?? id,
    workloads: { ...(stored?.workloads ?? {}), [id]: workload(id, name, settings, description) },
  } };
  write({ ...current, models });
  return listWorkloads(providerId, modelId);
}

function mutate(providerId: string, modelId: string, change: (stored: StoredModel) => StoredModel): ModelWorkloadsView {
  const current = read();
  const slot = key(providerId, modelId);
  const stored = current.models[slot];
  if (!stored) throw new Error('This model has no workloads yet.');
  write({ ...current, models: { ...current.models, [slot]: change(stored) } });
  return listWorkloads(providerId, modelId);
}

export function updateWorkload(providerId: string, modelId: string, id: unknown,
  patch: { name?: unknown; description?: unknown; settings?: unknown }): ModelWorkloadsView {
  const target = assertWorkloadId(id);
  return mutate(providerId, modelId, (stored) => {
    const existing = stored.workloads[target];
    if (!existing) throw new Error('That workload no longer exists.');
    return { ...stored, workloads: { ...stored.workloads, [target]: {
      ...existing,
      ...(Object.hasOwn(patch, 'name') ? { name: assertWorkloadName(patch.name) } : {}),
      ...(Object.hasOwn(patch, 'description') ? { description: assertWorkloadDescription(patch.description) } : {}),
      // Settings replace rather than merge: an editor that cannot clear a field cannot undo one.
      ...(Object.hasOwn(patch, 'settings') ? { settings: assertWorkloadSettings(patch.settings) } : {}),
    } } };
  });
}

export function removeWorkload(providerId: string, modelId: string, id: unknown): ModelWorkloadsView {
  const target = assertWorkloadId(id);
  const current = read();
  const slot = key(providerId, modelId);
  const stored = current.models[slot];
  if (!stored?.workloads[target]) throw new Error('That workload no longer exists.');
  const workloads = { ...stored.workloads };
  delete workloads[target];
  const remaining = Object.keys(workloads);
  const models = { ...current.models };
  // The last workload leaving takes the model's entry with it, back to pure resolution.
  if (!remaining.length) delete models[slot];
  else models[slot] = { defaultId: remaining.includes(stored.defaultId) ? stored.defaultId : remaining[0], workloads };
  write({ ...current, models });
  return listWorkloads(providerId, modelId);
}

export function setDefaultWorkload(providerId: string, modelId: string, id: unknown): ModelWorkloadsView {
  const target = assertWorkloadId(id);
  return mutate(providerId, modelId, (stored) => {
    if (!stored.workloads[target]) throw new Error('That workload no longer exists.');
    return { ...stored, defaultId: target };
  });
}

/**
 * The effective override per model — each model's default-workload settings, keyed as the v1
 * store was. Kept because it is the honest answer to "what has been set by hand", and because
 * the privacy test uses it to prove a migrated store resolves to what it did before.
 */
export const overrides = (): Record<string, WorkloadSettings> =>
  Object.fromEntries(Object.entries(read().models)
    .map(([slot, stored]) => [slot, structuredClone(stored.workloads[stored.defaultId]?.settings ?? {})]));

/** Every model's workloads, for diagnostics and tests. */
export const storedModels = (): Record<string, ModelWorkloadsView> =>
  Object.fromEntries(Object.entries(read().models).map(([slot, stored]) => {
    const split = slot.lastIndexOf('::');
    return [slot, view(slot.slice(0, split), slot.slice(split + 2), stored)];
  }));

export const storeLocation = () => configPath;
