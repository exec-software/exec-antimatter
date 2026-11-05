# Mistral Small 4: Vulkan expert-operation repair

> Publication note: host labels and local storage paths are anonymized. Raw workstation
> captures are not distributed with this note; historical measurements retain their original
> scope and are not a fresh qualification of another machine.


Investigated and repaired on 2026-10-11 on `validation-host-a`. The local patched runtime
keeps Mistral's F32 expert down-projections on the GPU. This is a short-context
serving qualification on this Radeon, not a completed long-context qualification
or a model-quality comparison. The original-runtime investigation follows the
repair results below.

## Local GPU repair and validation

The [tracked patch and build recipe](../../patches/llama.cpp/README.md) add a
separate Vulkan matrix pipeline that preserves F32 activations, shared-memory
tiles and accumulation. Decoding uses the existing F32 vector kernels without
Q8 activation staging. Noncontiguous activations are copied as F32. Unsupported
weight layouts and misaligned views remain rejected rather than silently narrowed.
The model's precision requirement is unchanged.

The repair passed 44 required GPU numerical cases on Radeon 8060S (RADV
STRIX_HALO), covering Q4_K/Q6_K weights, decoding and prompt processing, all three
matrix tile sizes, partial tiles, duplicate expert routes, broadcast inputs,
padded activation/ID strides, values beyond 65,504, tiny values and cancellation.
Every output is compared with a double-precision CPU oracle using the actual
dequantized weights and original F32 activations. The strict test mode fails on
unsupported cases or an empty selection. The same test binary against the original
b11223 libraries rejects all 44 cases, as expected. Two ordinary Q4_K/Q6_K expert
operation regressions also pass with the patch.

A bounded full-model run used the same 131,072 context, parallel 1, offload,
thread counts and memory limits as the original diagnostic, with warmup disabled
and verbose scheduler logging. Its 828 logged expert down-projection graph nodes
covered all 36 blocks on Vulkan, with zero such nodes on CPU.

| Measurement | Patched runtime |
| --- | ---: |
| Model-ready poll, including loading | 72.28 s |
| Cold 128-token prompt, four-token response, total request | 1.20 s |
| Cold 128-token prompt processing | 1.08 s / 118.49 tok/s |
| Warm 2,048-token prompt processing | 6.33 s / 323.47 tok/s |
| Streaming arithmetic chat, first content | 0.783 s |
| Streaming arithmetic chat, complete response | 1.434 s |
| Arithmetic chat generation rate, server timing | 42.97 tok/s |

The arithmetic response correctly returned `17 + 25 = 42` with a short explanation.
The 2,048-token repeated-text completion emitted EOS immediately, so that row
measures prompt processing, not sustained generation. The original 128-token
diagnostic produced its first token at 66.19 seconds and did not finish four tokens
within 180 seconds. The source pin and model/settings match, but compiler versions
differ (original GCC 11.4 versus local GCC 15.2), and these are individual diagnostic
runs rather than a statistical benchmark. Loading time is separate from response
latency. The 131,072-token window still needs retrieval and quality qualification.

The local evidence bundle is
`<private-evidence-directory>`:
`summary.json`, `runtime.log`, `relevant-runtime.log`, `memory-samples.jsonl`, and
the numerical/control test logs. The isolated port 18088 service was stopped
afterward, with `MainPID=0`.

The patched payload is separate at `vendor/llama-vulkan-f32`. Its manifest records
the source/patch hashes, compiler/options, per-file hashes and ELF dependency
checks. It is excluded from Electron release packaging until separately qualified
and integrated into that release pipeline. Other models retain the original
verified `vendor/llama-vulkan` runtime. See the build recipe for rebuild and rollback.

On `validation-host-a`, deployment uses
`~/.config/systemd/user/llama-mistral-small-4.service.d/20-vulkan-f32.conf`.
Only the `ExecStart` executable changes; all original model/context/parallel/thread
arguments and memory limits remain intact. The installed payload inventory SHA-256
is `7418845351309bc8733bd59d5faa7907a3887bf6cc110df22b4c8c3a058b8383`.
Both the new payload verifier and the original upstream runtime verifier pass.
The deployed port 8088 service passed a streaming coding prompt: first content
arrived in 0.582 seconds and the complete correct `larger(a, b)` Python function
arrived in 1.039 seconds, with server generation timing of 43.82 tok/s.
`deployed-smoke.json` and `deployment.json` in the evidence bundle record that
check and the exact service override. The service was left loaded and ready;
startup remains on demand, with no login enablement.

A subsequent [speed investigation](mistral-speed.md) added an opt-in F32 matrix
tile cap to the local payload. The current inventory SHA-256 is
`ad160fe1ddd685c342ef884c9060febbec0f715a7d49c17b56c0d3988eee7336`.
The service keeps its default tile selection and activation path: neither tuning
environment variable is enabled. The earlier deployment measurements above
identify the original repaired payload; see the speed notes for later tests and
GPU-contention exclusions. The upstream runtime inventory remains unchanged.

## Installed workload

- Source/model: `local-mistral-small-4-119b` / `mistral-small-4-119b`, localhost port 8088.
- Checkpoint: `bartowski/mistralai_Mistral-Small-4-119B-2603-GGUF`, revision
  `f569d04efea9546de10ec040819908fa4e8f1c92`, two Q4_K_M shards totaling
  72,636,771,776 bytes. The catalog records the download identities; this investigation
  did not repeat the full-file hash verification.
