import type { ProviderConfig } from '../types';
import { AnthropicMessagesProvider } from './anthropicMessages';
import { BaseProvider } from './base';
import { OpenAICompatibleProvider, type PreparedProviderConnection } from './openai';
import { OpenAIResponsesProvider } from './openaiResponses';

export type PrepareProvider = (providerId: string, modelId?: string, signal?: AbortSignal) => Promise<PreparedProviderConnection | void>;

/**
 * The live registry of configured sources. Persistence belongs to the main process
 * (src/main/sourceStore.ts); this class only turns configs into callable providers.
 */
export class ProviderManager {
  private providers = new Map<string, BaseProvider>();
  private configs = new Map<string, ProviderConfig>();
  /**
   * Requests in flight per source. Kept here rather than on a provider, because re-saving a source
   * replaces its provider object while a stream on the old one is still running.
   */
  private active = new Map<string, number>();
  private prepareProvider: PrepareProvider | null = null;

  static fromConfigs(configs: ProviderConfig[]): ProviderManager {
    const manager = new ProviderManager();
    configs.forEach((config) => manager.addConfig(config));
    return manager;
  }

  addConfig(config: ProviderConfig) {
    const track = () => this.begin(config.id);
    const prepare = (modelId?: string, signal?: AbortSignal) => (this.prepareProvider ? this.prepareProvider(config.id, modelId, signal) : Promise.resolve());
    const protocol = config.protocol ?? 'openai-chat';
    let provider: BaseProvider;
    switch (protocol) {
      case 'openai-chat':
        provider = new OpenAICompatibleProvider(config, track, prepare);
        break;
      case 'openai-responses':
        provider = new OpenAIResponsesProvider(config, track, prepare);
        break;
      case 'anthropic-messages':
        provider = new AnthropicMessagesProvider(config, track, prepare);
        break;
      default:
        // Stored JSON and IPC are runtime input. Only *absence* means the legacy chat adapter;
        // an unknown explicit value must not silently send a credential/body to the wrong API.
        throw new Error(`Unsupported inference wire protocol: ${String(protocol)}`);
    }
    this.providers.set(config.id, provider);
    this.configs.set(config.id, config);
  }

  /**
   * Run immediately before any request leaves this process. App-managed local sources use this to
   * start lazily and return their per-process credentials; other sources simply return nothing.
   */
  usePrepareProvider(prepare: PrepareProvider): void {
    this.prepareProvider = prepare;
  }

  /** Prepare a selected source before its first request, without sending model input. */
  async prepare(id: string): Promise<PreparedProviderConnection | void> {
    // Model selection is itself a managed-source transition. Reserve the destination while its
    // lifecycle hook runs so a request for the other managed source cannot slip between the busy
    // check and the stop/start operations and leave both runtimes active.
    const end = this.begin(id);
    try {
      return await (this.prepareProvider?.(id) ?? Promise.resolve());
    } finally {
      end();
    }
  }

  private begin(id: string): () => void {
    this.active.set(id, (this.active.get(id) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.active.get(id) ?? 1) - 1;
      if (left > 0) this.active.set(id, left);
      else this.active.delete(id);
    };
  }

  /** True while a completion or stream is open against this source. */
  busy(id: string): boolean {
    return (this.active.get(id) ?? 0) > 0;
  }

  /** True while any source is preparing, completing, or streaming. */
  anyBusy(): boolean {
    return this.active.size > 0;
  }

  getConfig(id: string): ProviderConfig | undefined {
    return this.configs.get(id);
  }

  getProvider(id: string): BaseProvider | undefined {
    return this.providers.get(id);
  }

  removeProvider(id: string): boolean {
    this.configs.delete(id);
    return this.providers.delete(id);
  }

  listProviders(): ProviderConfig[] {
    return Array.from(this.configs.values());
  }
}
