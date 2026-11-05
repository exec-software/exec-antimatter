import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import type { ModelRuntimeProfile, ModelRuntimeProfilePatch, ModelRuntimeProfileState, RuntimeProfileSettings } from '../api/modelRuntimeProfiles';
import { isLocalRuntimeBinding, modelInArgv, validateLocalRuntimeSettings, type LocalRuntimeBinding, type LocalRuntimeServiceManager } from './localRuntimeService';
import { discoverQuantVariants, modelRootFor } from './quantVariants';
import { migratePrivateFile, writePrivateFileAtomic } from './privateState';

interface ProfileRecord {
  sourceId: string;
  modelId: string;
  binding: LocalRuntimeBinding;
  profiles: ModelRuntimeProfile[];
  activeProfileId: string;
  /** Written before changing the engine; cleared only after a verified result is persisted. */
  pendingProfileId?: string;
}
interface StoredProfiles { version: 1; records: ProfileRecord[] }
export interface ModelRuntimeProfileDependencies {
  service: Pick<LocalRuntimeServiceManager, 'discover' | 'inspect' | 'apply' | 'restore'>;
  source(sourceId: string, modelId: string): { baseUrl: string; model: string } | null;
  /** Includes whole chat/agent turns, even between their HTTP requests. */
  busy(sourceId: string): boolean | string;
  onChanged?(event: { sourceId: string; modelId: string }): void;
}

const MAX_RECORDS = 100;
const MAX_PROFILES = 24;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const clone = <T>(value: T): T => structuredClone(value);
const key = (sourceId: string, modelId: string): string => JSON.stringify([sourceId, modelId]);
const identifier = (value: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('The model or profile identity is invalid.');
  return value;
};
const name = (value: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('A profile name must contain 1–100 characters without control characters.');
  return value.trim();
};
export function validateRuntimeProfileSettings(value: RuntimeProfileSettings): RuntimeProfileSettings {
  return validateLocalRuntimeSettings(value);
}
// modelPath participates: a profile that differs only by quantization is a different profile, and
// comparing without it would report a pending quant switch as already satisfied.
const sameSettings = (a: RuntimeProfileSettings, b: RuntimeProfileSettings): boolean =>
  a.contextTokens === b.contextTokens && a.parallel === b.parallel && (a.modelPath ?? null) === (b.modelPath ?? null);
const endpoint = (value: string): string => {
  const url = new URL(value);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return `${url.origin}${url.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '')}`;
};
const explain = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Named engine configurations are separate from backend model IDs, routing roles, and prompt
 * preferences. The original service binding never changes; applying its baseline restores it.
 */
export class ModelRuntimeProfileStore {
  private stored: StoredProfiles;
  private operation: { sourceId: string; modelId: string; kind: 'capture' | 'apply' } | null = null;
  private epoch = 0;
  private readonly verified = new Map<string, RuntimeProfileSettings>();
  private readonly uncertain = new Map<string, string>();
  private readonly listeners = new Set<(event: { sourceId: string; modelId: string }) => void>();

  constructor(private readonly path: string, private readonly dependencies: ModelRuntimeProfileDependencies) {
    this.stored = this.load();
  }

