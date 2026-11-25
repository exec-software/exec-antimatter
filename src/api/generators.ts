/**
 * Generators: the things a universe can ask for media from.
 *
 * Antimatter's existing sources answer with tokens. Nothing in that stack can make a frame of
 * video — llama.cpp runs transformers, and a video model is a diffusion pipeline with a sampler,
 * a VAE and a scheduler that has no business inside a chat completion. So rather than bend the
 * source abstraction until it fits, a universe declares *generators*: a separate, much smaller
 * contract whose whole job is "take a prompt and some references, come back with a file".
 *
 * Adapters, not one protocol. There is no standard for this and pretending otherwise would mean
 * a compatibility layer that is wrong for every backend. The set is closed and each entry is
 * implemented in main:
 *
 * - `comfy` — a ComfyUI instance on this machine or the LAN. The one most people already have,
 *   and the one that runs Wan, LTX and Hunyuan today without Antimatter shipping a runtime.
 * - `openai-video` — an OpenAI-shaped video endpoint, which is what most hosted services and
 *   several self-hosted servers now expose.
 * - `unit` — a user systemd unit Antimatter probes and starts on demand, the same arrangement
 *   local inference engines already use (see main/localEngineLifecycle.ts). This is the path a
 *   packaged expansion takes: the weights land, the unit is written, Antimatter starts it when
 *   the workbench asks for a render and leaves it alone otherwise.
 *
 * A generator is never required. Every universe must be useful with none configured — you can
 * cut, arrange and annotate footage you shot yourself — because the alternative is an expansion
 * that is a brochure for a GPU you may not have.
 */

export type GeneratorKind = 'video' | 'image' | 'audio' | 'speech';

export const GENERATOR_KINDS: readonly GeneratorKind[] = Object.freeze(['video', 'image', 'audio', 'speech']);

export type GeneratorAdapter = 'comfy' | 'openai-video' | 'unit';

export const GENERATOR_ADAPTERS: readonly GeneratorAdapter[] = Object.freeze(['comfy', 'openai-video', 'unit']);

/**
 * What a generator can actually do.
 *
 * Carried so the workbench offers what the backend can deliver rather than what the marketing
 * said. Asking a 768p checkpoint for 2K does not fail fast — it either upscales silently or
 * runs for twenty minutes and returns mush, and both are worse than a disabled control.
 */
export interface GeneratorCapabilities {
  maxWidth: number;
  maxHeight: number;
  /** Longest single clip. Most open video models are a handful of seconds. */
  maxSeconds: number;
  fps: number;
  /** Whether the model emits its own audio, or the cut needs a separate pass. */
  audio: boolean;
  /** Whether a still can be handed in as the first frame. */
  imageToVideo: boolean;
  /** Rough, for the planner and for telling someone why their card cannot run it. */
  vramGibEstimate: number;
}

/**
 * Weights an expansion can offer to fetch.
 *
 * Descriptive only: this names what to download through the existing Hub and under what terms.
 * Nothing here downloads anything, and the licence is carried as text because the difference
 * between Apache-2.0 and a community licence with a revenue cap is the difference between an
 * expansion we can sell and one we cannot.
 */
export interface GeneratorWeights {
  repoId: string;
  revision: string;
  /** SPDX id where there is one, otherwise the licence's own name. */
  licence: string;
  /** Plain words: what the licence actually permits. Shown before a download starts. */
  licenceNote: string;
  sizeBytes: number;
}

export interface GeneratorSpec {
  id: string;
  name: string;
  kind: GeneratorKind;
  adapter: GeneratorAdapter;
  /** One line for the picker: what this is good at, and what it is not. */
  note: string;
  capabilities: GeneratorCapabilities;
  weights?: GeneratorWeights;
}

/**
 * What the person configured for a generator on this machine.
 *
 * Separate from the spec because the spec ships with the expansion and the binding is local: the
 * endpoint, the unit name, whether it is switched on at all. An expansion update replaces specs
 * and must not disturb bindings.
 */
export interface GeneratorBinding {
  generatorId: string;
  enabled: boolean;
  /** `comfy` and `openai-video`: where it is. */
  endpoint: string;
  /** `unit`: the user systemd unit to start on demand. */
  unit: string;
  /** The model id to ask that endpoint for; blank means the endpoint's own default. */
  model: string;
  /**
   * The name of the credential, never the credential. Hosted endpoints need a key; a key in a
   * settings file that the renderer reads is a key in a log, a screenshot and a bug report.
   */
  credentialRef: string;
}

export const emptyBinding = (generatorId: string): GeneratorBinding => ({
  generatorId,
  enabled: false,
  endpoint: '',
  unit: '',
  model: '',
  credentialRef: '',
});

/** What is being asked for. Bounded, because a shot's prompt reaches a subprocess argument. */
export interface GeneratorRequest {
  generatorId: string;
  prompt: string;
  /** What to avoid, where the backend supports it. */
  negative: string;
  width: number;
  height: number;
  seconds: number;
  fps: number;
  /** A still to start from, as an absolute path inside the production's own assets. */
  firstFrame?: string;
  /** Fixed for a reproducible take; absent means the backend picks and reports what it used. */
  seed?: number;
}

