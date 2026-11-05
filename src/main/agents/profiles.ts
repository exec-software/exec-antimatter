import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { dump, load } from 'js-yaml';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../privateState';
import type { AgentDefinition } from './types';

/**
 * Orchestration profiles: which model takes which role inside one run.
 *
 * An orchestrated run otherwise uses a single model for everything, and that is the right default
 * — one model that can do the whole job has no handoffs to get wrong. A profile is the deliberate
 * exception, for when the jobs genuinely differ: a 30B coder is faster than a 230B generalist at
 * writing a patch, and neither of them can synthesise speech at all.
 *
 * Roles are matched against an agent's existing tags rather than a new field on every agent. An
 * agent already says it is about `code` or `audio` or `image`; asking it to also declare a role
 * would be the same fact written twice, and the second copy is the one that goes stale.
 *
 * One file per profile, like agents, for the same reason: adding one should be writing a paragraph
 * rather than writing code.
 */

export interface RoleBinding {
  /** Source id. Null means "whichever connected source serves this model". */
  provider: string | null;
  model: string;
  /**
   * Which of that model's workloads the slot runs under — ADR 0001's middle level.
   *
   * Null means the model's default workload, which is every binding written before workloads
   * existed. Naming one is what lets a profile put the same model in two roles under different
   * briefs and limits: `coding 32k` in one slot and `image` in another.
   */
  workload: string | null;
}

/**
 * Which catalog category a profile belongs to. Untagged profiles can be inferred from their
 * configured role bindings; they never match every category implicitly.
 */
export type ProfileMode = 'local' | 'distributed' | 'provider';

export interface OrchestrationProfile {
  id: string;
  name: string;
  description: string;
  mode?: ProfileMode;
  /**
   * Role → model. `default` is what an agent whose tags match nothing gets, and a profile without
   * one is refused at parse: a role table with a hole in it fails at dispatch, on whichever agent
   * happened to be first, which is the worst possible moment to discover it.
   */
  roles: Record<string, RoleBinding>;
  path: string;
  builtin: boolean;
}

/**
 * The authoring shape for a profile this app writes out as YAML. `workload` is optional here so
 * a starter can name a model and mean its default, exactly as a hand-written file may. Parsing
 * fills it in, so `RoleBinding` stays explicit for everything that reads a profile.
 */
type StoredRole = Omit<RoleBinding, 'workload'> & { workload?: string | null };
type StoredProfile = Omit<OrchestrationProfile, 'path' | 'builtin' | 'roles'> & {
  roles: Record<string, StoredRole>;
};

export const DEFAULT_ROLE = 'default';

let root = join(homedir(), '.antimatter', 'profiles');

export const useRoot = (path: string): void => {
  root = path;
};

export const location = (): string => root;

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

/** Ids become file names, so anything that could walk out of the directory is refused. */
export function assertId(id: string): string {
  const trimmed = id.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmed)) {
    throw new Error(`"${id}" is not a usable profile id — lowercase letters, digits and dashes only.`);
  }
  return trimmed;
}

function asRoles(value: unknown): Record<string, RoleBinding> {
  if (!value || typeof value !== 'object') return {};
  const roles: Record<string, RoleBinding> = {};
  for (const [role, binding] of Object.entries(value as Record<string, unknown>)) {
    if (!binding) continue;
    // `role: model-id` is the short form; the long form pins the source and the workload too.
    // The short form stays supported because these files are hand-edited and version with the
    // project — a UI that could only round-trip its own writes would be a regression.
    if (typeof binding === 'string') {
      const model = asString(binding);
      if (model) roles[role] = { provider: null, model, workload: null };
      continue;
    }
    if (typeof binding !== 'object') continue;
    const entry = binding as Record<string, unknown>;
    const model = asString(entry.model);
    // A workload id follows the same rule as everywhere else; anything else is dropped rather
    // than carried, so a typo resolves to the model's default instead of failing the profile.
    const named = asString(entry.workload);
    const workload = /^[a-z0-9][a-z0-9-]{0,63}$/.test(named) ? named : null;
    if (model) roles[role] = { provider: asString(entry.provider) || null, model, workload };
  }
  return roles;
}

