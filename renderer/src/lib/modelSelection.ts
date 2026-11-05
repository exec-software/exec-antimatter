import type { Model, ProviderConfig } from '../types';

export interface ConversationModelPin {
  providerId?: string;
  modelId?: string;
}

export interface ModelSelection {
  provider?: ProviderConfig;
  model?: Model;
  unavailableReason?: string;
}

/**
 * Resolve the exact source/model a conversation is pinned to.
 *
 * A thread pin is a trust boundary, not a preference: if that BYOK source or model disappears,
 * silently sending its transcript to another provider is both surprising and a data disclosure.
 * Only an unpinned/new conversation may fall back to the current global choice or first source.
 */
export function resolveConversationModel(
  providers: ProviderConfig[],
  activeProviderId: string,
  activeModelId: string,
  pin: ConversationModelPin | null
): ModelSelection {
  const pinnedProviderId = pin?.providerId;
  const provider = pinnedProviderId
    ? providers.find((candidate) => candidate.id === pinnedProviderId)
    : providers.find((candidate) => candidate.id === activeProviderId) ?? providers[0];

  if (!provider) {
    return {
      unavailableReason: pinnedProviderId
        ? `This conversation's source is unavailable. Choose a model in Models to continue.`
        : 'No inference source is configured. Add one in Models to continue.',
    };
  }

  const pinnedModelId = pin?.modelId;
  const preferredModelId = pinnedModelId ?? (provider.id === activeProviderId ? activeModelId : '');
  const model = preferredModelId
    ? provider.models.find((candidate) => candidate.id === preferredModelId)
    : provider.models[0];

  if (!model) {
    return {
      provider,
      unavailableReason: pinnedModelId
        ? `This conversation's model is unavailable from ${provider.name}. Choose a model in Models to continue.`
        : `${provider.name} has no configured models. Add or declare one in Models to continue.`,
    };
  }

  return { provider, model };
}