- Runtime: vendored llama.cpp Vulkan b11223, commit
  `4da6337767f973e2b4d0797e5b323d77d8565e4a`.
- Service: `llama-mistral-small-4.service`, context 131,072, parallel 1,
  `--n-gpu-layers 999 --load-mode mmap --threads 8 --threads-batch 8`.
- Host-memory controls: `MemoryHigh=10G`, `MemoryMax=14G`, `MemorySwapMax=0`.

Devstral 2 uses the same runtime, quantization family, offload/thread settings and
memory controls, with a 32,768-token context. It is a dense model with a different
computation graph; parameter counts alone do not predict this backend's performance.

## The reported wait was prompt processing

The Mistral service journal from 2026-10-10 shows:

| Request | Observation |
| --- | --- |
| Task 0, started 11:51:02 EDT | 2,048 prompt tokens in 277.71 s (7.37 tok/s); 4,096 in 559.40 s (7.32 tok/s). Cancelled around 12:04:57; released at 6,144 tokens around 12:05:03. |
| Task 9, small diagnostic | 615 prompt tokens took 134.90 s (4.56 tok/s). |
| Task 11, started 12:29:53 EDT | Still processing the prompt when cancelled around 12:44:32. |

The matching Antimatter carbon records a first source activity callback about 30
seconds after dispatch, followed by no assistant/tool output before cancellation.
That callback proves connection activity, not completed prompt processing. The
previous UI wording, “Source working” / “alive”, overstated what it established.

Devstral journal samples show approximately 22–90 prompt tokens/s; cached follow-up
requests also benefit from prefix reuse. These were different requests, not a
controlled equal-prompt benchmark. Mistral's slow 615-token diagnostic establishes
that conversation length alone cannot explain the problem.

## Original runtime: a mandatory Mistral operation is rejected by Vulkan

The pinned runtime's source provides a specific fallback path:

1. In [`llama-graph.cpp`](https://github.com/ggml-org/llama.cpp/blob/4da6337767f973e2b4d0797e5b323d77d8565e4a/src/llama-graph.cpp#L2313-L2318),
   Mistral4's expert down-projection (`ffn_moe_down`, `MUL_MAT_ID`) requires an F32
   activation input because its values can exceed F16 range.
2. [`ggml_prec_set_src`](https://github.com/ggml-org/llama.cpp/blob/4da6337767f973e2b4d0797e5b323d77d8565e4a/ggml/src/ggml.c#L3306-L3322)
   stores the source-1 precision requirement in operation parameter 3.
3. Vulkan's [`supports_op`](https://github.com/ggml-org/llama.cpp/blob/4da6337767f973e2b4d0797e5b323d77d8565e4a/ggml/src/ggml-vulkan/ggml-vulkan.cpp#L15311-L15321)
   explicitly rejects `MUL_MAT_ID` when that parameter requires F32. The scheduler
   must place the operation on another backend; an “all layers offloaded” message
   does not establish that every operation executes on the GPU.

Neither the F32 requirement nor the rejection depends on prompt length. The path
therefore affects both prompt processing and generation. Context, parallelism,
flash-attention and reasoning settings cannot remove this rejection.

A live isolated load on 2026-10-11 confirmed the scheduler behavior using
`GGML_SCHED_DEBUG=2` and verbose logging: it reported 37/37 layers offloaded, then
assigned `ffn_moe_down-0`, `ffn_moe_down-1`, and the corresponding later-block
`MUL_MAT_ID` operations to CPU. Their inputs include copied expert-weight tensors,
and the following weighted-result operation returns to Vulkan. This confirms
actual CPU execution and transfer boundaries, rather than inferring placement
from throughput alone.

The same diagnostic used a synthetic 128-token prompt, a four-token output limit,
and an absolute 180-second request deadline. It kept the existing context, offload,
thread and memory settings, with warmup disabled and verbose scheduler logging:

| Measurement | Result |
| --- | ---: |
| Model-ready poll | 135.21 s |
| First generated token, measured in server logs | 66.19 s after request |
| Second generated token | 132.17 s after request |
| Request stopped at diagnostic deadline | 180.08 s |
| Expert down-projections assigned to CPU | All 36 blocks |
| Additional `memory.events.high` during request | 0 |
| Additional full memory-pressure stall time during request | 0.000 s |
| CPU time consumed during request | 185.15 s |

No completed four-token response was obtained within the bound. This was a single
cold request with verbose logging, not a warmed throughput benchmark; timings can
include graph setup and transfers. The unchanged memory-pressure counters rule
out active cgroup reclaim as the cause of this reproduced request's delay.
Loading did cause reclaim earlier, so the distinction is specific to the request.

The diagnostic used a separate transient service and localhost port 18088. It was
stopped afterward, with no remaining server process or listener. The normal model
services, selected model, memory limits and runtime binaries were not changed.

The local evidence bundle is retained under
`<private-evidence-directory>`:
`summary.json`, `relevant-runtime.log`, and `memory-samples.jsonl`.

Upstream commit `a9d27ac693ff0a1d3cba449c912c2b891904a4c7`, inspected on
2026-10-11 at 14:36 UTC, retains both the Mistral F32 requirement and Vulkan
rejection. Updating to that revision would not remove the fallback.

The precision requirement must remain: removing the guard or narrowing these
activations to F16 can overflow and invalidate the answer. The local repair above
implements F32-input GPU expert-matrix support and validates actual execution;
loading successfully alone is insufficient to qualify this workload.
