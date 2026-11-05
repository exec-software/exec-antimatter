export type Role = 'user' | 'assistant' | 'system' | 'tool';

/** What a tool is allowed to do, which is what the permission modes gate on. */
export type ToolTier = 'read' | 'write' | 'danger';

export type AccessMode = 'read' | 'ask' | 'full';

export type ThinkingLevel = 'default' | 'off' | 'low' | 'medium' | 'high';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Completed local-model reasoning, kept separate from visible prose and bound to its source. */
export interface ReasoningHistory {
  content: string;
  providerId: string;
  model: string;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  /** Only a compatible adapter may replay this to the same provider/model. */
  reasoningHistory?: ReasoningHistory;
  /** Set on an assistant turn that asked for tools. */
  toolCalls?: ToolCall[];
  /** Set on a tool result, linking it back to the call it answers. */
  toolCallId?: string;
  name?: string;
}

export interface ChatRequest {
  messages: Message[];
  model: string;
  providerId: string;
  requestId?: string;
  /**
   * Id of the assistant row that will display this response. It need not be the request id
   * (the floating environment assistant uses different ids), so transcript continuity must not
   * infer one from the other.
   */
  responseMessageId?: string;
  /** The conversation this turn belongs to, so its carbon is one file rather than nine. */
  threadId?: string;
  temperature?: number;
  maxTokens?: number;
  /** Per-model preference; adapters only send controls supported by this source and model. */
  thinkingLevel?: ThinkingLevel;
  tools?: ToolDefinition[];
  /** Defaults to 'ask' when the renderer doesn't say. */
  accessMode?: AccessMode;
  /** Set false to talk to the model without offering any tools. */
  useTools?: boolean;
  /**
   * The most tool calls one reply may carry, from the model's profile.
   *
   * Enforced while the stream is still open rather than after it closes: a reply the loop will
   * trim anyway is a reply the server is still being paid to generate. Once this many calls have
   * arrived the provider cancels the body, which closes the connection and stops the engine.
   */
  maxToolCalls?: number;
}

export interface InferenceRequestDiagnostics {
  /** Keyed within this app process; comparable across origins, never across app restarts. */
  fingerprintScope: 'app-session';
  payloadFingerprint: string;
  systemFingerprint: string;
  toolsFingerprint: string;
  settingsFingerprint: string;
  messageCount: number;
  /** UTF-16 content and retained-reasoning lengths; tool-call arguments are counted separately. */
  messageCharacters: number;
  reasoningCharacters?: number;
  toolResultCount: number;
  toolResultCharacters: number;
  toolCallCount: number;
  toolCallArgumentCharacters: number;
  toolDefinitionCount: number;
  comparison?: {
    previousPayloadFingerprint: string;
    sameSystem: boolean;
    sameTools: boolean;
    sameSettings: boolean;
    /** Equal wire messages from the beginning, including the system message. */
    commonPrefixMessages: number;
    /** Only the first 4,096 message fingerprints are retained per conversation. */
    prefixComparisonTruncated: boolean;
  };
}

export interface InferenceMetrics {
  phase: 'started' | 'prefill' | 'streaming' | 'complete';
  requestStartedAt: number;
  /** Measured HTTP request lifetime, including connection, queue, and model loading delays. */
  requestDurationMs: number;
  /** First observed output fragment, including reasoning/tool output. Not server-side TTFT. */
  firstTokenMs?: number;
  firstTokenKind?: 'text' | 'reasoning' | 'tool';
  /** Content-free diagnostics of the actual outbound payload, never inference progress. */
  request?: InferenceRequestDiagnostics;
  /** llama.cpp return_progress telemetry. Processed includes the reused cached prefix. */
  promptProgress?: { total: number; cached: number; processed: number; elapsedMs: number };
  /** All remaining fields are server-reported; missing means unavailable, never estimated. */
  promptTokens?: number;
  /** Tokens actually evaluated during prefill, excluding cached prompt tokens. */
  prefillTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedPromptTokens?: number;
  promptMs?: number;
  decodeMs?: number;
  promptTokensPerSecond?: number;
  decodeTokensPerSecond?: number;
}

export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  /**
   * A reasoning model's thinking, which servers send as `reasoning_content` beside the answer.
   *
   * Kept because a reply can be entirely this: the model spends its whole output budget thinking
   * and is cut off before writing an answer. Without it that arrives as an empty string and is
   * indistinguishable from a model with nothing to say.
   */
  reasoning?: string;
  /** Opt-in adapter provenance for retaining completed reasoning between tool rounds. */
  reasoningHistory?: ReasoningHistory;
  /** The server's `finish_reason`: 'stop', 'length', 'tool_calls'. */
  finishReason?: string;
  /**
   * The model the server says actually answered, from the response's own `model` field.
   *
   * Not the same question as which model was asked for. A server that does not recognise an id
   * may answer on its configured default instead of refusing, and the reply is well-formed
   * either way — so the only evidence that a turn ran on the model the person picked is this
   * field. Absent on servers that do not send one.
   */
  servedModel?: string;
  /**
   * The reply was asking for more tool calls than `maxToolCalls` allowed and was cut off mid
   * stream, so `toolCalls` is the allowed prefix and nothing is known about the rest.
   *
   * Distinct from a reply that simply ended: the loop has to tell the model its batch was
   * truncated, or the model reads the results it got back as the whole answer to what it asked.
   */
  toolCallsCutOff?: boolean;
  metrics?: InferenceMetrics;
}