function parse(path: string, builtin: boolean): OrchestrationProfile | null {
  try {
    const raw = (load(readFileSync(path, 'utf8')) ?? {}) as Record<string, unknown>;
    const id = asString(raw.id, basename(path).replace(/\.ya?ml$/, ''));
    if (!id) return null;

    const roles = asRoles(raw.roles);
    if (!roles[DEFAULT_ROLE]) {
      console.error(`[profiles] skipping ${path}: no "${DEFAULT_ROLE}" role, so some agent would have no model.`);
      return null;
    }
    const declared = asString(raw.mode).toLowerCase();
    const mode = declared === 'single' ? 'local' :
      declared === 'local' || declared === 'distributed' || declared === 'provider' ? declared : undefined;
    return { id, name: asString(raw.name, id), description: asString(raw.description), ...(mode ? { mode } : {}), roles, path, builtin };
  } catch (error) {
    console.error(`[profiles] skipping ${path}:`, error);
    return null;
  }
}

export function list(): OrchestrationProfile[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => parse(join(root, name), false))
    .filter((profile): profile is OrchestrationProfile => !!profile)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const find = (id: string): OrchestrationProfile | null => list().find((profile) => profile.id === id) ?? null;

function serialized(profile: StoredProfile): string {
  const roles: Record<string, unknown> = {};
  for (const [role, binding] of Object.entries(profile.roles)) {
    // Keep the short form where it says everything: a bare model id means "whichever source
    // serves this, on its default workload", and writing the long form for that would make
    // every generated file noisier than the hand-written ones it sits beside.
    roles[role] = binding.provider || binding.workload
      ? { ...(binding.provider ? { provider: binding.provider } : {}), model: binding.model,
          ...(binding.workload ? { workload: binding.workload } : {}) }
      : binding.model;
  }
  return dump(
    { id: profile.id, name: profile.name || profile.id, description: profile.description,
      ...(profile.mode ? { mode: profile.mode } : {}), roles },
    { lineWidth: 100, noRefs: true }
  );
}

export function save(profile: StoredProfile): OrchestrationProfile {
  const id = assertId(profile.id);
  ensurePrivateDirectory(root);
  const path = join(root, `${id}.yaml`);
  writePrivateFileAtomic(path, serialized({ ...profile, id }));
  return parse(path, false)!;
}

/**
 * Rewrite one top-level scalar in place, leaving every other byte alone.
 *
 * `save()` re-serialises from parsed fields, which is correct for a profile this app generated
 * and destructive for one a person wrote: it would drop their comments and formatting. Renaming
 * is a one-field edit, so it edits that one field.
 */
function setScalar(path: string, key: 'name' | 'mode', value: string): void {
  const original = readFileSync(path, 'utf8');
  const line = new RegExp(`^${key}:[^\\n]*$`, 'm');
  const quoted = /[:#]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
  let next: string;
  if (line.test(original)) next = original.replace(line, `${key}: ${quoted}`);
  else if (/^id:[^\n]*$/m.test(original)) next = original.replace(/^(id:[^\n]*)$/m, `$1\n${key}: ${quoted}`);
  else next = `${key}: ${quoted}\n${original}`;
  writePrivateFileAtomic(path, next);
}

/** Rename without touching the id: the id is the file name and the selection marker. */
export function rename(id: string, name: string): OrchestrationProfile | null {
  const profile = find(assertId(id));
  if (!profile) return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200) throw new Error('A profile name must be 1-200 characters.');
  setScalar(profile.path, 'name', trimmed);
  return parse(profile.path, profile.builtin);
}

/** Tag which catalog category a profile belongs to. */
export function setMode(id: string, mode: ProfileMode | null): OrchestrationProfile | null {
  const profile = find(assertId(id));
  if (!profile) return null;
  if (mode && mode !== 'local' && mode !== 'distributed' && mode !== 'provider') throw new Error('Unknown profile mode.');
  setScalar(profile.path, 'mode', mode ?? '');
  return parse(profile.path, profile.builtin);
}

export function remove(id: string): void {
  const profile = find(assertId(id));
  if (profile) rmSync(profile.path, { force: true });
}

/**
 * The model an agent should run on under a profile.
 *
 * First tag that names a role wins, then `default`. Tags are ordered in the agent's own file, so
 * an agent tagged `['code', 'review']` under a profile that binds both is asking for the coder —
 * which is what writing `code` first meant.
 */
export function bindingFor(agent: Pick<AgentDefinition, 'tags'>, profile: OrchestrationProfile): RoleBinding {
  for (const tag of agent.tags) {
    const binding = profile.roles[tag];
    if (binding) return binding;
  }
  return profile.roles[DEFAULT_ROLE];
}

/**
 * The starter profile, written once.
 *
 * Bound to roles rather than to this machine's model names where it can be: the ids here are the
 * ones beholdd serves on this box, and a profile naming a model that is not connected resolves to
 * nothing — which the runner reports rather than silently substituting.
 */
