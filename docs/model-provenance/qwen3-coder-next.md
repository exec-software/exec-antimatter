# Qwen3-Coder-Next provenance and the two coder profiles

> Publication note: host labels and local storage paths are anonymized. Raw workstation
> captures are not distributed with this note; historical measurements retain their original
> scope and are not a fresh qualification of another machine.


This note records why the `coder-next-straight` and `coder-next-pool` orchestration profiles bind
Qwen3-Coder-Next 80B, what the architecture does to the slot arithmetic, and what was actually
measured on this box rather than inferred from the model card.

It is evidence for a deployment choice. It is not a claim that this model beats any other; the
only comparisons here are against the Qwen3-Coder 30B it replaces in the coder roles, on this
machine, on one llama.cpp build.

## What it replaced

The coder roles previously named `qwen3-coder-30b`, served by `llama-coder.service` on port 8086,
and the choice between a wide window and a wide pool lived in `~/.local/bin/coder-mode` with two
orchestration profiles hand-renamed `Default` and `Orchestrated`. ADR 0001 identifies that naming
as the symptom: those names describe *how the coder is served*, not which model takes which role,
so they were a workload wearing a profile's clothes.

This pair is the same distinction expressed the way the ADR decided it should be — one model, two
named workloads, two profiles that differ only in which workload their slots bind.

The media roles did not move. Omni keeps `audio` and `image`; see
[qwen3-omni.md](qwen3-omni.md) for why a perception model holds those and a coder does not.

## The checkpoint

