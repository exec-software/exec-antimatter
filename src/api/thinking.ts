import type { ChatRequest, ProviderConfig, ThinkingLevel } from './types';

// Wire references: https://developers.openai.com/api/docs/guides/reasoning
// https://platform.claude.com/docs/en/build-with-claude/extended-thinking
// https://docs.ollama.com/api/openai-compatibility
// llama.cpp's pinned b11223 server-common.cpp parses reasoning_budget_tokens (not reasoning_budget).
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['default', 'off', 'low', 'medium', 'high'];
export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);

type Source = Pick<ProviderConfig, 'kind' | 'protocol'>;
type Mechanism = 'none' | 'effort' | 'llama-budget' | 'anthropic-budget' | 'anthropic-adaptive';
export interface ThinkingSupport {
  levels: readonly ThinkingLevel[];
  mechanism: Mechanism;
  description: string;
}
const disabled = (description: string): ThinkingSupport => ({ levels: ['default'], mechanism: 'none', description });
const levels = (off: boolean): readonly ThinkingLevel[] => off
  ? ['default', 'off', 'low', 'medium', 'high'] : ['default', 'low', 'medium', 'high'];

/** Conservative capability map: a protocol alone is not evidence that a model can think. */
export function thinkingSupport(source: Source, modelId: string): ThinkingSupport {
  const model = modelId.toLowerCase().replace(/_/g, '-');
  const protocol = source.protocol ?? 'openai-chat';
  if (source.kind === 'beholdd') return disabled('This runtime does not expose a per-request thinking control.');
  if (protocol === 'anthropic-messages') {
    const adaptive = /claude[-.](?:opus|sonnet)[-.](?:4[-.][6-9]|5)|claude[-.](?:mythos|fable)/.test(model);
    const manual = /claude[-.](?:3[-.]7[-.]sonnet|(?:opus|sonnet|haiku)[-.]4|(?:opus|sonnet)[-.]4[-.]?[015])/.test(model);
    if (!adaptive && !manual) return disabled('No supported thinking control is known for this model.');
    const alwaysOn = /claude[-.](?:mythos|fable)/.test(model);
    return { levels: levels(!alwaysOn), mechanism: adaptive ? 'anthropic-adaptive' : 'anthropic-budget',
      description: adaptive ? 'Controls adaptive reasoning effort.' : 'Sets a thinking token budget within the maximum reply.' };
  }
  const gptOss = /gpt-oss/.test(model);
  const openAI = /(?:^|\/)(?:o[134](?:-|$)|gpt-[56](?:[.-]|$))/.test(model) && !/chat-latest/.test(model);
  if (openAI || gptOss) {
    if (/o1-(?:mini|preview)/.test(model)) return disabled('This model does not expose a reasoning effort setting.');
    const canDisable = source.kind === 'ollama' || (!gptOss && /gpt-5\.[1-9]/.test(model));
    // Dedicated pro models may reject low/medium. Leave their provider default alone.
    if (/-pro(?:-|$)/.test(model)) return disabled('This model uses its provider-managed reasoning mode.');
    return { levels: levels(canDisable), mechanism: 'effort', description: 'Controls the model’s native reasoning effort.' };
  }
  const localThinking = /qwen3|qwq|deepseek[-.]r1|deepseek[-.]v[34][-.][12]|deepseek[-.]v4|glm[-.]4[-.][567]|glm[-.]5|nemotron|mimo|openmythos|kimi[-.]k2[-.]thinking|seed[-.]oss/.test(model)
    && !/coder|instruct|non[-_]?thinking/.test(model);
  if (localThinking && source.kind === 'llama-cpp' && protocol === 'openai-chat') {
    return { levels: levels(true), mechanism: 'llama-budget', description: 'Low, medium, and high allow up to 1k, 4k, and 8k thinking tokens, within the maximum reply.' };
  }
  if (localThinking && source.kind === 'ollama') {
    return { levels: levels(true), mechanism: 'effort', description: 'Uses Ollama’s thinking control. Models with an on/off switch treat low, medium, and high as enabled.' };
  }
  return disabled('No supported thinking control is known for this source and model.');
}

/** Provider controls are optional: default and unsupported selections leave the wire body alone. */
export function thinkingParameters(source: Source, request: Pick<ChatRequest, 'model' | 'thinkingLevel' | 'maxTokens'>): Record<string, unknown> {
  const level = request.thinkingLevel ?? 'default';
  const support = thinkingSupport(source, request.model);
  if (level === 'default' || !support.levels.includes(level)) return {};
  if (support.mechanism === 'effort') {
    const effort = level === 'off' ? 'none' : level;
    return source.protocol === 'openai-responses' ? { reasoning: { effort } } : { reasoning_effort: effort };
  }
  if (support.mechanism === 'anthropic-adaptive') {
    return level === 'off' ? { thinking: { type: 'disabled' } }
      : { thinking: { type: 'adaptive' }, output_config: { effort: level } };
  }
  if (support.mechanism === 'anthropic-budget') {
    if (level === 'off') return { thinking: { type: 'disabled' } };
    const ceiling = (request.maxTokens ?? 4096) - 1;
    if (ceiling < 1024) throw new Error('This model needs a maximum reply of at least 1,025 tokens to enable thinking.');
    const budget = Math.min({ low: 1024, medium: 4096, high: 8192 }[level], ceiling);
    return { thinking: { type: 'enabled', budget_tokens: budget } };
  }
  if (support.mechanism === 'llama-budget') {
    const budget = level === 'off' ? 0 : Math.min({ low: 1024, medium: 4096, high: 8192 }[level], Math.max(0, (request.maxTokens ?? 4096) - 1));
    return { reasoning_budget_tokens: budget, ...(level === 'off' ? { reasoning_effort: 'none' } : {}), chat_template_kwargs: { enable_thinking: level !== 'off' } };
  }
  return {};
}
