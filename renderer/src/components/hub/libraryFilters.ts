import { modelDeployment, type ModelDeployment } from '../../../../src/api/modelDeployment';
import type { Model, OrchestrationProfileInfo, ProviderConfig } from '../../types';

export interface LibraryEntry { source: ProviderConfig; model: Model }

/** Filtering happens before ranking or pagination, including the selected and resident cards. */
export function filterLibraryEntries(
  providers: readonly ProviderConfig[],
  category: ModelDeployment,
  query = '',
  showHidden = false
): LibraryEntry[] {
  const needle = query.trim().toLowerCase();
  return providers.flatMap((source) => source.models
    .filter((model) => modelDeployment(source, model) === category && (showHidden || !model.hidden))
    .filter((model) => !needle ||
      `${source.name} ${source.kind ?? ''} ${model.name} ${model.id} ${model.architecture ?? ''} ${model.quantization ?? ''}`
        .toLowerCase().includes(needle))
    .map((model) => ({ source, model })));
}

/** Untagged profiles are classified only when their configured bindings provide evidence. */
export function profileDeployment(
  profile: OrchestrationProfileInfo,
  providers: readonly ProviderConfig[]
): ModelDeployment | null {
  if (profile.mode) return profile.mode;
  const categories = new Set<ModelDeployment>();
  const hosts = new Set<string>();
  for (const binding of Object.values(profile.roles)) {
    const matches = providers.flatMap((source) =>
      binding.provider && source.id !== binding.provider ? [] : source.models
        .filter((model) => model.id === binding.model)
        .map((model) => ({ source, category: modelDeployment(source, model) })));
    // A missing binding or the same id served by unlike sources cannot establish a category.
    if (!matches.length || new Set(matches.map((entry) => entry.category)).size !== 1) return null;
    categories.add(matches[0].category);
    try {
      const host = new URL(matches[0].source.baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
      hosts.add(host === 'localhost' || host === '::1' || /^127\./.test(host) ? 'loopback' : host);
    } catch {
      return null;
    }
  }
  if (categories.has('provider')) return categories.size === 1 ? 'provider' : null;
  if (categories.has('distributed') || hosts.size > 1) return 'distributed';
  return categories.has('local') ? 'local' : null;
}
