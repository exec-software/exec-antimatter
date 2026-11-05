import { OpenAICompatibleProvider } from '../../src/api/providers/openai';

// Observe the real provider's final budget input and serializer. The original function remains
// the sole admission authority; this hook neither modifies the request nor suppresses errors.
const prototype = OpenAICompatibleProvider.prototype as any;
const originalBody = prototype.body;
prototype.body = function (request: unknown, stream: boolean) {
  const state = (globalThis as any).__hagProductionSmoke;
  const record: any = { phase: state.phase, request: structuredClone(request), stream,
    observedAt: Date.now(), sourceId: this.config.id };
  state.providerBodies.push(record);
  try {
    const body = originalBody.call(this, request, stream);
    record.accepted = true; record.wire = structuredClone(body);
    return body;
  } catch (error) {
    record.accepted = false; record.error = String((error as Error).message);
    const input = request as any;
    // Explicitly diagnostic, never sent: use the SAME production wireMessages method, not a
    // copied serializer. No-tools Beholdd uses max_tokens; the inspector can bind these bytes.
    record.refusedWireForInspection = { model: input.model, messages: this.wireMessages(input.messages),
      ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }), stream,
      ...(input.tools?.length ? { tools: input.tools } : {}) };
    record.refusedWireProvenance = 'production OpenAICompatibleProvider.wireMessages; no network dispatch';
    throw error;
  }
};

// require is intentionally after the observer is installed. The bundled module is unchanged.
require('../../src/main/index');
