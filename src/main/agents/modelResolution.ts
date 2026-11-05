import type { ProviderConfig } from '../../api/types';

/** The chat/default model remembered by the main process. */
export interface LastModelChoice {
  providerId: string;
  model: string;
}

export interface ResolvedAgentModel {
  source: ProviderConfig;
  model: string;
}

/** A configuration error that should be shown instead of silently choosing another model. */
export class AgentModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentModelResolutionError';
  }
}

const fail = (message: string): never => {
  throw new AgentModelResolutionError(message);
};

const advertises = (source: ProviderConfig, model: string): boolean =>
  source.models.some((candidate) => candidate.id === model);

const sourceDescription = (source: ProviderConfig): string =>
  source.name === source.id ? source.id : `${source.name} [${source.id}]`;

/**
 * Resolves the source/model constraint on an agent or orchestration role.
 *
 * A named source and model are both hard constraints. A legacy short-form role names only a
 * model, so it is safe exactly when one connected source advertises that exact id. Only an
 * entirely unpinned agent may inherit chat's last choice or fall back to the first available
 * catalog entry.
 */
export function resolveAgentModel(
  sources: readonly ProviderConfig[],
  providerName: string | null,
  model: string | null,
  lastUsed: LastModelChoice | null
): ResolvedAgentModel {
  if (providerName) {
    const byId = sources.find((source) => source.id === providerName);
    const byName = byId ? [] : sources.filter((source) => source.name === providerName);
    if (byName.length > 1) {
      fail(
        `Inference source name "${providerName}" is ambiguous (${byName
          .map(sourceDescription)
          .join(', ')}); pin the source id instead.`
      );
    }
    const source = byId ?? byName[0];
    if (!source) return fail(`Pinned inference source "${providerName}" is not configured.`);

    if (model) {
      if (!advertises(source, model)) {
        fail(`Inference source "${sourceDescription(source)}" does not advertise model "${model}".`);
      }
      return { source, model };
    }

    const inherited =
      source.id === lastUsed?.providerId && advertises(source, lastUsed.model) ? lastUsed.model : null;
    const selected = inherited ?? source.models[0]?.id;
    if (!selected) return fail(`Inference source "${sourceDescription(source)}" does not advertise any models.`);
    return { source, model: selected };
  }

  if (model) {
    const matches = sources.filter((source) => advertises(source, model));
    if (matches.length === 0) {
      fail(`No connected inference source advertises model "${model}".`);
    }
    if (matches.length > 1) {
      fail(
        `Model "${model}" is advertised by multiple inference sources (${matches
          .map(sourceDescription)
          .join(', ')}); pin its source.`
      );
    }
    return { source: matches[0], model };
  }

  if (lastUsed) {
    const inherited = sources.find(
      (source) => source.id === lastUsed.providerId && advertises(source, lastUsed.model)
    );
    if (inherited) return { source: inherited, model: lastUsed.model };
  }

  for (const source of sources) {
    const first = source.models[0]?.id;
    if (first) return { source, model: first };
  }
  return fail(
    sources.length ? 'No connected inference source advertises any models.' : 'No inference source is connected.'
  );
}