const LEGACY_FABLE_TWO_BOX: StoredProfile = {
  id: 'two-box',
  name: 'Two boxes',
  description: 'Generalist on Beholder, coder and media on mimic — both GPUs working at once.',
  roles: {
    default: { provider: null, model: 'gpt-oss-120b-fable5' },
    security: { provider: null, model: 'gpt-oss-120b-fable5' },
    code: { provider: 'mimic-coder', model: 'qwen3-coder-30b' },
    audio: { provider: 'mimic-coder', model: 'qwen3-coder-30b' },
    image: { provider: 'mimic-coder', model: 'qwen3-coder-30b' },
  },
};

const NEMOTRON_SUPER_Q4 = 'lmstudio.NVIDIA-Nemotron-3-Super-120B-A12B-Q4_K_M';
const NEMOTRON_SUPER_Q8 = 'nvidia-nemotron-3-super-120b-a12b-q8_0';
/**
 * Qwen3-Omni-30B-A3B-Thinking: text, audio, images and video in, text out.
 *
 * Served locally beside its `mmproj` projector, which is what makes it a model that can
 * actually see rather than one with a promising name — see `preview/eyes.ts`.
 */
const QWEN3_OMNI = 'qwen3-omni-30b';

/**
 * DeepSeek V4 Flash, the 0731 UD-Q2_K_XL build: the generalist when there is only one GPU.
 *
 * 90.18 GiB of weights, which is why this profile exists at all — it fits a 96 GiB carveout and
 * nothing smaller, so the machine that runs it has no VRAM left for a second model. `modelsAgree`
 * accepts the bare `deepseek-v4-flash` against this id, but the full one is what beholdd
 * advertises and a profile that names a model nothing serves resolves to nothing.
 */
const DEEPSEEK_V4_FLASH = 'deepseek-v4-flash-0731-ud-q2_k_xl';

/**
 * Qwen3-Coder-Next, the 80B-A3B agentic coder: 3B active, 262,144 native, non-thinking.
 *
 * The coder for a single large GPU. `qwen3next` is a hybrid — 48 blocks as
 * 12 x (3 x Gated DeltaNet -> 1 x Gated Attention) — so only 12 of them hold a KV cache, at
 * 24 KiB/token against Qwen3-Coder 30B's 96. That is why it gets two starters rather than one:
 * a full 262,144-token window and a six-way subagent pool are both affordable on the same
 * carveout, and which one is right depends on the work rather than on the hardware.
 */
const QWEN3_CODER_NEXT = 'qwen3-coder-next-80b';
const QWEN3_CODER_NEXT_SOURCE = 'local-qwen3-coder-next-80b';

/** The first Nemotron replacement shipped with the smaller single-pool Q4 checkpoint. */
const LEGACY_Q4_TWO_BOX: StoredProfile = {
  id: 'two-box',
  name: 'Two boxes',
  description: 'Nemotron Super on Beholder, coder and media on mimic — both GPUs working at once.',
  roles: {
    default: { provider: null, model: NEMOTRON_SUPER_Q4 },
    security: { provider: null, model: NEMOTRON_SUPER_Q4 },
    code: { provider: 'mimic-coder', model: 'qwen3-coder-30b' },
    audio: { provider: 'mimic-coder', model: 'qwen3-coder-30b' },
    image: { provider: 'mimic-coder', model: 'qwen3-coder-30b' },
  },
};

/**
 * The Q8 Nemotron starter, before the media roles had a model that could perceive anything.
 *
 * Both media roles pointed at the coder, which is text-only: an agent tagged `image` was
 * bound to a model that cannot look at one. That was the honest arrangement while nothing
 * on the box could see; it stops being honest the moment something can.
 */
const LEGACY_CODER_MEDIA_TWO_BOX: StoredProfile = {
  id: 'two-box',
  name: 'Two boxes',
  description: 'Nemotron Super on Beholder, coder and media on mimic — both GPUs working at once.',
  roles: {
    default: { provider: null, model: NEMOTRON_SUPER_Q8 },
    security: { provider: null, model: NEMOTRON_SUPER_Q8 },
    code: { provider: 'mimic-coder', model: 'qwen3-coder-30b' },
    audio: { provider: 'mimic-coder', model: 'qwen3-coder-30b' },
    image: { provider: 'mimic-coder', model: 'qwen3-coder-30b' },
  },
};

