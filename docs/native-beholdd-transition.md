# Native Beholdd transition

> Publication note: host labels and local storage paths are anonymized. Raw workstation
> captures are not distributed with this note; historical measurements retain their original
> scope and are not a fresh qualification of another machine.


The next Linux-local milestone is to remove Antimatter's app-managed llama.cpp runtime
and use Beholdd v2 as the native default. MiMo end-to-end speed and memory work follows
that transition. Installed user profiles are not changed by this integration work.

## Boundary and current evidence

Beholdd source `ce0f3a4` already has no external llama inference runtime. Its production
`NativeRuntime` binds `qwen3` and `qwen3moe` and executes on CPU. Antimatter's packaged
native pin is older (`7dbcc39`); its separately managed `bundled-llama-vulkan` source is
the remaining bundled GPU bridge, not part of Beholdd's arithmetic.

Native Vulkan/HIP operator measurements are not full-model GPU serving. Nemotron Super
still lacks a native binder/executor. MiMo's separate correctness harness has a recorded
five-token prefill/next-token distribution comparison, not a completed HTTP/tool-serving
or memory-budget qualification. Do not advertise those as runnable native capabilities.

GGUF formats, Llama-family model names, external BYOK/llama.cpp/Ollama connectors, and
independent reference tests are not bundled runtime dependencies and should remain.

## First integration slice

The new server contract adds two operations without loading checkpoints:

- `GET /v1/beholdd/info` reports schema version, implementation, supported execution
  backends, architecture/format families, and model-unload support. An alternate runtime
  defaults to `unknown`, never to native. Family support is not proof that a configured
  checkpoint has successfully bound; `/v1/models` retains its per-model compatibility.
- `POST /v1/models/{encoded-id}/unload` releases native weights/cache resources only when
  the runtime is idle. Busy requests receive HTTP 409 immediately, not a queued unload
  that can surprise the next turn. Unknown models receive 404; configured but unloaded
  models succeed idempotently. HTTP and embedded callers share the same runtime guard.

Antimatter reads these capabilities before offering or requesting native unload. Older
native builds can still report loaded models, but no longer acquire a nonworking unload
button merely because their source kind is `beholdd`. Legacy servers must provide their
explicit residency vocabulary before the legacy unload contract is assumed. Their
existing recovery behavior and external source selections are preserved.

No bundled binary pin or published release is replaced by this source slice. Native
capability information must not become a mandatory startup handshake while the bundled
pin still predates that endpoint.

The model-free cross-project smoke is:

```sh
node scripts/smoke-native-beholdd.mjs --binary /absolute/path/to/newly-built/beholdd
```

It launches only the specified binary on a random loopback port with a temporary config
and a deliberately nonexistent checkpoint. It exercises Antimatter's real discovery and
unload client, then stops only that child. It does not contact an installed server, load
weights, or change a user's sources. Full-model memory release and GPU correctness require
their own guarded checkpoints; this smoke does not claim them.

## Experimental OpenMythos HAG integration

The client now has a guarded launch path for an explicitly qualified
`openmythos-27b-hag` entry on the managed native service. This source change does
not replace the vendored binary, enable the profile, or qualify a release. The
existing Vulkan choice and separate tiny HAG preview remain available.

The native package manifest must bind the executable hash, the HAG model's
settings, a completed qualification receipt, the full process forecast, source
file extent, native device charge, and containment policy. Host-specific model
and render-node paths are excluded from the settings hash; the runtime checks
the actual checkpoint and device. Unrelated CPU catalog additions do not change
that hash. CPU-only configurations retain their existing launch behavior;
within the contained OpenMythos service, the client explicitly refuses other
models and labels them unavailable there.

Startup and model-list requests keep the registry cold. Each actual request for
an unloaded OpenMythos model repeats memory and temperature admission before
allowing preparation. A verified dedicated systemd cgroup attestation enables
the runtime's existing checkpoint-cache accounting. The process monitor also
bounds nonfile memory with conservative clean-file credit and the complete
native device charge, while retaining the hard memory/swap limits.

First prompts and manual engine transitions share one queue. They refuse busy
or externally owned sibling engines, then await retirement before starting the
replacement. A stopped direct-engine supervisor cannot restart an obsolete
record. Native faults require explicit restart, and quitting waits for verified
native service retirement.

