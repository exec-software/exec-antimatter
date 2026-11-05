/** Where a model runs. Explicit catalog choices take precedence over inferred source details. */
export type ModelDeployment = 'local' | 'distributed' | 'provider';

export const MODEL_DEPLOYMENTS: readonly ModelDeployment[] = ['local', 'distributed', 'provider'];
export const DEPLOYMENT_LABELS: Record<ModelDeployment, string> = {
  local: 'Local',
  distributed: 'Distributed',
  provider: 'Provider',
};

export function isModelDeployment(value: unknown): value is ModelDeployment {
  return value === 'local' || value === 'distributed' || value === 'provider';
}

/** A hosted connector remains a provider even when reached through a local proxy. */
export function sourceDeployment(source: { kind?: string; baseUrl: string }): 'local' | 'provider' {
  if (source.kind === 'openai' || source.kind === 'anthropic' || source.kind === 'opencode-zen') return 'provider';
  if (source.kind === 'beholdd' || source.kind === 'llama-cpp' || source.kind === 'ollama') return 'local';
  try {
    const host = new URL(source.baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return 'local';
  } catch {
    // An unknown or invalid endpoint is never evidence that it runs on this machine.
  }
  return 'provider';
}

export function modelDeployment(
  source: { kind?: string; baseUrl: string },
  model: { deployment?: ModelDeployment },
  hasRecipe = false
): ModelDeployment {
  if (isModelDeployment(model.deployment)) return model.deployment;
  const inferred = sourceDeployment(source);
  return inferred === 'local' && hasRecipe ? 'distributed' : inferred;
}