  subscribe(listener: (event: { sourceId: string; modelId: string }) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  private changed(sourceId: string, modelId: string): void {
    for (const listener of [this.dependencies.onChanged, ...this.listeners]) {
      if (!listener) continue;
      try { listener({ sourceId, modelId }); } catch (error) { console.error('[runtime-profiles] change listener failed:', error); }
    }
  }

  private load(): StoredProfiles {
    if (!existsSync(this.path)) return { version: 1, records: [] };
    try {
      const stats = lstatSync(this.path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_STORE_BYTES) throw new Error('Invalid store file.');
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoredProfiles;
      if (parsed.version !== 1 || !Array.isArray(parsed.records) || parsed.records.length > MAX_RECORDS) throw new Error('Invalid profile store.');
      const keys = new Set<string>();
      const records = parsed.records.map((record): ProfileRecord => {
        identifier(record.sourceId); identifier(record.modelId);
        if (!isLocalRuntimeBinding(record.binding) || record.binding.sourceId !== record.sourceId || record.binding.model !== record.modelId ||
            !Array.isArray(record.profiles) || record.profiles.length < 1 || record.profiles.length > MAX_PROFILES) throw new Error('Invalid service binding.');
        const identity = key(record.sourceId, record.modelId);
        if (keys.has(identity)) throw new Error('Duplicate profile record.');
        keys.add(identity);
        const ids = new Set<string>();
        const profiles = record.profiles.map((profile): ModelRuntimeProfile => {
          identifier(profile.id);
          if (ids.has(profile.id) || typeof profile.baseline !== 'boolean' || !Number.isFinite(profile.createdAt) || !Number.isFinite(profile.updatedAt)) throw new Error('Invalid profile.');
          ids.add(profile.id);
          return { id: profile.id, name: name(profile.name), ...validateRuntimeProfileSettings(profile),
            baseline: profile.baseline, createdAt: profile.createdAt, updatedAt: profile.updatedAt };
        });
        const baselines = profiles.filter((profile) => profile.baseline);
        if (baselines.length !== 1 || !sameSettings(baselines[0], record.binding.baseline) || !ids.has(record.activeProfileId) ||
            (record.pendingProfileId !== undefined && !ids.has(record.pendingProfileId))) throw new Error('Invalid baseline or selection.');
        return { sourceId: record.sourceId, modelId: record.modelId, binding: clone(record.binding), profiles, activeProfileId: record.activeProfileId,
          ...(record.pendingProfileId ? { pendingProfileId: record.pendingProfileId } : {}) };
      });
      migratePrivateFile(this.path);
      return { version: 1, records };
    } catch {
      throw new Error('Saved engine profiles could not be read. Their file was left unchanged.');
    }
  }

  private commit(record: ProfileRecord): void {
    const records = this.stored.records.filter((candidate) => key(candidate.sourceId, candidate.modelId) !== key(record.sourceId, record.modelId));
    records.push(clone(record));
    if (records.length > MAX_RECORDS) throw new Error('Too many models have saved engine profiles.');
    const next: StoredProfiles = { version: 1, records };
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error('Engine profile storage is full.');
    writePrivateFileAtomic(this.path, serialized);
    this.stored = next;
    this.epoch += 1;
  }

  private find(sourceId: string, modelId: string): ProfileRecord | undefined {
    identifier(sourceId); identifier(modelId);
    return this.stored.records.find((record) => record.sourceId === sourceId && record.modelId === modelId);
  }

  private required(sourceId: string, modelId: string): ProfileRecord {
    const record = this.find(sourceId, modelId);
    if (!record) throw new Error('Capture this model’s current engine configuration first.');
    return record;
  }

  private source(sourceId: string, modelId: string, binding?: LocalRuntimeBinding) {
    const source = this.dependencies.source(sourceId, modelId);
    if (!source || source.model !== modelId) throw new Error('This source no longer serves the selected model.');
    if (binding && endpoint(source.baseUrl) !== endpoint(binding.endpoint)) throw new Error('This source changed endpoints. Its saved engine profiles cannot control the new endpoint.');
    return { sourceId, baseUrl: source.baseUrl, model: source.model };
  }

  private otherRegistration(sourceId: string, modelId: string, baseUrl: string): ProfileRecord | undefined {
    const address = endpoint(baseUrl);
    return this.stored.records.find((record) => record.sourceId !== sourceId && record.modelId === modelId && endpoint(record.binding.endpoint) === address);
  }

  private idle(sourceId: string): void {
    const busy = this.dependencies.busy(sourceId);
    if (busy) throw new Error(typeof busy === 'string' ? busy : 'Wait for active chats and agents to finish before switching engine profiles.');
  }

  isApplying(sourceId?: string): boolean {
    return this.operation?.kind === 'apply' && (sourceId === undefined || this.operation.sourceId === sourceId);
  }

  /** The persisted last-verified limit protects the first turn after an app restart. */
  contextLimit(sourceId: string, modelId: string): number | null {
    if (this.isApplying()) throw new Error('This model’s engine profile is switching. Wait for it to finish.');
    const direct = this.find(sourceId, modelId);
    const source = this.dependencies.source(sourceId, modelId);
    if (direct) this.source(sourceId, modelId, direct.binding);
    if (!source || source.model !== modelId) return null;
    let address: string;
    try { address = endpoint(source.baseUrl); } catch { return null; }
    // Source IDs are catalog labels, not engine isolation. Two labels pointing to the same
    // serving model share its budget and recovery state, including before the first UI refresh.
    const records = this.stored.records.filter((record) => record.modelId === modelId && endpoint(record.binding.endpoint) === address);
    if (!records.length) return null;
    const limits = records.map((record) => {
      const identity = key(record.sourceId, record.modelId);
      const unsafe = this.uncertain.get(identity);
      if (unsafe) throw new Error(unsafe);
      const persisted = record.profiles.find((profile) => profile.id === record.activeProfileId)!;
      const pending = record.profiles.find((profile) => profile.id === record.pendingProfileId);
      const live = this.verified.get(identity);
      return Math.min(persisted.contextTokens, pending?.contextTokens ?? persisted.contextTokens, live?.contextTokens ?? persisted.contextTokens);
    });
    return Math.min(...limits);
  }

  private withoutPending(record: ProfileRecord, activeProfileId = record.activeProfileId): ProfileRecord {
    const { pendingProfileId: _pending, ...settled } = record;
    return { ...settled, activeProfileId };
  }

  private reconcilePending(record: ProfileRecord, actual: RuntimeProfileSettings): ProfileRecord {
    if (!record.pendingProfileId) return record;
    const previous = record.profiles.find((profile) => profile.id === record.activeProfileId)!;
    const pending = record.profiles.find((profile) => profile.id === record.pendingProfileId)!;
    const matched = sameSettings(actual, pending) ? pending : sameSettings(actual, previous) ? previous : null;
    if (!matched) throw new Error('An interrupted profile switch does not match either saved configuration. Restore Straight shot before starting another turn.');
    const settled = this.withoutPending(record, matched.id);
    this.commit(settled);
    this.changed(record.sourceId, record.modelId);
    return settled;
  }

  private publicState(sourceId: string, modelId: string, support: { supported: boolean; recoveryOnly?: boolean; reason?: string }): ModelRuntimeProfileState {
    const record = this.find(sourceId, modelId);
    const actual = this.verified.get(key(sourceId, modelId)) ?? null;
    const selected = record?.profiles.find((profile) => profile.id === record.activeProfileId);
    return { sourceId, modelId, ...support, captured: !!record, busy: !!this.dependencies.busy(sourceId),
      applying: this.isApplying(sourceId), profiles: clone(record?.profiles ?? []),
      activeProfileId: selected && !record?.pendingProfileId && !this.uncertain.has(key(sourceId, modelId)) && (!actual || sameSettings(selected, actual)) ? selected.id : null,
      actual: actual ? clone(actual) : null,
      quantizations: this.quantizations(record) };
  }

  /**
   * Quantizations beside the service's own weights. Anchored on the BASELINE command rather than
   * on whatever is serving now, so switching to Q4_K does not change what the card offers next
   * time. Discovery touches the disk, so a failure yields no choices rather than an error: a card
   * that cannot enumerate quantizations should simply not offer the control.
   */
  private quantizations(record: ProfileRecord | undefined) {
    if (!record) return [];
    try {
      const baseline = modelInArgv(record.binding.baselineArgv);
      const root = baseline ? modelRootFor(baseline) : null;
      const found = root ? discoverQuantVariants(root) : [];
      // One quantization is not a choice; offering it invites a pointless restart.
      return found.length > 1 ? found : [];
    } catch {
      return [];
    }
  }

  async state(sourceId: string, modelId: string): Promise<ModelRuntimeProfileState> {
    const record = this.find(sourceId, modelId);
    if (this.isApplying(sourceId)) return this.publicState(sourceId, modelId, { supported: true });
    const identity = key(sourceId, modelId);
    const epoch = this.epoch;
    let sourceMatches = false;
    try {
      const source = this.source(sourceId, modelId, record?.binding);
      sourceMatches = true;
      if (!record) {
        const registered = this.otherRegistration(sourceId, modelId, source.baseUrl);
        if (registered) return this.publicState(sourceId, modelId, { supported: false,
          reason: `This engine is already registered on source “${registered.sourceId}”. Manage its engine profiles there; this source shares their context limit.` });
      }
      if (record) {
        const actual = validateRuntimeProfileSettings(await this.dependencies.service.inspect(clone(record.binding)));
        if (epoch !== this.epoch) return this.publicState(sourceId, modelId, { supported: true });
        const reconciled = this.reconcilePending(record, actual);
        this.verified.set(identity, actual);
        this.uncertain.delete(identity);
        const active = reconciled.profiles.find((profile) => profile.id === reconciled.activeProfileId)!;
        return this.publicState(sourceId, modelId, { supported: true,
          ...(!sameSettings(actual, active) ? { reason: 'The engine settings changed outside these saved profiles. Apply a saved profile to restore it.' } : {}) });
      }
      const binding = await this.dependencies.service.discover(source);
      if (epoch !== this.epoch) return this.publicState(sourceId, modelId, { supported: true });
      if (!binding) return this.publicState(sourceId, modelId, { supported: false, reason: 'No supported local llama.cpp user service was found for this model.' });
      this.verified.set(identity, validateRuntimeProfileSettings(binding.baseline));
      return this.publicState(sourceId, modelId, { supported: true });
    } catch (error) {
      if (epoch !== this.epoch) return this.publicState(sourceId, modelId, { supported: true });
      this.verified.delete(identity);
      if (record) this.uncertain.set(identity, `This engine’s saved configuration could not be verified: ${explain(error)} Open its engine profiles and refresh before starting a turn.`);
      return this.publicState(sourceId, modelId, { supported: !!record && sourceMatches,
        ...(record && sourceMatches ? { recoveryOnly: true } : {}), reason: explain(error) });
    }
  }

  private begin(sourceId: string, modelId: string, kind: 'capture' | 'apply'): void {
    if (this.operation) throw new Error('Another engine profile operation is in progress. Wait for it to finish.');
    this.idle(sourceId);
    this.operation = { sourceId, modelId, kind };
    this.epoch += 1;
    this.changed(sourceId, modelId);
  }

  async capture(sourceId: string, modelId: string): Promise<ModelRuntimeProfileState> {
    if (this.find(sourceId, modelId)) return this.state(sourceId, modelId);
    this.begin(sourceId, modelId, 'capture');
    try {
      const source = this.source(sourceId, modelId);
      const registered = this.otherRegistration(sourceId, modelId, source.baseUrl);
      if (registered) throw new Error(`This engine is already registered on source “${registered.sourceId}”. Manage its engine profiles there.`);
      const binding = await this.dependencies.service.discover(source);
      if (!binding) throw new Error('No supported local llama.cpp user service was found for this model.');
      if (!isLocalRuntimeBinding(binding) || binding.sourceId !== sourceId || binding.model !== modelId) throw new Error('The local service did not match this source and model.');
      this.source(sourceId, modelId, binding); this.idle(sourceId);
      const settings = validateRuntimeProfileSettings(binding.baseline);
      const at = Date.now();
      const baseline: ModelRuntimeProfile = { id: randomUUID(), name: 'Straight shot', ...settings, baseline: true, createdAt: at, updatedAt: at };
      const orchestration: ModelRuntimeProfile = { id: randomUUID(), name: 'Orchestration', contextTokens: Math.min(32768, settings.contextTokens), parallel: 2, baseline: false, createdAt: at, updatedAt: at };
      this.commit({ sourceId, modelId, binding: clone(binding), profiles: [baseline, orchestration], activeProfileId: baseline.id });
      this.verified.set(key(sourceId, modelId), settings);
      return this.publicState(sourceId, modelId, { supported: true });
    } finally { this.operation = null; this.epoch += 1; this.changed(sourceId, modelId); }
  }

  async copy(sourceId: string, modelId: string, profileId: string): Promise<ModelRuntimeProfileState> {
    if (this.operation) throw new Error('Wait for the current engine profile operation to finish.');
    if (this.uncertain.has(key(sourceId, modelId))) throw new Error('Restore or refresh the engine before managing its profiles.');
    const record = this.required(sourceId, modelId);
    this.source(sourceId, modelId, record.binding);
    const profile = record.profiles.find((entry) => entry.id === identifier(profileId));
    if (!profile) throw new Error('That engine profile no longer exists.');
    if (record.profiles.length >= MAX_PROFILES) throw new Error('This model already has 24 engine profiles.');
    const at = Date.now();
    const copied = { ...profile, id: randomUUID(), name: `${profile.name.slice(0, 95)} copy`, baseline: false, createdAt: at, updatedAt: at };
    this.commit({ ...record, profiles: [...record.profiles, copied] });
    this.changed(sourceId, modelId);
    return this.publicState(sourceId, modelId, { supported: true });
  }

  async update(sourceId: string, modelId: string, profileId: string, patch: ModelRuntimeProfilePatch): Promise<ModelRuntimeProfileState> {
    if (this.operation) throw new Error('Wait for the current engine profile operation to finish.');
    if (this.uncertain.has(key(sourceId, modelId))) throw new Error('Restore or refresh the engine before managing its profiles.');
    const record = this.required(sourceId, modelId);
    this.source(sourceId, modelId, record.binding);
    const profile = record.profiles.find((entry) => entry.id === identifier(profileId));
    if (!profile) throw new Error('That engine profile no longer exists.');
    if (profile.baseline) throw new Error('The original Straight shot profile is immutable. Copy it to make changes.');
    if (profile.id === record.activeProfileId) throw new Error('Copy the active profile or switch to another profile before editing it.');
    if (profile.id === record.pendingProfileId) throw new Error('Refresh or restore the interrupted profile switch before editing that profile.');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('The engine profile changes are invalid.');
    const updated: ModelRuntimeProfile = { ...profile, name: patch.name === undefined ? profile.name : name(patch.name),
      ...validateRuntimeProfileSettings({
        contextTokens: patch.contextTokens ?? profile.contextTokens,
        parallel: patch.parallel ?? profile.parallel,
        // undefined leaves the profile's own choice alone; null clears it.
        ...(patch.modelPath === undefined
          ? (profile.modelPath === undefined ? {} : { modelPath: profile.modelPath })
          : (patch.modelPath === null ? {} : { modelPath: patch.modelPath })),
      }), updatedAt: Date.now() };
    this.commit({ ...record, profiles: record.profiles.map((entry) => entry.id === profileId ? updated : entry) });
    this.changed(sourceId, modelId);
    return this.publicState(sourceId, modelId, { supported: true });
  }

  async remove(sourceId: string, modelId: string, profileId: string): Promise<ModelRuntimeProfileState> {
    if (this.operation) throw new Error('Wait for the current engine profile operation to finish.');
    if (this.uncertain.has(key(sourceId, modelId))) throw new Error('Restore or refresh the engine before managing its profiles.');
    const record = this.required(sourceId, modelId);
    this.source(sourceId, modelId, record.binding);
    const profile = record.profiles.find((entry) => entry.id === identifier(profileId));
    if (!profile) throw new Error('That engine profile no longer exists.');
    if (profile.baseline) throw new Error('The original Straight shot profile cannot be removed.');
    if (profile.id === record.activeProfileId) throw new Error('Switch to another profile before removing the active profile.');
    if (profile.id === record.pendingProfileId) throw new Error('Refresh or restore the interrupted profile switch before removing that profile.');
    this.commit({ ...record, profiles: record.profiles.filter((entry) => entry.id !== profile.id) });
    this.changed(sourceId, modelId);
    return this.publicState(sourceId, modelId, { supported: true });
  }

  async apply(sourceId: string, modelId: string, profileId: string): Promise<ModelRuntimeProfileState> {
    let record = this.required(sourceId, modelId);
    this.source(sourceId, modelId, record.binding);
    const profile = record.profiles.find((entry) => entry.id === identifier(profileId));
    if (!profile) throw new Error('That engine profile no longer exists.');
    let previous = record.profiles.find((entry) => entry.id === record.activeProfileId)!;
    const identity = key(sourceId, modelId);
    if (this.uncertain.has(identity) && !profile.baseline) throw new Error('Restore Straight shot or refresh the engine before applying another profile.');
    this.begin(sourceId, modelId, 'apply');
    let changedEngine = false;
    let intentWritten = false;
    try {
      if (record.pendingProfileId) {
        try {
          const actual = validateRuntimeProfileSettings(await this.dependencies.service.inspect(clone(record.binding)));
          record = this.reconcilePending(record, actual);
        }
        catch (error) {
          // The original profile is the recovery path when neither side of a crashed switch
          // matches. Keep its earlier conservative marker until restoration is verified.
          if (!profile.baseline) {
            this.uncertain.set(identity, `The interrupted engine switch must be restored or verified first: ${explain(error)}`);
            throw error;
          }
        }
        previous = record.profiles.find((entry) => entry.id === record.activeProfileId)!;
      }
      this.commit({ ...record, pendingProfileId: record.pendingProfileId ?? profile.id });
      intentWritten = true;
      const result = profile.baseline
        ? await this.dependencies.service.restore(clone(record.binding))
        : await this.dependencies.service.apply(clone(record.binding), validateRuntimeProfileSettings(profile));
      changedEngine = true;
      const verified = validateRuntimeProfileSettings(result);
      if (!sameSettings(verified, profile)) throw new Error('The engine did not report the requested context and parallel slot count.');
      this.source(sourceId, modelId, record.binding);
      this.commit(this.withoutPending(record, profile.id));
      this.verified.set(identity, verified); this.uncertain.delete(identity);
    } catch (error) {
      if (changedEngine) {
        try {
          const restored = previous.baseline
            ? await this.dependencies.service.restore(clone(record.binding))
            : await this.dependencies.service.apply(clone(record.binding), validateRuntimeProfileSettings(previous));
          if (!sameSettings(validateRuntimeProfileSettings(restored), previous)) throw new Error('The previous settings were not restored.');
          this.verified.set(identity, validateRuntimeProfileSettings(restored));
          this.commit(this.withoutPending(record));
        } catch (rollback) {
          this.verified.delete(identity);
          const reason = `Engine profile switching failed and the previous configuration could not be confirmed: ${explain(rollback)}`;
          this.uncertain.set(identity, reason);
          throw new Error(`${explain(error)} ${reason}`);
        }
      }
      // A rejected adapter promise may include a failed engine rollback. Only inspection can
      // establish whether the old budget remains safe; a rejection alone proves nothing.
      if (!changedEngine && intentWritten) {
        try {
          const actual = validateRuntimeProfileSettings(await this.dependencies.service.inspect(clone(record.binding)));
          if (!sameSettings(actual, previous)) throw new Error('The engine no longer matches the previous profile.');
          this.verified.set(identity, actual);
          this.commit(this.withoutPending(record));
        } catch (inspection) {
          this.verified.delete(identity);
          const reason = `The engine configuration could not be confirmed after switching failed: ${explain(inspection)} Refresh its engine profiles before starting another turn.`;
          this.uncertain.set(identity, reason);
        }
      }
      throw error;
    } finally { this.operation = null; this.epoch += 1; this.changed(sourceId, modelId); }
    return this.publicState(sourceId, modelId, { supported: true });
  }
}
