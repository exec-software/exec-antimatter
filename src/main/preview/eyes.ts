import type { ProviderConfig } from '../../api/types';
import { probeVision } from '../probe';
import { isLoopbackVisionEndpoint, isVisionEndpoint, type ConfiguredVisionSource } from './vision';

/**
 * Which of the configured sources can be shown a picture.
 *
 * Asked of the servers rather than guessed from model names, because the name is not the fact.
 * `qwen3.6-35b-a3b` can see only when llama-server was started with a projector beside it; the
 * same checkpoint served without one is a text model with a promising name, and a model list
 * cannot tell the two apart. `/props` reports `modalities.vision`, which is true exactly when a
 * projector is loaded, so it tracks the running process.
 *
 * Loopback sources are preferred because they can inspect an image without sending it to another
 * machine. A configured non-loopback source is still eligible when no local source can see, but
 * resolving it does not send the image: the tool policy asks for per-call approval before the
 * workspace file is opened or any pixels are transmitted. URL credentials are not accepted;
 * provider API keys belong in the source's dedicated API-key field.
 */

/**
 * How long a "yes it can see" or "no it cannot" is trusted.
 *
 * Short, deliberately. A projector is loaded by restarting a server, which happens while
 * Antimatter is open — this is a laptop, not a fleet — and a model told once that nothing could
 * see would carry on believing it for the rest of the session. A minute is long enough that a
 * loop of looks does not re-probe on each one.
 */
const TRUST_MS = 60_000;

interface Known {
  at: number;
  source: ConfiguredVisionSource | null;
  configs: string;
}

let cached: Known | null = null;

/** Discards what was learned, for a test or for a source the user has just changed. */
export const forget = (): void => {
  cached = null;
};

/**
 * The model on a source that can take an image.
 *
 * A source's own model list is authoritative: a `vision` capability names the model as well as
 * answering the question, and an explicit absence says not to try it. `/props` is a temporary
 * compatibility fallback for older llama-server sources that publish no per-model capability at
 * all. It describes the one model that server has loaded, so it is only safe for that legacy
 * single-model shape.
 */
async function eyesOn(config: ProviderConfig): Promise<ConfiguredVisionSource | null> {
  const listed = config.models.find((model) => model.vision === true);
  if (listed) {
    return { provider: config.name, baseUrl: config.baseUrl, apiKey: config.apiKey, model: listed.id };
  }

  // Once a source reports capabilities, that report wins in both directions. In particular, do
  // not let a llama-compatible `/props` endpoint turn the first model into a vision model after
  // `/v1/models` explicitly said that its listed models are text-only.
  if (config.models.some((model) => model.vision !== undefined)) return null;

  // `/props` describes the server's one loaded model but does not identify it. Mapping that answer
  // onto the first entry of a multi-model registry would be a guess and can send an image to the
  // wrong model, so the legacy bridge is valid only for the single-model shape it was designed for.
  if (config.models.length !== 1) return null;

  // Compatibility only. Remove this when every supported server publishes per-model capabilities.
  const vision = await probeVision(config.baseUrl, config.apiKey);
  if (!vision) return null;
  const model = config.models[0]?.id;
  if (!model) return null;
  return { provider: config.name, baseUrl: config.baseUrl, apiKey: config.apiKey, model };
}

export async function resolve(configs: ProviderConfig[]): Promise<ConfiguredVisionSource | null> {
  // The pixel-bearing transport below currently emits a Chat Completions multimodal payload.
  // A native Responses or Anthropic source may advertise vision, but selecting it here would send
  // the wrong schema (and, for Anthropic, the wrong auth header). Keep those sources unavailable
  // until each native adapter owns an explicit image payload path.
  const eligible = configs.filter(
    (config) => (config.protocol ?? 'openai-chat') === 'openai-chat' && isVisionEndpoint(config.baseUrl)
  );
  // Preserve order within each group, but never choose a remote source while a configured local
  // one can do the job without image egress.
  const ordered = [
    ...eligible.filter((config) => isLoopbackVisionEndpoint(config.baseUrl)),
    ...eligible.filter((config) => !isLoopbackVisionEndpoint(config.baseUrl)),
  ];
  const signature = JSON.stringify(
    ordered.map((config) => [
      config.id,
      config.name,
      config.baseUrl,
      config.apiKey,
      config.protocol ?? 'openai-chat',
      config.models.map((model) => [model.id, model.vision]),
    ])
  );
  if (cached && cached.configs === signature && Date.now() - cached.at < TRUST_MS) return cached.source;

  for (const config of ordered) {
    try {
      const source = await eyesOn(config);
      if (source) {
        cached = { at: Date.now(), source, configs: signature };
        return source;
      }
    } catch (error) {
      // One unreachable source must not hide a working one further down the list.
      console.error(`[preview] could not ask ${config.name} whether it can see:`, error);
    }
  }

  cached = { at: Date.now(), source: null, configs: signature };
  return null;
}