export interface Model {
  id: string;
  name: string;
  /** Explicit display name survives a subsequent source refresh. */
  nameCurated?: boolean;
  deployment?: 'local' | 'distributed' | 'provider';
  hidden?: boolean;
  /** User-curated architecture label, e.g. `qwen3moe` or `nemotron_h_moe`. */
  architecture?: string;
  /** User-curated storage/weight format, e.g. `Q4_K_M`, `Q8_0`, or `BF16`. */
  quantization?: string;
  contextWindow?: number;
  /** Server execution ceiling, independent of curated context metadata. Null clears a prior cap. */
  maxEvaluatedTokens?: number | null;
  /**
   * Whether this model can be shown a picture, as its own server reported it. Undefined means
   * the server did not say, which is not the same as no — see probe.ts.
   */
  vision?: boolean;
  /** True only for entries the user explicitly added to this source's catalog. */
  manuallyDeclared?: boolean;
  /**
   * Main-process catalog provenance. A discovered value may follow later server observations, but
   * an explicit Library edit is durable until the user changes it again. These flags are persisted
   * with the source and deliberately omitted from the renderer's public source projection.
   */
  contextWindowCurated?: boolean;
  visionCurated?: boolean;
}

/** Main-process validated input for adding a source-scoped catalog entry. */
export interface ModelDeclaration {
  id: string;
  name?: string;
  architecture?: string;
  quantization?: string;
  contextWindow?: number;
  vision?: boolean;
  deployment?: 'local' | 'distributed' | 'provider';
}

/** Editable durable metadata. Null clears an optional value; the model id is immutable. */
export interface ModelMetadataPatch {
  name: string;
  architecture?: string | null;
  quantization?: string | null;
  contextWindow?: number | null;
  vision?: boolean | null;
  deployment?: 'local' | 'distributed' | 'provider' | null;
  hidden?: boolean;
}

/**
 * The request/stream schema spoken by a source. Provider branding is deliberately separate:
 * OpenCode Zen, for example, exposes a Responses endpoint while older hosted gateways may keep
 * using Chat Completions. Missing means the legacy OpenAI-compatible chat protocol.
 */
export type WireProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

/**
 * What kind of thing is on the other end. The wire protocol says how to *talk* to a source;
 * this says what it *is*, which is a different question: a locally managed runtime that
 * lazy-loads its weights needs different patience from a hosted endpoint that always answers.
 */
export type ProviderKind =
  | 'beholdd'
  | 'llama-cpp'
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'opencode-zen'
  | 'openai-compatible';

export interface ProviderConfig {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  models: Model[];
  supportsStreaming: boolean;
  /** Omitted by sources saved before native connectors existed; those remain openai-chat. */
  protocol?: WireProtocol;
  /** Omitted by sources saved before kinds existed; absence only means "assume nothing". */
  kind?: ProviderKind;
}

/**
 * The renderer's view of an inference source. Credentials stay in the main process: the UI only
 * needs to know whether one has been configured, never what it is.
 */
export interface PublicProviderConfig extends Omit<ProviderConfig, 'apiKey'> {
  credentialConfigured: boolean;
  createdAt?: number;
}

/**
 * One streamed fragment, in order.
 *
 * A frame carries answer text, thinking, or an inference-metrics snapshot. Thinking rides in its own field
 * with `content: ''` rather than sharing one, so that a consumer written before this existed —
 * or one that simply does not want it — appends an empty string and shows the answer alone.
 * Silently rendering a model's deliberation as its reply is the failure worth designing against.
 */
export type StreamCallback = (data: { id: string; content: string; reasoning?: string; metrics?: InferenceMetrics }) => void;

/**
 * Reports source activity or an explicit loading/waiting status. An SSE keepalive or a frame
 * carrying no content proves the connection is responding, not that inference is progressing.
 *
 * Some runtimes buffer tool calls until they are complete, and prompt processing can take
 * minutes before any output. Activity is useful during that wait, but it cannot distinguish
 * slow computation from a stalled model behind a responsive HTTP server.
 *
 * A note is attached when the source has said something specific about the silence.
 */
export type LivenessCallback = (note?: LivenessNote) => void;

/**
 * Why the source is quiet, when it tells us. A local runtime reading a 156 GiB checkpoint is
 * working rather than hung, and a window that says "Waiting" for seven minutes is lying about
 * which. Optional throughout: a keepalive carries no note, and nothing may depend on one.
 */
export interface LivenessNote {
  /** Short enough for the status line: "Loading model". */
  label: string;
  /** Which model, when the runtime names it. */
  model?: string;
  /** How long the runtime says it has been at this — its clock, not ours. */
  seconds?: number;
}
