import type { ProviderConfig } from '../api/types';
import type { ModelChoice } from './modelChoice';

/** Choosing a catalog entry has no runtime preparation or model-loading capability. */
export function selectModel(providerId: string, modelId: string, workloadId: unknown, deps: {
  source(id: string): ProviderConfig | undefined;
  hasWorkload(providerId: string, modelId: string, id: string): boolean;
  save(choice: ModelChoice): ModelChoice;
  selected(choice: ModelChoice): void;
}): ModelChoice {
  const source = deps.source(providerId);
  if (!source || (modelId && !source.models.some((model) => model.id === modelId))) {
    throw new Error('Choose a model that is still configured on this source.');
  }
  const workload = typeof workloadId === 'string' && deps.hasWorkload(providerId, modelId, workloadId) ? workloadId : undefined;
  const saved = deps.save({ providerId, modelId, ...(workload ? { workloadId: workload } : {}) });
  deps.selected(saved);
  return saved;
}
