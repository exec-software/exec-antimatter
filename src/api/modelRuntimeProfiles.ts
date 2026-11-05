export const MODEL_RUNTIME_PROFILE_LIMITS = {
  minContextTokens: 512,
  maxContextTokens: 2_097_152,
  maxParallel: 16,
  maxTotalContextTokens: 2_097_152,
} as const;

export interface RuntimeProfileSettings {
  /** Context available to each parallel slot. Total configured context is this × parallel. */
  contextTokens: number;
  parallel: number;
  /**
   * Which weights file to serve, when this profile chooses one. Absent means "whatever the
   * service's own command says", which is every profile saved before quantization switching
   * existed. Present re-points `-m`, so one model entry can carry several quantizations instead
   * of needing a card, a source and a port each.
   */
  modelPath?: string;
}

/** One quantization of a model found on disk, offered as a choice on the card. */
export interface QuantVariant {
  /** Label as the file name carries it, e.g. `Q4_K`, `UD-Q2_K_XL`, `BF16`. */
  quant: string;
  /** Absolute path passed as `-m` — shard 1 of a split set. */
  path: string;
  /** Total bytes of every shard, which is what the carveout actually pays. */
  bytes: number;
  /** Declared shard count; 1 for an unsplit file. */
  shards: number;
}

export interface ModelRuntimeProfile extends RuntimeProfileSettings {
  id: string;
  name: string;
  /** The exact original configuration; immutable and restored through its saved service baseline. */
  baseline: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ModelRuntimeProfileState {
  sourceId: string;
  modelId: string;
  supported: boolean;
  /** Inspection failed; only an explicit, independently validated baseline restore is offered. */
  recoveryOnly?: boolean;
  reason?: string;
  captured: boolean;
  busy: boolean;
  applying: boolean;
  profiles: ModelRuntimeProfile[];
  activeProfileId: string | null;
  /** Latest settings verified against the serving engine, or null when not yet verified. */
  actual: RuntimeProfileSettings | null;
  /**
   * Quantizations discovered beside the service's own weights file. Empty when the model's
   * directory holds only the one it is already serving, or cannot be read — a card should then
   * offer no choice rather than an empty dropdown.
   */
  quantizations: QuantVariant[];
}

export interface ModelRuntimeProfilePatch {
  name?: string;
  contextTokens?: number;
  parallel?: number;
  /** A path selects that quantization; null returns the profile to the service's own `-m`. */
  modelPath?: string | null;
}

export interface ModelRuntimeProfilesAPI {
  state(sourceId: string, modelId: string): Promise<ModelRuntimeProfileState>;
  capture(sourceId: string, modelId: string): Promise<ModelRuntimeProfileState>;
  copy(sourceId: string, modelId: string, profileId: string): Promise<ModelRuntimeProfileState>;
  update(sourceId: string, modelId: string, profileId: string, patch: ModelRuntimeProfilePatch): Promise<ModelRuntimeProfileState>;
  remove(sourceId: string, modelId: string, profileId: string): Promise<ModelRuntimeProfileState>;
  apply(sourceId: string, modelId: string, profileId: string): Promise<ModelRuntimeProfileState>;
  onChanged(listener: (event: { sourceId: string; modelId: string }) => void): () => void;
}