Before shipping this profile, complete whole-model numerical and lifecycle
qualification, measure the real Antimatter prompt/tool context, and verify the
installed builds on both hosts. The initial 2,048-position candidate is not a
claim that normal editor requests fit. No successful qualification manifest is
included in this source checkpoint.

Validation on host A: TypeScript and 180 targeted tests passed. A model-free
smoke exercised the actual launcher in a dedicated systemd unit, verified its
private cgroup identity and limits, preserved literal arguments containing shell
syntax, and confirmed complete process/unit retirement. These checks had no
memory-limit events or swap use and did not execute GPU inference.

The public `Hello.` fixture with the default built-in tools measures 3,433 prompt
tokens with the pinned OpenMythos tokenizer/template. Reserving 512 output tokens
requires at least 3,944 evaluated positions. This already exceeds the candidate
2,048 limit, before additional app tools, standing instructions, or history.
With tools explicitly off, the same public fixture measures 87 prompt tokens.
A larger final editor profile needs measured memory admission and qualification;
the small lifecycle fixtures do not establish normal editor readiness.

The fuller public fixtures include the real terminal description, Preview,
Memory, pull-request, and connected-chat tools. Their first prompt needs 6,210
tokens, or 6,721 evaluated positions with the same output allowance. Adding a
public example agent, skill, project brief, and enabled Bot chat needs 8,279
prompt tokens, or 8,790 positions. Neither fixture includes private instructions,
conversation history, or external MCP tools. This makes 16,384 positions the next
candidate among the measured 2K/4K/8K/16K sizes; it is not a universal fit guarantee.

Independent metadata forecasts include the complete 16,547,399,872-byte checkpoint,
native allocation, host payload, recording/model metadata, and runtime headroom:

| Candidate positions | Native device charge (bytes) | Full process forecast (bytes) |
| --- | ---: | ---: |
| 4,096 | 916,000,768 | 18,566,635,190 |
| 8,192 | 1,469,698,048 | 19,120,365,238 |
| 16,384 | 2,577,092,608 | 20,227,825,334 |

The 16K candidate fits the 20 GiB process ceiling and is below the 19 GiB early
limit. Its device charge exceeds the current 1 GiB budget; a 3 GiB candidate
device budget would cover that forecast. These are planner requirements, not
observed GPU memory use or successful serving admission. The runtime still
rejects OpenMythos capacities above 2,048. Changing that cap and qualifying the
larger profile remain separate work. The guarded metadata checks retired cleanly
with no memory-limit events or swap use.

## Gates before removing the bundled GPU bridge

1. Connect native acceleration through the owned execution/weight-memory boundaries.
   Do not disguise per-operation uploads or duplicate full checkpoints behind the old
   borrowed-slice CPU device API. Keep CPU as the correctness reference.
2. Validate the selected checkpoint's complete native path: token/logit correctness,
   prompt and tool-result replay, SSE cancellation, unload/reload, fit refusal, measured
   memory, and end-to-end latency/throughput. Use isolated ports, hard memory limits, and
   the Beholdd thermal guard; do not replace a working service for an experiment.
3. Publish truthful backend capabilities, then remove port-based CPU labels in the client.
   Build and pin the proven native runtime and required GPU libraries in the release;
   a Vulkan compiler feature alone is not evidence of GPU serving.
4. Switch fresh installations to the native default. Migrate only exact app-owned bridge
   selections when a verified native equivalent exists. Source IDs occur in global
   choice, conversations, agent profiles, schedules, remote references, and model overrides.
   Preserve user-curated models/credentials and never silently reroute an unavailable
   selection to another model or cloud provider.
5. Remove the app-managed bridge lifecycle, vendored payload, sync/build requirements,
   installer variables, and backend-inventory entry together. Prove an upgrade from the
   published v2 package and verify new packages have no bundled llama executables/libraries.

An explicit CPU-only development transition can move the default sooner, but must say that
GPU support has been removed. It is not a completed native-GPU replacement.

## MiMo runtime integration

After the default-server gate, move MiMo from its standalone correctness harness into the
shared runtime, format-neutral weight source, fit accounting, and serving protocol. Measure
prefill, decode, tool-turn latency, and peak memory separately. Remove duplicate attention
work and unbounded expanded-expert retention before interpreting a faster operator as a
faster agent. Keep the embedding entry point usable without Electron or HTTP so other
clients can use the same tested runtime.
