# Beholdd execution limits

The October 18 production composer smoke accepts the current **39-tool interactive
catalog** at C16384. Exact inspection of its actual HTTP body gives **8,079 prompt
tokens** and **12,174 evaluated positions** with the default 4,096-token reply
budget. The same catalog at C8192 is refused before HTTP. This qualifies client
assembly/admission and checkpoint-template tokenization using a synthetic peer;
native full-catalog prefill and tool execution remain unqualified. Separate
[bounded 16k GPU probes](https://github.com/exec-software/exec-beholdd/blob/main/docs/hag-16k-probes.md)
cover late-position attention and full model allocation with early logits, not
this complete request. Historical 15-tool and derived catalog results retain
their original scope below.

Antimatter reads `execution_limits.max_evaluated_tokens` from each `/v1/models`
entry and retains it as the source-scoped `Model.maxEvaluatedTokens`. This is the
running backend's capacity, separate from the checkpoint's context window and
the user's context preferences. It is not a Model Library edit field.

A positive safe integer sets the cap. An explicit `null` clears a previous cap;
an omitted field leaves the last observed value intact. Malformed advertised
limits fail discovery without replacing a valid catalog. Source creation,
refresh, public source projection, model renaming and downloaded-model metadata
decoration preserve the value. Refresh existing sources to obtain new limits.
Null or absence does not assert unlimited context: normal context metadata,
preferences and exact server admission still apply.

Startup and manual refresh share the same observation checks. A source removed,
retargeted, recreated or given a different credential/protocol while discovery
is pending cannot be overwritten by that old response. A later refresh also
supersedes an earlier one, even when the later probe fails. Current Library
edits survive a successful refresh. Caps are stored with the exact source/model
catalog; they are not copied from sibling models or checkpoint metadata. When
manually repointing an entry in `sources.json`, discard the old observed caps
and refresh the new endpoint.

The shared profile resolver applies the cap after context overrides, published
model guesses and server context metadata. Interactive chat, agents,
orchestration and recovery use those effective budgets. A C128 source therefore
has an effective context of at most 128 and, by default, a 32-token reply
reservation. Without tools its estimated prompt budget is 86 tokens, including
the existing ten-percent planning margin. Capped budgets do not inherit the
ordinary 512-token floors; tools can exhaust the prompt budget down to zero.
Overrides can make a budget smaller, but cannot lift the server ceiling.
At the currently qualified C2048 capacity, the default output reservation is
512 and the no-tools prompt budget is 1382. Selected workload instructions,
thinking settings and smaller output preferences remain effective. A narrower
local engine allocation applies as well. Editable workload IPC returns saved
preferences without the temporary cap, so editing instructions cannot persist
a reduced runtime budget over the user's settings.

The OpenAI-compatible provider also checks the complete request before source
preparation, tracking or HTTP transmission. This covers direct chat, streamed
turns, summaries and stop reports that do not all pass through the same fitter.
The estimate includes message content, historical tool calls and current tool
definitions. An oversized request returns an actionable `context_length_exceeded`
error without deleting system instructions or the current user message.

Explicit output limits are preserved or refused, never silently reduced at the
provider boundary. When a capped request omits `maxTokens`, the provider also
omits `max_tokens`, allowing Beholdd to choose the remaining allowance after
exact tokenization. Sources without an advertised fixed cap retain their
existing fallback behavior.

The estimate is not a tokenizer or proof of exact fit. Beholdd's admission rule
is `prompt_tokens + max_tokens - 1 <= max_evaluated_tokens`, using its rendered
chat prompt, tool schemas and assistant prefix. The server's HTTP 400 refusal
remains visible without a retry or backend switch when an estimate was too low.

The normal editor grounding already exceeds C128. This integration makes the
budget and refusal accurate; it does not make a full coding conversation fit
into that capacity. The next runtime integration needs enough qualified context
for the editor's required instructions and tools. Alternate native transports,
model quality and production performance are outside this change.

Regression coverage uses synthetic catalog and completion transport with the
real discovery, profile, context and provider implementations. It covers cap
updates, null clearing, malformed values, preference limits, complete request
guards, exact-server refusal propagation and the discovery-to-request path.
These tests do not load a model or execute GPU inference.

The original implementation was retained on branch `codex/hag-execution-limits`
at `78147b7`, where October 4 validation passed 189 targeted tests across 17
suites and the TypeScript check. October 15 integration adapts it to the current
workload, thinking-control, metrics and source-refresh implementations. Additional
regressions cover saved preferences, local allocation, overlapping discovery,
source/model isolation and reasoning-model output fields. Verification uses
serial bounded services with a 2 GiB memory limit and swap disabled.

October 15 validation passed **210 tests across 19 test files** and the full
TypeScript project check. The external runner initially could not resolve
Electron for one existing metrics suite; after correcting its module search
path, that suite passed separately. No assertions failed. Peak contained memory
was 715,280,384 bytes and peak Tctl was 67.875°C, with zero recorded memory
events or swap. All three check services/cgroups retired. No model, GPU workload
or Electron application ran. Logs and receipts are retained under
`work/hag-editor-execution-limits-20261015` in the HAG development task.

## Production entry-point smoke

Run the model-free smoke inside a bounded development service, with a fresh
absolute evidence directory:

```sh
npm run test:hag-production -- --output /absolute/fresh/evidence-directory
```

The smoke bundles the actual `src/main/index.ts`, `src/preload/index.ts` and
`renderer/src/main.tsx`. Source creation, refresh and workload edits go through
the real preload IPC; it does not click the source settings buttons. No-tools
turns also use preload IPC. A separate case types an oversized message into the
actual App composer and clicks Send with its normal production tool definitions.
It requires a visible `context_length_exceeded` error and zero completion POSTs.

Discovery starts without a fabricated cap and observes C2048 from a loopback
synthetic peer. A curated 65536-token context and saved 32768-token workload must
remain intact while the effective context is 2048 and the default reply is 512.
Further synthetic observations exercise C16384 and explicit null; null restores
the finite saved context. Synthetic success verifies the editor's request path,
not real HAG capacity, output quality or tool execution.

Test-only boundaries supply a private home and app data, suppress bundled
Beholdd startup and the automatic updater, and deny child processes and terminal
startup. The real BrowserWindow renders hidden/offscreen; native tray/menu
construction is replaced because no desktop host exists in this fixture.
Main-process TCP permits only the fixture's exact loopback peer; TLS
and additional listeners are denied. The renderer loads local assets with
network requests blocked. The provider, grounding, profile resolution, budget
calculation, serialization and admission implementation remain production code.

Evidence includes source hashes, request/context observations, synthetic HTTP
bodies, a final report and an Electron exit receipt. Accepted requests must match
the transmitted body. Refused request files are explicitly diagnostic, generated
with the production message serializer after admission throws; they were never
sent. The conversation snapshot is diagnostic and does not qualify durable
saving or restart behavior. A successful report must be joined with a clean
process exit and external service/cgroup retirement. The Electron deadline is
90 seconds; the caller must also bound build work, resources and descendants.

Exact prompt inspection uses the pinned checkpoint's tokenizer metadata without
loading weights or starting inference. The current Qwen3-0.6B template rejects
tools before tokenization, so its actual composer tool request must be reported
as a template rejection. Historical tool counts from the older renderer do not
establish current support. This smoke does not change the client pin or scope of
the completed native Stop/reuse qualification.

On October 15 this new smoke completed independent static review, but its first
startup gate was held: no ten-second window at or below 80°C occurred within
60 seconds. A separate sensor read during the wait was 94.875°C. Neither its
build nor Electron started, so at that point runtime validation and production
prompt counts were still pending. The existing 210-test result
above belongs to the preceding execution-limit integration. Inspector binary,
140 compiled-source hashes and checkpoint provenance passed a separate bounded
preflight. That hold and the later attempts are retained under
`work/hag-production-client-20261015`.

### Completed production smoke and exact inspection — October 15

`smoke-10` passed all five cases and exited normally. Discovery retained a
curated context of 65536 despite server metadata of 131072, while C2048 reduced
the effective context to 2048 with a 512-token reply reservation. The saved
32768-token workload stayed unchanged. Three synthetic requests were transmitted;
both the oversized no-tools request and actual composer submission were refused
before HTTP. The composer carried 15 production tool definitions with bundled
MCP disabled. This does not cover a full configured coding tool catalog.

`measure-01` verified the captured requests against Beholdd's exact checkpoint
template/tokenizer without inference. Accepted request files match their actual
HTTP bodies; refused files are production-serialized diagnostics only.

| Captured phase | Exact prompt tokens | Reply budget | Required positions (`P + M - 1`) |
| --- | ---: | ---: | ---: |
| Fresh no-tools C2048 | 86 | 512 | 597 |
| Oversized no-tools, refused | 7,583 | 512 | 8,094 |
| Synthetic C16384 control | 86 | 4,096 | 4,181 |
| Null cap, saved C32768 | 86 | 8,192 | 8,277 |

The 15-tool composer diagnostic was rejected before tokenization with
`tools are unsupported for this checkpoint chat template`. No token count was
invented for it. Synthetic C16384/null-cap success establishes client behavior,
not larger HAG capacity. Next address exact checkpoint-template tool support,
then measure the supported coding request before planning capacity increases.

The harness repairs cover Chromium's Unix socket path length, ESM startup
ordering, headless desktop/window boundaries, non-cloneable subscription return
values, and checking private curation flags on disk. Earlier attempts, including
the headless native crashes, remain intact. No production application code was
changed for these repairs. Independent smoke and measurement reviews passed.
All ten bounded services/cgroups and recorded Electron/inspector PIDs retired;
short temporary directories were removed. Successful smoke/measurement peak
memory was 750,297,088 bytes and Tctl 81.75°C; across all executed attempts they
were 1,093,853,184 bytes and 84.375°C. Memory events and swap stayed zero.
No model inference or GPU inference workload ran. Native backend qualification,
desktop tray/menu behavior and durable error persistence remain outside scope.

Evidence is joined by `validation.json` in the work root. The smoke report SHA is
`6f75fa2bda36c22a5307ed5d333993ff2cb59c1922e5b0b2cda6afaae86a80fc`;
the measurement SHA is
`c1e0a336120fd1b939e16cc05e14972368873a01c37cea4cd0df8df8c87ba63a`.

### Full production catalog and exact wire inspection — October 18

The additive `--full-catalog` mode passed with the actual production main,
preload, renderer, restored conversations and composer. Its MCP boundary uses the
real SDK client/protocol and production `ALL_TOOLS` definitions through an
in-memory peer; no subprocess or tool handler executes. The composed request has
21 bundled tools, 15 app tools and three connected-chat tools. Optional Bot,
skills, third-party extensions, personal context and long history are excluded.

Two fresh private conversations submit `Reply exactly ready.` through sidebar
and composer clicks. C16384 sends exactly one POST and persists the synthetic
`ready.` reply. C8192 refuses before any POST. Both preserve all 39 schemas,
including connected-chat `maximum` bounds, and retain the saved C32768 workload
settings. `maxItems` appears in the separate optional Bot catalog, not this
39-tool case. Every MCP session retires, and no tool activity occurs.

The accepted **32,389-byte** HTTP body is retained without reserialization as
`request-cap16384-full-catalog.wire.json`; its SHA-256 is
`0762094fb7f43a1d306224a51a865e61ec77b51831fae82c6ccc7b3d3bfa4353`.
Beholdd's current inspector measured those exact bytes using the pinned
Qwen3-0.6B Q8_0 checkpoint metadata, without loading weights or inference.
The refused file is explicitly a production-serialized diagnostic, never a
transmitted request.

| Case | Exact prompt tokens | Default reply budget | Required positions | HTTP POSTs |
| --- | ---: | ---: | ---: | ---: |
| C16384 accepted | 8,079 | 4,096 | 12,174 | 1 |
| C8192 refused | 8,079 | 2,048 | 10,126 | 0 |

The original five-case smoke also passed after this additive change. The first
full-catalog attempt exposed a fixture path error: production conversations use
the private `home/.antimatter` store rather than Electron userData. That failed
attempt is preserved; the successful fixture asserts the real IPC store path.
No production application behavior changed.

All six bounded services/cgroups and recorded Electron PIDs retired, and short
temporary directories were removed. Successful full-catalog smoke peak cgroup
memory was **588,693,504 bytes**, with **48.125°C** peak Tctl; exact inspection
peaked at **80,855,040 bytes** and **48.25°C**. Across the preserved failed attempt
and successful runs, memory peaked at **979,763,200 bytes** and Tctl at **61.75°C**.
Memory events and task swap remained zero. No model, tool or GPU inference ran
in this editor suite.

Evidence is under `work/hag-production-catalog-20261018` in the HAG task,
joined by `validation.json`. Smoke report SHA-256:
`9660a936fd6051d95726aacbab1e4f4b0e221a99c9310305e294412e4d11a018`;
measurement SHA-256:
`b9d41ac03529f8831c79d2812dd6aaf7b621bc0f77eb4a4af15d42d1c5009d1e`.
Next bound the CPU-reference and native-prefill cost of this captured request
before attempting a real full-catalog completion.