const STARTERS: StoredProfile[] = [
  {
    id: 'two-box',
    mode: 'distributed',
    name: 'Two boxes',
    description: 'Nemotron Super and the omni model on Beholder, coder on mimic — both GPUs working at once.',
    roles: {
      // The generalist answers anything without a better home, and reasons about security, where
      // finding the path from an input to an exploit is the whole job.
      // Q8_0 is the exact four-shard checkpoint previously downloaded through Antimatter. The
      // Beholder router may stripe it onto its configured RPC peer; native beholdd must continue
      // to reject nemotron_h_moe until that architecture's parity gates pass.
      default: { provider: null, model: NEMOTRON_SUPER_Q8 },
      security: { provider: null, model: NEMOTRON_SUPER_Q8 },
      // Purpose-built and much faster on a patch than the 120B generalist is.
      code: { provider: 'mimic-coder', model: 'qwen3-coder-30b' },
      // Media roles still get the FAST model rather than a big one — nothing here synthesises
      // audio or pixels, Kokoro and the image server do that, and latency is what the job feels
      // like — but the fast model now has senses. Omni is 3B active, and it reads a screenshot
      // or a recording itself instead of describing one from a filename.
      //
      // Local (`provider: null`) on purpose, unlike the coder. `preview/eyes.ts` prefers a
      // loopback source because it can inspect an image without sending it to another machine,
      // and a screenshot of this desktop is the most private thing either role handles.
      audio: { provider: null, model: QWEN3_OMNI },
      image: { provider: null, model: QWEN3_OMNI },
    },
  },
  {
    id: 'one-box',
    mode: 'local',
    name: 'Single box',
    description: 'Everything on this machine — DeepSeek V4 Flash on the GPU, Omni in system RAM.',
    roles: {
      // Every binding is local on purpose. The point of this profile is that there is no second
      // machine to be down, so pinning a provider would only add a way for it to be wrong.
      //
      // The generalist also takes `code`, which the two-box profile deliberately does not do.
      // There, a 30B coder on its own GPU is faster on a patch than the big model and costs
      // nothing to keep resident. Here the coder would have to evict the generalist to load, so
      // the handoff buys latency rather than saving it, and DeepSeek V4 Flash is a competent
      // enough coder to make that trade the wrong one.
      default: { provider: null, model: DEEPSEEK_V4_FLASH },
      security: { provider: null, model: DEEPSEEK_V4_FLASH },
      code: { provider: null, model: DEEPSEEK_V4_FLASH },
      // Omni is 3B active and lives in system RAM beside the GPU-resident generalist, so a look
      // at a screenshot does not disturb the model holding the conversation. Same reasoning as
      // the two-box profile: loopback, because a picture of this desktop should not leave it.
      audio: { provider: null, model: QWEN3_OMNI },
      image: { provider: null, model: QWEN3_OMNI },
    },
  },
  {
    id: 'coder-next-straight',
    mode: 'local',
    name: 'Coder Next - full window',
    description: 'Qwen3-Coder-Next 80B holding all 262,144 tokens in one sequence, Omni still seeing and hearing.',
    roles: {
      // The straight-shot half of a deliberate pair. Identical bindings to `coder-next-pool`;
      // what differs is the workload each slot runs under — ADR 0001's middle level, which is
      // exactly the distinction that previously had nowhere to live and ended up as two
      // orchestration profiles called `Default` and `Orchestrated`.
      //
      // One slot means no subagent concurrency: a subagent and its parent share it and
      // serialize. That is the point of this profile — a single agent with a great deal in
      // view — and `coder-next-pool` is the one for fanning work out.
      default: { provider: QWEN3_CODER_NEXT_SOURCE, model: QWEN3_CODER_NEXT, workload: 'full-window' },
      security: { provider: QWEN3_CODER_NEXT_SOURCE, model: QWEN3_CODER_NEXT, workload: 'full-window' },
      code: { provider: QWEN3_CODER_NEXT_SOURCE, model: QWEN3_CODER_NEXT, workload: 'full-window' },
      // Unchanged from every profile before it: Omni holds the roles it can actually serve, on
      // the loopback, because a screenshot of this desktop should not leave it.
      audio: { provider: null, model: QWEN3_OMNI, workload: null },
      image: { provider: null, model: QWEN3_OMNI, workload: null },
    },
  },
  {
    id: 'coder-next-pool',
    mode: 'local',
    name: 'Coder Next - subagent pool',
    description: 'Qwen3-Coder-Next 80B across six 65,536-token slots so subagents run in parallel, Omni seeing and hearing.',
    roles: {
      // The fan-out half, and the one to load when subagents matter. Subagents have no app-side
      // pool — they queue on the backend's slots. A server holding six runs six of these
      // bindings at once and makes the seventh wait, so the slot count is the concurrency.
      //
      // A pool trades per-stream latency for aggregate throughput. That is the right trade when
      // six agents are working and the wrong one when a person is waiting on one answer, which
      // is the whole reason both starters exist instead of a single compromise.
      default: { provider: QWEN3_CODER_NEXT_SOURCE, model: QWEN3_CODER_NEXT, workload: 'fan-out' },
      security: { provider: QWEN3_CODER_NEXT_SOURCE, model: QWEN3_CODER_NEXT, workload: 'fan-out' },
      code: { provider: QWEN3_CODER_NEXT_SOURCE, model: QWEN3_CODER_NEXT, workload: 'fan-out' },
      audio: { provider: null, model: QWEN3_OMNI, workload: null },
      image: { provider: null, model: QWEN3_OMNI, workload: null },
    },
  },
];

