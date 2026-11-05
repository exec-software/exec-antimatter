import type { ChatRequest, LivenessCallback, Message, Model, ProviderConfig, StreamCallback, StreamResult } from '../types';
import { withoutReasoningHistory } from '../requestMessages';

export abstract class BaseProvider {
  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  getName(): string {
    return this.config.name;
  }

  getModels(): Model[] {
    return this.config.models;
  }

  /** Project host history before fitting it to this provider's actual wire contract. */
  prepareMessages(request: ChatRequest): Message[] {
    return request.messages.map(withoutReasoningHistory);
  }

  abstract chat(request: ChatRequest, signal?: AbortSignal): Promise<string>;
  abstract stream(
    request: ChatRequest,
    callback: StreamCallback,
    onAlive?: LivenessCallback,
    signal?: AbortSignal
  ): Promise<StreamResult>;
}
