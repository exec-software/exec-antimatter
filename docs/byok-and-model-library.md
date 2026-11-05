# BYOK and the Model Library

Antimatter's model choice is a source-scoped reference, never a bare model name:

```ts
type ModelRef = { sourceId: string; modelId: string };
```

Two sources may advertise the same model ID while differing in trust boundary, price, latency,
quantization, context limit, or tool support. A bare name may be migrated only when it matches
exactly one configured source; zero or multiple matches are errors.

## Product surface

**Models** is the central page for inference configuration:

- **Library** selects the exact model for the current conversation and owns its standing
  instructions, context ceiling, reply ceiling, and compaction policy.
- **Discover** and **Downloads** retain the verified Hugging Face workflow.
- **Connections** shows the backends contributing models to the library. Secret entry and source
  lifecycle controls remain in Settings while the connection UI is consolidated.
- **Agent routing** is separate from the chat model. A routing profile is global background-agent
  policy; selecting it must never change or obscure the model shown in the composer.
- An individual agent's model control opens this same card library in assignment mode. Choosing a
  card returns the exact source/model to the agent draft; clearing it restores chat-model
  inheritance.

The library renders a bounded page of cards even when a gateway advertises thousands of models.
A conversation's saved source/model pair is a trust boundary: if either disappears, sending is
blocked until the user explicitly chooses a replacement. Antimatter never moves an existing
transcript to another BYOK provider as a fallback.

Model instructions are composed before Antimatter's workspace, permission, and tool grounding.
They apply to that exact source/model in chat, recovery, routed agents, and orchestrated runs.
Agent definitions and `WORKFLOW.md` retain their own task-specific prompts; those are not model
metadata.

## Credential boundary

API keys are main-process-only after initial entry:

1. The renderer may submit a newly typed secret once when adding a source or rotating its key.
2. The source store encrypts it with Electron `safeStorage` when the OS provides a keyring.
3. Every source response, including add and rotation, returns only `credentialConfigured`; it
   never echoes plaintext or a decrypted key to the renderer.
4. Test and refresh operations name a source ID. The main process retrieves the stored key and
   performs the probe.

Rotating a key replaces only the encrypted credential. It preserves the source ID, model catalog,
conversation pins, model profiles, and agent bindings.

An unavailable OS keyring remains a visible storage warning; redacting renderer IPC does not turn
plain-at-rest fallback into encryption.

## Connectors

Connector identity and wire protocol are separate durable fields. Sources saved before this split
have no protocol field and deliberately continue to use OpenAI-compatible Chat Completions; an
upgrade never silently changes the request schema of a working local server or gateway.

The built-in connection presets are:

1. **OpenAI (default BYOK connector):** native Responses API, including streaming function calls,
   `instructions`, and conversation/tool output items. The official API accepts model,
   instructions, tools, and tool choice as distinct request fields:
   <https://developers.openai.com/api/reference/resources/responses/methods/create>.
2. **Anthropic:** native Messages API, including its top-level system field, content blocks,
   `tool_use` / `tool_result`, SSE events, and required API-version header. It is not routed through
   the Chat Completions adapter.
3. **OpenCode:** first-class **OpenCode Zen** connection using its documented Responses endpoint.
   OpenCode itself is a provider catalog/client rather than one universal inference protocol, so
   importing arbitrary OpenCode providers is a later explicit import flow, not silent credential
   scraping. OpenCode documents separate native packages for OpenAI Responses, OpenAI Chat,
   Anthropic, and compatible variants: <https://opencode.ai/v2/docs/providers>.

Implemented durable axes:

```ts
type ConnectorKind =
  | 'beholdd'
  | 'llama-cpp'
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'opencode-zen'
  | 'openai-compatible';

type WireProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';
```

Protocol is currently source-scoped. A gateway whose catalog mixes protocols should be declared as
separate sources until model-scoped protocol overrides exist. Capability flags such as `vision`
are tri-state: unknown stays unknown rather than becoming a false promise in the UI.

## Adapter acceptance bar

A connection is selectable only after its adapter supports:

- authenticated model discovery or an explicitly declared model;
- non-streaming and streaming text;
- multi-round client tool calls with exact history replay;
- cancellation and liveness;
- provider errors that name the source without revealing its key;
- system/model instructions;
- source-scoped resolution and persisted default selection;
- fixture tests for fragmented tool arguments, malformed frames, refusal/error envelopes, and
  stop reasons.

Both native adapters meet this bar in fixture tests, including fragmented streaming tool calls,
cancellation, liveness, malformed frames, error envelopes, stop reasons, and multi-round tool
history. The OpenCode Zen preset uses the Responses adapter and therefore covers Zen's compatible
OpenAI-family Responses models. Because Zen's `/models` catalog spans multiple protocols,
Antimatter verifies that connection but does not auto-import the ambiguous catalog; declare the
exact Responses-compatible model on the Library page. Anthropic-shaped models through Zen need a
separate Messages connection in a future model-scoped flow.

Two boundaries remain explicit:

- `look_at_image` still emits an OpenAI Chat Completions multimodal body, so native Responses and
  Anthropic sources are excluded from preview vision until those image schemas are implemented.
- Native APIs can return opaque reasoning items or signed thinking blocks needed by the next live
  tool round. Antimatter retains those in the provider instance for the run, but generic persisted
  transcripts cannot yet recover a turn that was interrupted mid-tool by a process restart.