/**
 * Replace a generated starter only while its bytes are exactly the ones this app wrote.
 *
 * Profiles are deliberately editable YAML. Comparing parsed fields would erase a user's comments
 * or formatting even when the effective bindings still happened to match the old starter. An
 * exact comparison gives the built-in a one-time upgrade without turning it into managed state.
 */
function migrateUnmodifiedStarters(seeded: ReadonlySet<string>): void {
  // The marker is the ownership evidence: an identical hand-written profile on an installation
  // that was never offered this starter is still the user's file.
  if (!seeded.has(LEGACY_FABLE_TWO_BOX.id)) return;
  const path = join(root, `${LEGACY_FABLE_TWO_BOX.id}.yaml`);
  if (!existsSync(path)) return;
  const generated = readFileSync(path, 'utf8');
  const shipped = [LEGACY_FABLE_TWO_BOX, LEGACY_Q4_TWO_BOX, LEGACY_CODER_MEDIA_TWO_BOX];
  if (!shipped.some((profile) => generated === serialized(profile))) return;
  save(STARTERS.find((starter) => starter.id === LEGACY_FABLE_TWO_BOX.id)!);
}

/**
 * The profile an orchestrated run uses, or null for a straight run.
 *
 * Kept beside the profiles rather than in the renderer: the runner needs it, dispatch can come
 * from a schedule or the router with no window open, and a selection that only exists in a
 * component is not a selection the next launch remembers.
 */
export function selected(): OrchestrationProfile | null {
  const marker = join(root, '.selected');
  if (!existsSync(marker)) return null;
  const id = readFileSync(marker, 'utf8').trim();
  if (!id) return null;
  // A profile deleted while selected reads as a straight run rather than an error: the run should
  // still happen, on the model it would have used anyway.
  return find(id);
}

export function select(id: string | null): OrchestrationProfile | null {
  ensurePrivateDirectory(root);
  const marker = join(root, '.selected');
  if (!id) {
    rmSync(marker, { force: true });
    return null;
  }
  const profile = find(assertId(id));
  if (!profile) throw new Error(`no profile "${id}"`);
  writePrivateFileAtomic(marker, `${profile.id}\n`);
  return profile;
}

/** Writes starter profiles that have not been offered before. Mirrors the agent registry. */
export function ensureSeeded(): OrchestrationProfile[] {
  ensurePrivateDirectory(root);
  const marker = join(root, '.seeded');
  const seeded = new Set(
    existsSync(marker)
      ? readFileSync(marker, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^[a-z0-9][a-z0-9-]*$/.test(line))
      : []
  );
  migrateUnmodifiedStarters(seeded);
  // Tag older, otherwise untouched starter files without rewriting comments or user edits.
  for (const starter of STARTERS) {
    if (!seeded.has(starter.id)) continue;
    const current = find(starter.id);
    if (current && !current.mode && current.name === starter.name && current.description === starter.description &&
      JSON.stringify(current.roles) === JSON.stringify(starter.roles)) {
      setMode(current.id, starter.mode!);
    }
  }
  const present = new Set(list().map((profile) => profile.id));

  const offered = STARTERS.filter((starter) => !seeded.has(starter.id));
  for (const starter of offered) {
    if (!present.has(starter.id)) save(starter);
    seeded.add(starter.id);
  }
  if (offered.length || !existsSync(marker)) writePrivateFileAtomic(marker, `${[...seeded].sort().join('\n')}\n`);
  return list();
}
