# OpenMythos 27B provenance, and what a dense model costs here

> Publication note: host labels and local storage paths are anonymized. Raw workstation
> captures are not distributed with this note; historical measurements retain their original
> scope and are not a fresh qualification of another machine.


This note records why the `openmythos` orchestration profile gives one 27B model every text role
on this box, and why it serves Q4_K rather than the Q6_K that was downloaded first. It is evidence
for a deployment choice. It is not a claim that this model is a better coder than the ones it sits
beside — see "What this is not".

It exists because the unit file that carries these measurements lives in
`~/.config/systemd/user/`, outside any repository, deliberately: a topology is a fact about
someone's machines (`src/main/recipes.ts` says so). The measurements are not, and they belong here.

## The checkpoint

- Served id: `openmythos-27b`, source `local-openmythos-27b`, loopback `:8090`
- GGUF repository: [`jabbatheduck/OpenMythos-GGUF`](https://huggingface.co/jabbatheduck/OpenMythos-GGUF)
  at revision `4a1a1f97fbfc621d6f33cebc9f3ecc5c12e8c7d7` (last modified 2026-06-18)
- Base weights: [`build-small-hackathon/OpenMythos`](https://huggingface.co/build-small-hackathon/OpenMythos),
  itself a fine-tune of [`Qwen/Qwen3.6-27B`](https://huggingface.co/Qwen/Qwen3.6-27B)
- Fine-tuning data, per the GGUF metadata: `build-small-hackathon/CVE_Vulnerailities_Detailed`
  and `himanshu17HF/ArvixImport-Filtered-Final`
- License: `apache-2.0`, declared by both the GGUF metadata and the repository
- Parameters: 26,895,998,464. Architecture `qwen35`, 851 tensors, 64 blocks
- Context in the checkpoint: 262,144 (`qwen35.context_length`)

Held at `<model-cache>/openmythos-27b`. Hashes are of the downloaded files on this
box, not values copied from the card:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Q4_K/OpenMythos-27B-Q4_K.gguf` | 16,547,399,872 | `d3c3398ba8b512aa59074efcaa34d7dcabed7381b68a05ae6bcce77e14d7db45` |
| `Q6_K/OpenMythos-27B-Q6_K.gguf` | 22,082,529,472 | `8b225034431666b0e4723d42efe0aae088c54a84e42ea5f9547f19cb29e2593c` |

`BF16/` holds the base repository's safetensors, 53,792,110,192 bytes over two shards, byte-exact
against the Hugging Face API. They are **not** servable and are not meant to be: they are the only
form a training pipeline can consume, and GGUF is not one. See `docs/training-a-unimodel.md`.

**There is no F16 GGUF.** The repository publishes Q4_K, Q5_K (19,231,099,072) and Q6_K, and
nothing else. Full precision exists only as those safetensors.

## The architecture, read from the file

`qwen35` is a hybrid, and that is the single most consequential fact about serving it:

```
64 blocks, embedding 5120, FFN 17408, 24 attention heads over 4 KV heads of 256
full_attention_interval = 4   -> layer_types is 48 linear_attention + 16 full_attention
qwen35.ssm.*                  -> conv_kernel 4, state_size 128, inner_size 6144, groups 16
rope freq_base 1e7, partial_rotary_factor 0.25, vocab 248320 (bos 248044, eos 248046)
```

Only **16 of the 64 blocks hold a KV cache**; the other 48 are recurrent and their state is O(1)
in sequence length. At 4 KV heads × 256 × 2 (K and V) × 2 bytes that is 4 KiB per token per
attending block, so **~64 KiB/token** — the full native 262,144 window costs about 16 GiB. The
same shape as the note in `coder-next-pool`, where only 12 of 48 blocks cache at 24 KiB/token.

Its recurrence is along the **sequence**, not along depth. Every one of the 64 blocks has its own
weights (13.2 unique tensors each), so it is not a depth-recurrent transformer and no weight is
reused across depth.

Architecture support is confirmed in the pinned build:
`vendor/llama-vulkan/runtime/libllama.so` at b11223 (`4da633776`) exports `llama_model_qwen35` and
was compiled from `src/models/qwen35.cpp`. `llama-stripe-qwen38.service` serves the same
architecture and is the precedent.

## Q4_K over Q6_K, measured

Three **alternating** q6/q4 rounds, one server at a time, identical flags, `/v1/chat/completions`
with `max_tokens=200` at temperature 0, reading llama.cpp's own `timings.predicted_per_second` so
the figure is decode only. Warm-up request per load discarded. Alternating so thermal drift — 59
to 65 °C over the run — fell on both arms equally.

| quant | file | tok/s | VRAM | implied bandwidth |
| --- | ---: | --- | ---: | ---: |
| Q6_K | 22.08 GB | 9.726 / 9.729 / 9.729 | 40.10 GB | **214.8 GB/s** |
| Q4_K | 16.55 GB | 12.797 / 12.798 / 12.790 | 34.89 GB | **211.7 GB/s** |

**Q4_K is +31.5%, and frees 5.2 GB.** The two implied bandwidths agree within 1.5% and sit at ~84%
of this platform's 256 GB/s theoretical LPDDR5X ceiling, which is what bandwidth-bound decode
looks like: every token reads all the weights, so halving bytes per weight buys throughput
directly.

This is the active-parameter rule running backwards. DeepSeek V4 Flash carries 10× the total
parameters and is faster, because it reads only a 13B-active slice per token. So **on this model,
unlike every MoE in this fleet, a lower quant buys speed and not merely disk.** The 27B precision
argument is real, but it is now a measured trade against 31.5% rather than a default.

An earlier reading of **7.2 tok/s is retracted.** It was wall-clock including prefill and HTTP,
taken while two downloads were saturating NVMe, and it implied 159 GB/s and 62% of roof. The
direction of the finding was right and the magnitude was wrong.

## Three full-context slots, and the concurrency risk that had to be tested

The profile gives this model every text role, so it orchestrates. Subagents are dispatched
concurrently (`agents/delegation.ts` uses `Promise.all`) and queue on the backend's slots, so a
one-slot server serialises exactly the runs the profile exists for. The unit serves
`--parallel 3 --ctx-size 786432` with `--cache-type-k q8_0 --cache-type-v q8_0`: **three slots,
each holding the full trained 262,144-token window**, giving the orchestrator its own slot and two
subagents beside it.

q8_0 KV is what buys the full window at three slots, and it is the same trade
`coder-next-mode deep` makes. Over the 16 of 64 blocks that attend at all, f16 costs ~64 KiB/token
and q8_0 ~32, so 786,432 tokens of cache lands at ~24 GiB — the same as the 393,216 f16 tokens an
earlier six-slot configuration served, for twice the total window. The other 48 blocks are
recurrent and `--cache-type` does not touch them. `llama-qwen3vl-30b.service` already serves q8_0
KV on this build.

**q8_0 was verified for correctness, not just for fit**, because a quantized cache degrades output
quietly rather than failing: asked to name a vulnerability class it answered "SQL Injection",
asked what CWE-22 is it answered path traversal, and asked for exactly three comma-separated HTTP
methods it returned `GET, POST, PUT` and nothing else.

`openmythos-mode` switches this for `pool` (6 × 65,536, f16, widest fan-out) or `straight`
(1 × 262,144, f16, no concurrency).

`llama-stripe-qwen38.service` records this same `qwen35` architecture core-dumping **reliably on
the fourth concurrent sequence**:

```
ggml-backend.cpp:359: GGML_ASSERT(tensor->data != NULL && "tensor not allocated") failed
```

That was attributed to the split scheduler with ≥2 RPC workers, a condition this single-box unit
does not have — but that is reasoning, not evidence, so it was tested twice, 2026-10-13.

Six concurrent, against the earlier six-slot configuration: all six completed,
`finish_reason=length` at 120 tokens each, 28 s wall, service still active, **zero**
`GGML_ASSERT` / core-dump / not-allocated lines in the journal. Per-stream 5.63–8.63 tok/s for
**46.3 tok/s aggregate** against 12.797 single-stream.

Three concurrent, in the deep configuration now served: ready in ~12 s, **42.29 GiB resident**
against a predicted ~43, `n_slots = 3`, `n_ctx_slot = 262144`. All three returned in 31 s at
10.20 / 11.81 / 11.03 tok/s — ~33 aggregate — again with no crash and nothing in the journal.

Aggregate exceeding single-stream is dense weights batching: one weight read serves every
sequence in the step.
`llama-stripe-qwen38.service` measured the same effect (3.43 single against 4.18 aggregate), and
it is the opposite of what an MoE does on one card, where concurrent agents route to different
experts and read more of the model. Prompts were deliberately distinct, so this is sequence count
and not prefix-matched slot reuse.

Residency with Qwen3-Omni loaded beside it, which the profile requires:

```
OpenMythos Q4_K weights        15.4 GiB
+ KV, 786,432 tokens @ 32 KiB  24.0 GiB
+ compute buffers              ~4   GiB   (42.29 GiB measured at load)
Qwen3-Omni Q8_0 + mmproj       31.2 GiB
+ its KV at the pinned 65,536  ~6   GiB
                               --------
                               ~80.6 GiB of the 96 GiB carveout
```

`openmythos-mode deep|pool|straight` keeps Antimatter's recorded `contextWindow` in step with the
served window, for the same reason `coder-next-mode` exists: the drop-in and `sources.json` have
to agree or the prompt builder and the server disagree about the window.

## Three things that cost time, recorded so they do not again

1. **`--spec-type draft-mtp` must not be set.** `llama-stripe-qwen38.service` records this
   architecture loading clean with that flag and then aborting on the first request, because
   llama.cpp builds the MTP draft context and never allocates its tensors. The runtime's MTP
   builder names GLM4/DEEPSEEK4/DEEPSEEK32, not this family. The worst failure shape: a
   healthy-looking server that dies the moment anyone uses it.
2. **`--jinja` is mandatory, not optional.** The packed template (8,057 chars, extracted from the
   GGUF and rendered both bare and with a tool list before the unit was written) emits tool calls
   as `<tool_call><function=name>` XML rather than JSON, and opens `<think>` unconditionally on the
   generation prompt. Verified serving: a `read_file` request came back as a real
   `finish_reason=tool_calls` with parsed arguments rather than prose.
3. **Do not use `ignore_eos` against this build when benchmarking.** It ignored `n_predict`, ran
   one task to 62,060 tokens, and left the single slot occupied with every later request queued
   behind it; the process sat in `D` state until restarted.

`--cache-reuse 256` is asked for and **refused**: the journal says `cache_reuse is not supported
by this context, it will be disabled`, because the recurrent half has no shiftable cache. The flag
is left in place because it costs nothing and the journal states plainly that it was declined.

A gap worth naming: `openmythos-27b` did not match the local-thinking regex in
`src/api/thinking.ts`, so `thinkingSupport` reported no mechanism and the thinking budget could not
be set from a workload — while the template opens `<think>` regardless. It was uncapped rather
than merely unconfigured, and a 400-token ceiling returned empty content with
`finish_reason=length`, all of it spent reasoning. Fixed in `2beca57`.

## What this is not

This is a 27B dense-ish hybrid and a security fine-tune from a hackathon, with 138 downloads at the
time it was taken. It is not an agentic coder of the class `Qwen3-Coder-Next` is, and it publishes
no agentic coding result. It holds every text role in the `openmythos` profile because that is
what was asked of it and because residency arithmetic leaves no room for a third model beside it
and Omni — not because it is the better coder. `coder-next-pool` remains the profile for work that
is mostly writing code rather than reasoning about it.

It is also blind. The packed template carries image and video branches inherited from Qwen3.6, but
this checkpoint ships no projector and no vision tensors, and its source entry declares
`vision: false` so that `eyes.ts` — which takes the first loopback source claiming vision and
never probes — does not route a look to a model that cannot see. The `audio` and `image` roles
stay with Qwen3-Omni.