- Served id: `qwen3-coder-next-80b` on `http://127.0.0.1:8087/v1`
- Repository: [`Qwen/Qwen3-Coder-Next-GGUF`](https://huggingface.co/Qwen/Qwen3-Coder-Next-GGUF)
  — the official Qwen release, not a community conversion
- Pinned revision: `b82fb7382639d97b38fa7672e526c760c2fb358e`
- Architecture: `qwen3next`, 48 blocks, 512 experts with 10 used plus 1 shared, embedding 2048
- Parameters: 80B total, 3B active (`general.size_label` = `512x2.5B`)
- Precision: `Q4_K_M`
- Context in the checkpoint: 262,144 tokens (`qwen3next.context_length`)
- RoPE base: 5,000,000; rope dimension count 64
- Non-thinking only: the card states it emits no `<think>` blocks and needs no
  `enable_thinking=False`
- License: `apache-2.0`, declared on the GGUF repository itself

The four shards total 48,410,992,032 bytes (45.09 GiB):

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Qwen3-Coder-Next-Q4_K_M-00001-of-00004.gguf` | 15,524,827,040 | `6bcfc9f9c37901eeb92172e2ab871224dab36a453d263bcb2547f737409534da` |
| `Qwen3-Coder-Next-Q4_K_M-00002-of-00004.gguf` | 14,872,168,352 | `817def0691ee9d08bf3dc4444be7aed29c9e52091e8fa9d97901ce7e7f6f01d3` |
| `Qwen3-Coder-Next-Q4_K_M-00003-of-00004.gguf` | 14,503,294,496 | `23aa634d47dca9b4ca3ea249384e6f01951b24c83cdc076f37f6f43d6c99883f` |
| `Qwen3-Coder-Next-Q4_K_M-00004-of-00004.gguf` | 3,510,702,144 | `249c768cc5f130dc731567d6edcbdacc48e14dec9e02c5dbe2b2185d2c5bdb2b` |

Held at `<model-cache>/qwen3-coder-next/Qwen3-Coder-Next-Q4_K_M/`. The hashes above
were verified against the downloaded files on this box, not copied from the card.

### Why Q4_K_M and not a larger quant

`Q8_0` (78.99 GiB), `Q6_K` (61.03 GiB) and `Q5_K_M` (52.82 GiB) exist in the same repository.
None of them coexist with llama-omni, which holds a measured 36.4 GiB of the 96 GiB carveout:
Q5_K_M would leave about 6 GiB for cache and compute buffers, and Q8_0 does not fit beside Omni
at all. Taking a larger quant means giving up the `image` and `audio` roles, and a perception
model the box can no longer reach is a worse trade than four bits of weight precision on a coder.

## Why the hybrid layout is the whole story

`qwen3next` is not a conventional transformer. The 48 blocks are laid out as
**12 × (3 × Gated DeltaNet → MoE, then 1 × Gated Attention → MoE)**, which the GGUF confirms
directly: `attn_k.weight` exists only on blocks 3, 7, 11 … 47, and nowhere else.

So only 12 blocks hold a KV cache, and the checkpoint's own metadata sizes it:

```
qwen3next.block_count              48
qwen3next.attention.head_count_kv   2
qwen3next.attention.key_length    256
qwen3next.attention.value_length  256

12 blocks × 2 kv heads × (256 + 256) × 2 bytes = 24,576 B = 24 KiB/token at f16
                     the same at q8_0 (34 B per 32 values) = 12.75 KiB/token
```

Against Qwen3-Coder 30B's 96 KiB/token, that is a **quarter** the cache per token. The full
262,144-token window costs 6.00 GiB instead of 24.00.

The other 36 blocks keep a recurrent state rather than a growing cache — from
`ssm.inner_size` 4096, `ssm.state_size` 128 and `ssm.conv_kernel` 4, roughly 75 MiB per
sequence, and **fixed regardless of window**. A slot costs the same state whether it holds 8k
tokens or 256k.

Those two facts together are why this model gets two profiles instead of one compromise: a full
window and a six-way pool are *both* affordable on the same carveout, so the choice stops being
about hardware and becomes about the work.

## Why no new engine work was needed

The vendored build is `vendor/llama-vulkan/runtime`, version 0.5.0-dev, **build 11223**, commit
`4da633776` — the same build already serving the other local models. It carries the architecture:

- `libllama.so` exports the `qwen3next` architecture and `llm_build_delta_net_base`
- `libggml-base.so` carries the `GATED_DELTA_NET`, `CUMSUM` and triangular-solve ops
- `libggml-vulkan.so` ships **native compute shaders** for them: `gated_delta_net_f32_d128`,
  `gated_delta_net_f32_d128_kda`, `solve_tri_f32`, `cumsum_f32`, `ssm_scan_128_f32`

`d128` matters: it is exactly this checkpoint's DeltaNet head dimension. The 36 linear-attention
blocks therefore run on the GPU rather than falling back to CPU, which is the difference between
this being usable and being a curiosity. Nothing had to be built or patched.

## What was measured

Hardware: `validation-host-a`, 96 GiB Vulkan carveout, 2026-10-09. llama-omni was **not** resident
during these runs, so the `+omni` column is arithmetic on its measured 36.4 GiB, while the
`coder` column is `rocm-smi` on this box.

| mode | ctx-size | slots × window | KV type | KV | coder | +omni | headroom |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: |
| `pool` | 393,216 | 6 × 65,536 | f16 | 9.0000 GiB | 55.63 GiB | 92.03 | 3.97 GiB |
| `straight` | 262,144 | 1 × 262,144 | f16 | 6.0000 GiB | 52.44 GiB | 88.84 | 7.16 GiB |
| `deep` | 786,432 | 3 × 262,144 | q8_0 | 9.5625 GiB | 56.20 GiB | 92.60 | 3.40 GiB |

Each mode runs about 1.5 GiB above weights-plus-KV, which is compute buffers plus the recurrent
state. Load time is roughly 30 s for all 45 GiB over four shards.

**Throughput**, 200 tokens per request with `ignore_eos` so output length is not a variable:

| concurrent streams | per stream | aggregate |
| ---: | ---: | ---: |
| 1 | 57.8 tok/s | 57.8 tok/s |
| 2 | ~40.0 tok/s | 62.6 tok/s |
| 6 | ~20.0 tok/s | 93.8 tok/s |

The slots are real rather than nominal — six requests complete concurrently — and the scaling is
sublinear, which is expected for MoE decode against memory bandwidth. A pool buys aggregate
throughput with per-stream latency. **That trade is the reason there are two profiles:** it is
right when six agents are working and wrong when a person is waiting on one answer.

**Long context**, in `straight`: a 130,007-token prompt assembled from this repository's own
sources, with the constant `7741-ZULU` planted at about 8% depth, was answered with exactly that
value. Prefill 400.2 tok/s, decode 29.6 tok/s at that depth. So the full window retrieves rather
than merely allocating.

**Tool calling**: a `list_directory` request returned `finish_reason: tool_calls` with correct
arguments and empty content. This is the capability `salvage.ts` and `toolPolicy.ts` exist to
repair when a model lacks it, and the specific failure mode Omni shows — emitting
`<function_call>` as prose. This model does not have it.

**q8_0 KV on hybrid memory** was the one genuinely open question, since `qwen3next` uses
`llama_memory_hybrid`: a quantizable cache for 12 blocks beside an always-f32 recurrent state for
36. It works. `deep` starts and reports `n_slots = 3, n_ctx_slot = 262144`, generates coherently,
still returns real tool calls, and reads 56.2 GiB — which only works at q8_0, since f16 would put
that cache at 18.0 GiB and the server near 65 GiB. The arithmetic is the proof the flag took.

## Host memory: the prompt cache needed a ceiling

The carveout supplies the weights and the KV cache; the guest's ordinary RAM is the smaller,
shared resource — 30 GiB, minus whatever the desktop holds, against a 96 GiB carveout. With
`--load-mode mmap` those 45 GiB land on the GPU rather than in host memory (measured while
serving: VRAM 60.2 GiB, GTT 0.37 GiB), so the resident host footprint is the server's own
allocations. Exactly one of them has no ceiling: llama-server's **prompt cache**, the
cross-request store behind `cache_prompt` and `--cache-idle-slots`, whose default budget is
8,192 MiB of *host* RAM.

On 2026-10-10 that default was the whole explanation for an "inexplicably slow" engine. The
service's anonymous memory — the cache plus the idle-slot saves — reached ~11.5 GiB against the
unit's `MemoryHigh=10G`, so the cgroup sat under continuous high-reclaim (`memory.events.high`
past 180,000). The throttle lands on prefill's large allocations rather than on decode:

| measurement | prefill | decode |
| --- | ---: | ---: |
| fresh 43k-token prefill, cap in force | ~180 tok/s | — |
| fresh 43k-token prefill, cap lifted | 827 tok/s | — |
| a real turn reusing a ~50k-token prefix | **1.4 tok/s** | ~35 tok/s |

The last row is the tell: decode is healthy while prefill has collapsed, so nothing is
compute-bound and no GPU tool shows a problem — the capped cgroup is reclaiming while the GPU
waits.

`--cache-ram 4096` bounds the cache to about 4 GiB of anonymous memory, which fits under the
existing cap. Measured with `MemoryHigh=10G` **unchanged**: three fresh 28,070-token prompts ran
at 947, 949 and 942 tok/s, anonymous memory settled near 3.3 GiB, and what sits up against the cap
is reclaimable *page cache* for the 45 GiB read — harmless, because the weights the GPU uses never
passed through GTT. The cache is a reuse optimisation, not correctness: a conversation's prefix is
carried by the slot's own KV cache (a measured `f_keep = 1.000`), and the prompt cache only matters
when a *different* prompt wants an idle slot back.

## What this is not

- **Not a benchmark.** Every figure above is one box, one build, one quant, one afternoon. They
  are recorded so a later reader knows what was observed, not to rank this model against others.
- **Not a long-context claim past 262,144.** That is the checkpoint's native window. Beyond it is
  YaRN, which Qwen validates only to 131,072 — so serving more would be a promise with no
  evidence behind it. VRAM is not the limit: at 24 KiB/token this card would hold roughly 1.9M
  tokens of cache. The model binds first.
- **Not a replacement for Omni.** It is text-only. `vision: false` in `sources.json` is accurate,
  and the perception roles stay where they are.
- **Not co-resident with the 30B coder or with DeepSeek.** 45.09 GiB here plus the 30B's 48.3
  plus Omni's 36.4 is 130 GiB of 96, and DeepSeek V4 Flash needs essentially the whole carveout.
  `llama-coder-next.service` declares `Conflicts=` on both rather than leaving that to a comment,
  because the last time two of these overlapped the result was an oom-kill.

## The pair, and how to switch

Two orchestration profiles, differing only in the workload their coder slots bind:

| profile | workload | window | pair with |
| --- | --- | ---: | --- |
| `coder-next-straight` — *Coder Next - full window* | `full-window` | 262,144 | `coder-next-mode straight` |
| `coder-next-pool` — *Coder Next - subagent pool* | `fan-out` | 65,536 | `coder-next-mode pool` |

Selecting a profile is the *intent*; `coder-next-mode` is what serves it. The two want to be used
together, and the script exists because the served per-slot window and the window recorded in
`sources.json` must agree — doing it by hand gets one of them wrong. `coder-next-mode deep` is the
third serving mode and the one that gets both halves: full window per sequence and two more
slots, paid for with a lossy cache.

Subagents have no app-side pool; they queue on the backend's slots. The slot count **is** the
subagent concurrency, which is why a profile that wants parallel agents has to be paired with a
serving mode that provides them.