export type GeneratorJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface GeneratorJob {
  id: string;
  /** The shot this take belongs to, so a finished file knows where to land. */
  shotId: string;
  productionId: string;
  generatorId: string;
  state: GeneratorJobState;
  /** 0–1 where the backend reports it; -1 where it does not. */
  progress: number;
  request: GeneratorRequest;
  /** Where the finished media landed, once it has. */
  outputPath: string | null;
  /** The seed actually used, which is the difference between a take you can repeat and one you cannot. */
  seed: number | null;
  error: string | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export const PROMPT_LIMIT = 4_000;
/** Past this a request is a mistake, not an ambition: no open checkpoint renders ten minutes. */
export const MAX_SECONDS = 120;
export const MAX_EDGE = 4_096;

const str = (value: unknown, limit: number): string => (typeof value === 'string' ? value.trim().slice(0, limit) : '');
const clamp = (value: unknown, low: number, high: number, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), low), high);
};

export function normalizeRequest(value: unknown): GeneratorRequest | null {
  const source = (value && typeof value === 'object' ? value : null) as Partial<GeneratorRequest> | null;
  if (!source) return null;
  const generatorId = str(source.generatorId, 64);
  const prompt = str(source.prompt, PROMPT_LIMIT);
  if (!generatorId || !prompt) return null;
  const request: GeneratorRequest = {
    generatorId,
    prompt,
    negative: str(source.negative, PROMPT_LIMIT),
    // Multiples of 8: every one of these pipelines has a VAE stride, and a stray 1023 is either
    // rejected deep in the graph or silently rounded somewhere the person cannot see.
    width: clamp(source.width, 64, MAX_EDGE, 1280) & ~7,
    height: clamp(source.height, 64, MAX_EDGE, 720) & ~7,
    seconds: clamp(source.seconds, 1, MAX_SECONDS, 5),
    fps: clamp(source.fps, 1, 120, 24),
  };
  const firstFrame = str(source.firstFrame, 1024);
  if (firstFrame) request.firstFrame = firstFrame;
  if (typeof source.seed === 'number' && Number.isFinite(source.seed)) {
    // Magnitude first, then truncate: flooring a negative first rounds away from zero, so -7.9
    // would become 8 and a seed somebody wrote down would not reproduce their take.
    request.seed = Math.floor(Math.abs(source.seed)) % 2 ** 31;
  }
  return request;
}

/**
 * Trim a request to what the generator can do, and say what was changed.
 *
 * Returns the notes rather than throwing: someone who asked for 2K from a 768p model wants the
 * render, and wants to be told it came out at 768p. Refusing outright would be correct and
 * useless.
 */
export function fitRequest(
  request: GeneratorRequest,
  capabilities: GeneratorCapabilities
): { request: GeneratorRequest; notes: string[] } {
  const notes: string[] = [];
  const fitted = { ...request };
  if (fitted.width > capabilities.maxWidth || fitted.height > capabilities.maxHeight) {
    // Scaled rather than cropped: the framing is the person's, the resolution is the model's.
    const scale = Math.min(capabilities.maxWidth / fitted.width, capabilities.maxHeight / fitted.height);
    const width = Math.max(64, Math.floor((fitted.width * scale) / 8) * 8);
    const height = Math.max(64, Math.floor((fitted.height * scale) / 8) * 8);
    notes.push(`Rendered at ${width}×${height}: this generator tops out at ${capabilities.maxWidth}×${capabilities.maxHeight}.`);
    fitted.width = width;
    fitted.height = height;
  }
  if (fitted.seconds > capabilities.maxSeconds) {
    notes.push(`Shortened to ${capabilities.maxSeconds}s: this generator cannot make a longer clip in one pass.`);
    fitted.seconds = capabilities.maxSeconds;
  }
  if (fitted.fps !== capabilities.fps) {
    notes.push(`Rendered at ${capabilities.fps}fps, the rate this generator was trained at.`);
    fitted.fps = capabilities.fps;
  }
  if (fitted.firstFrame && !capabilities.imageToVideo) {
    notes.push('This generator cannot start from a still, so the reference frame was left out.');
    delete fitted.firstFrame;
  }
  return { request: fitted, notes };
}

export function normalizeBinding(value: unknown, generatorId: string): GeneratorBinding {
  const source = (value && typeof value === 'object' ? value : {}) as Partial<GeneratorBinding>;
  return {
    generatorId,
    enabled: source.enabled === true,
    endpoint: str(source.endpoint, 512),
    unit: str(source.unit, 128),
    model: str(source.model, 256),
    credentialRef: str(source.credentialRef, 128),
  };
}

/**
 * Why a generator cannot be used right now, or null when it can.
 *
 * One function so the composer, the queue and the shot panel all refuse for the same reasons and
 * in the same words.
 */
export function bindingProblem(spec: GeneratorSpec, binding: GeneratorBinding | undefined): string | null {
  if (!binding || !binding.enabled) return `${spec.name} is not switched on. Set it up in this universe's settings.`;
  if (spec.adapter === 'unit') {
    return binding.unit ? null : `${spec.name} has no service configured to start.`;
  }
  if (!binding.endpoint) return `${spec.name} has no endpoint configured.`;
  try {
    const url = new URL(binding.endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${spec.name}'s endpoint must be http or https.`;
  } catch {
    return `${spec.name}'s endpoint is not a valid address.`;
  }
  return null;
}
