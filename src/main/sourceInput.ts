import type { Model, WireProtocol } from '../api/types';
import type { InferenceSource, SourceKind } from './sourceStore';

const SOURCE_KINDS = new Set<SourceKind>([
  'beholdd',
  'llama-cpp',
  'ollama',
  'openai',
  'anthropic',
  'opencode-zen',
  'openai-compatible',
]);
const PROTOCOLS = new Set<WireProtocol>(['openai-chat', 'openai-responses', 'anthropic-messages']);

const KIND_PROTOCOLS: Record<SourceKind, ReadonlySet<WireProtocol>> = {
  beholdd: new Set(['openai-chat']),
  'llama-cpp': new Set(['openai-chat']),
  ollama: new Set(['openai-chat']),
  // Old persisted `openai` sources may still omit a protocol and resolve to chat. A newly added
  // OpenAI connection can explicitly select either API without relabeling historical data.
  openai: new Set(['openai-chat', 'openai-responses']),
  anthropic: new Set(['anthropic-messages']),
  'opencode-zen': new Set(['openai-responses']),
  'openai-compatible': new Set(['openai-chat']),
};

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${what} must be text.`);
  const clean = value.trim();
  if (!clean) throw new Error(`${what} is required.`);
  if (clean.length > max || /[\0\r\n]/.test(clean)) throw new Error(`${what} is not valid.`);
  return clean;
}

function optionalText(value: unknown, what: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return text(value, what, max);
}

function optionalPositiveInteger(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 2_000_000_000) {
    throw new Error(`${what} must be a positive integer.`);
  }
  return Number(value);
}

/** Keep the discovery distinction between an unknown cap and an explicit no-cap observation. */
function optionalExecutionCap(value: unknown, what: string): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${what} must be a positive safe integer or null.`);
  }
  return value;
}

function model(value: unknown, index: number): Model {
  const candidate = record(value, `Model ${index + 1}`);
  const id = text(candidate.id, `Model ${index + 1} id`, 2_048);
  const name = optionalText(candidate.name, `Model ${index + 1} name`, 2_048) ?? id;
  const architecture = optionalText(candidate.architecture, `Model ${index + 1} architecture`, 160);
  const quantization = optionalText(candidate.quantization, `Model ${index + 1} quantization`, 160);
  const contextWindow = optionalPositiveInteger(candidate.contextWindow, `Model ${index + 1} context window`);
  const maxEvaluatedTokens = optionalExecutionCap(candidate.maxEvaluatedTokens, `Model ${index + 1} execution limit`);
  if (candidate.vision !== undefined && typeof candidate.vision !== 'boolean') {
    throw new Error(`Model ${index + 1} vision capability must be true or false.`);
  }
  return {
    id,
    name,
    ...(architecture ? { architecture } : {}),
    ...(quantization ? { quantization } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxEvaluatedTokens !== undefined ? { maxEvaluatedTokens } : {}),
    ...(typeof candidate.vision === 'boolean' ? { vision: candidate.vision } : {}),
  };
}

function endpoint(value: unknown): string {
  const raw = text(value, 'Base URL', 4_096);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Base URL must be a valid http or https URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL must use http or https.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Put credentials in the API-key field, not in the Base URL.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Base URL cannot contain a query string or fragment.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, parsed.pathname === '/' ? '/' : '');
}

function credential(value: unknown, optional: boolean): string | undefined {
  if (optional && (value === undefined || value === '')) return undefined;
  if (
    typeof value !== 'string' ||
    value.length > 65_536 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('API key is not valid.');
  }
  return value;
}

export interface ValidatedProbeInput {
  baseUrl: string;
  apiKey?: string;
  protocol: WireProtocol;
}

export interface ValidatedCredentialUpdate {
  id: string;
  apiKey: string;
}

/** Validates the one-way renderer request used to rotate a stored source credential. */
export function validateCredentialUpdate(value: unknown): ValidatedCredentialUpdate {
  const candidate = record(value, 'Credential update');
  const id = text(candidate.id, 'Source id', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new Error('Source id contains unsupported characters.');
  const apiKey = credential(candidate.apiKey, false);
  if (!apiKey) throw new Error('API key is required.');
  return { id, apiKey };
}

/** Validates the one-shot credential test before main makes a network request for the renderer. */
export function validateProbeInput(value: unknown): ValidatedProbeInput {
  const candidate = record(value, 'Connection test');
  const protocolValue = candidate.protocol ?? 'openai-chat';
  if (typeof protocolValue !== 'string' || !PROTOCOLS.has(protocolValue as WireProtocol)) {
    throw new Error(`Unsupported inference wire protocol: ${String(protocolValue)}`);
  }
  return {
    baseUrl: endpoint(candidate.baseUrl),
    apiKey: credential(candidate.apiKey, true),
    protocol: protocolValue as WireProtocol,
  };
}

/** Runtime validation for the one renderer IPC path that creates a credential-bearing source. */
export function validateNewSource(value: unknown, existingIds: ReadonlySet<string>): InferenceSource {
  const candidate = record(value, 'Inference source');
  const id = text(candidate.id, 'Source id', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new Error('Source id contains unsupported characters.');
  if (existingIds.has(id)) throw new Error(`An inference source with id "${id}" already exists.`);

  const kindValue = candidate.kind;
  if (typeof kindValue !== 'string' || !SOURCE_KINDS.has(kindValue as SourceKind)) {
    throw new Error(`Unsupported inference source kind: ${String(kindValue)}`);
  }
  const kind = kindValue as SourceKind;

  const protocolValue = candidate.protocol ?? 'openai-chat';
  if (typeof protocolValue !== 'string' || !PROTOCOLS.has(protocolValue as WireProtocol)) {
    throw new Error(`Unsupported inference wire protocol: ${String(protocolValue)}`);
  }
  const protocol = protocolValue as WireProtocol;
  if (!KIND_PROTOCOLS[kind].has(protocol)) {
    throw new Error(`${kind} cannot use the ${protocol} wire protocol.`);
  }

  if (!Array.isArray(candidate.models) || candidate.models.length > 20_000) {
    throw new Error('Source models must be a bounded list.');
  }
  const models = candidate.models.map(model);
  if (new Set(models.map((entry) => entry.id)).size !== models.length) {
    throw new Error('A source cannot declare the same model id more than once.');
  }

  const apiKey = credential(candidate.apiKey, false)!;

  return {
    id,
    name: text(candidate.name, 'Source name', 240),
    apiKey,
    baseUrl: endpoint(candidate.baseUrl),
    models,
    supportsStreaming: true,
    kind,
    protocol,
    createdAt: Date.now(),
  };
}
