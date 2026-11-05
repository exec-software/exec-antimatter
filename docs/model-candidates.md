# Model candidates

> Publication note: host labels and local storage paths are anonymized. Raw workstation
> captures are not distributed with this note; historical measurements retain their original
> scope and are not a fresh qualification of another machine.


Status: research note, 2026-10-12; DeepSeek V4.1 Flash and Gufo revisited 2026-10-27. Nothing
here is a prepared workload; `src/main/workloads.ts` remains the catalog of record.

What this records is which checkpoints are worth the disk, measured against the fleet rather than
against a review. Every size below was read from a publisher's Hugging Face API on 2026-10-12, not
from a model card's prose.

## The fleet is the specification

Three identical boxes — AMD Ryzen AI MAX+ 395, Strix Halo — each carving **96 GiB of VRAM** out of
128 GB of unified memory and leaving ~32 GB as system RAM. `host-a` (local), `host-b`
(192.0.2.189), `host-c` (192.0.2.220), RPC on 50052 each.

| | one box | all three |
| --- | ---: | ---: |
| VRAM for weights + KV | 96 GiB | **288 GiB** |
| system RAM | 32 GB | 96 GB |
| cores | 32 | 96 |

Two limits that are easy to conflate, and are not the same limit:

- **VRAM decides what can load.** 288 GiB striped, 96 GiB on one box.
- **One box's free disk decides what can be downloaded,** because the RPC host reads the whole
  GGUF. The aggregate is irrelevant. As of 2026-10-12: host-a 133 GB, host-b 44 GB, host-c 53 GB.
  Only host-a can host anything large, and its root filesystem is 93% full.

The second limit is the one that actually binds, and the `stripe-235b.yaml` recipe still carries a
comment claiming host-a has "1.4T free". That was true on 2026-09-30 and is wrong now.

## The Flash tier, which is the single-box ceiling

| Model | Total / active | Low quant | State |
| --- | --- | ---: | --- |
| DeepSeek V4 Flash 0731 | 284B / **13B** | 96.8 GB UD-Q2_K_XL | serving on host-a |
| MiMo V2.6 Flash RL | 309B / **15B** | 167 GB MXFP4 · 126 GB Q2_K | striped, profiled |
| GLM-5.3-Flash | 320B / **18B** | ~109 GB UD-Q2_K_XL | not held |

These three are one class and that class is as good as a single box gets. The reason aggressive
quantization has cost so little here is in the middle column: **13–18B active per token.**
Quantization removes bytes per weight, never FLOPs per token, so both speed and quality survived
because the active path never grew. That stops being true one tier up.

## The tier above

| Model | Total / active | Smallest real build | 288 GiB? | Disk? |
| --- | --- | ---: | :---: | :---: |
| **GLM-5.3** (flagship) | ~744–753B / **~40B** | 236.4 GiB UD-Q2_K_XL | yes, ~50 GiB spare | **already held** |
| **MiMo V2.6 Pro RL** | ~1T / **~42B** | 220 GiB @ 2.0 BPW | yes, ~68 GiB spare | needs 236 GB |
| MiMo V2.6 Pro RL | — | 297.78 GiB @ 2.5 BPW | **no**, over by ~10 GiB | — |
| **DeepSeek V4.1 Flash** | 763.2B / **6 of 384 experts** | 236.2 GB IQ1_M + Engram | n/a, single-node | **short ~96 GB** |
| Kimi K3 | ~2.8T | — | no | no |
| Mistral Large 4 | 1T / 49B | weights due ~2026-10-31 | ~250 GB at 2 bpw, maybe | watch |

### GLM-5.3 — held, striped, and already judged

`<model-cache>/glm-5.3-ud-q2_k_xl/UD-Q2_K_XL/` holds all seven shards,
253,878,406,789 bytes (236.4 GiB), no partials. It is **already wired and has already run**:
`llama-stripe-glm.service` serves it across host-b + host-c + host-a on :8082 with MTP
self-speculation, and the source entry `local-stripe-glm-5-3` points at it.

The unit carries the measurement: at a 131,072 window, residency was **83.8 + 81.0 + 87.7 =
252.5 GiB across the three boxes** against 237 GiB of weights, so KV and compute buffers together
cost only ~15.5 GiB and the unit now runs at 262,144. It is not confused with GLM-5.3-Flash; the
[GLM-5 paper](https://arxiv.org/html/2602.15763v2) gives the flagship as 744B with 40B active,
256 experts, 80 layers.

**The verdict is already in, and it is that this tier is not a tier.** Nathan's judgement after
running it is that GLM-5.3 sits in the same class as DeepSeek V4 Flash — a 744B/40B-active model,
striped over three boxes, not meaningfully better than a 284B/13B-active model on one.

That is the single most important finding in this document, because it is evidence against the
premise of the whole table above: going up in total parameters bought nothing here. Any candidate
in the tier above needs a reason to believe it differs from GLM-5.3 in kind, not just in size.

### MiMo V2.6 Pro — the one to want

The 309B Flash sibling does very well on this hardware, and that — rather than total parameter
count — is the reason to want the Pro. ~1T total, ~42B active. Note that it has to clear the bar
GLM-5.3 failed: 42B active over three-box RPC is the same shape that bought nothing last time, so
the case for Pro rests on it being a better *model*, not a bigger one. [AesSedai's GGUF](https://huggingface.co/AesSedai/MiMo-V2.6-Pro-RL-GGUF)
quant ladder:

| BPW | Size | Fits 288 GiB |
| ---: | ---: | :---: |
| 4.52 (MXFP4) | 538 GiB | no |
| 3.50 | 416.88 GiB | no |
| 2.50 | 297.78 GiB | no, by ~10 GiB |
| **2.00** | **~220 GiB** | **yes** |

So there is exactly one usable rung, and it is the bottom one. That is the right rung for this
fleet anyway.

**Two things to settle before spending the disk.** First, the omni claim is unverified for Pro:
the Flash card documents text/image/video/audio with a 681M vision encoder and 308M + 127M audio
encoders, but ggml-org's Pro repo is tagged `Image-Text-to-Text` and no source found so far
confirms audio in a Pro GGUF. If the all-in-one stack is the goal, **Flash is the confirmed omni
model and Pro may be vision-only.** Second, the disk: 220 GiB is ~236 GB, and host-a cannot hold
both this and GLM-5.3. They are alternatives, not a sequence.

### Ruled out, with the reason

- **DeepSeek V4.1 Flash** — the 335 GB floor quoted here on 2026-10-12 (from
  [smalinin's repo](https://huggingface.co/smalinin/DeepSeek-V4.1-Flash-GGUF)) is superseded: a
  1.75 bpw build plus a disk-resident Engram table brings it to 236.2 GB. It is still out, but for
  a different and more interesting reason. See [its own section](#deepseek-v41-flash--reopened-and-still-out).
- **Kimi K3** — ~2.8T. Not close.
- **GLM-5.3 at Q3_K_XL** — 343 GB. Over.
- **Mistral Large 4** — 1T / 49B active, weights promised end of October 2026. Worth a look when
  they land; at 2 bpw it should come in near 250 GB, which fits VRAM and not host-a's disk.

### DeepSeek V4.1 Flash — reopened, and still out

Reopened 2026-10-27 by [a Strix Halo report](https://github.com/franzmoca/gufo/tree/feat/ds41)
claiming "a 763B model on one Strix Halo, no SSD streaming." The claim is partly real and the
arithmetic is worth keeping, because this is the first candidate the fleet cannot reach **by
striping**, which has been the standard escape hatch.

**What is actually real.** Verified against the publishers, not the post:

- [ISTA-DASLab's GSQ-RCO GGUFs](https://huggingface.co/ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF)
  exist. Quant types are assigned per tensor under a size budget rather than uniformly. Three
  rungs: IQ1_M (1.75 bpw, 4 shards, **120.7 GB**), IQ2_XXS (2.00, ~138 GB), IQ2_XS (2.25, ~155 GB).
- The base model is **763.2B total, 384 routed experts, 6 active per token**, 1M native context.
  The 552B/8B–16B figures in the table above were wrong.
- `DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf` is **110.6 GB** and is *not* resident. Gufo reads it
  from NVMe **one row per token, on every prefill and decode step.**

**The headline is wrong by the guide's own numbers.** "Fully resident, no SSD streaming" describes
112.3 GiB of a 220 GiB model — 52%. The other 103 GiB is a hot per-token disk read. What the author
means is that the *backbone* is not paged; the Engram path is still on the SSD, and "SSD streaming"
appears in his own next-steps list. Nothing here removes the disk from the token loop.

**Measured numbers, and why they do not make the case.** Both rows are the same engine on a 128 GB
box, so they are directly comparable:

| | prefill pp2048 | decode, 1 user | decode, 8 users |
| --- | ---: | ---: | ---: |
| DeepSeek V4 Flash 0731 IQ2XXS (held, serving) | 484.62 | 26.62 DSpark | 54.74 |
| DeepSeek V4.1 Flash IQ1_M + Engram | **1,077** | 28.0 DSpark / 23.3 AR | 55.9 |

**Decode is a wash — 28.0 against 26.62** — for 2.7x the total parameters, 236 GB of disk and a
dedicated box. That is [[flash-tier-ceiling]] repeating itself exactly: 6 active experts is the
same tier, so the active path never grew and neither did the speed. The 65.3 tok/s figure in the
post is prompt-lookup on repetitive text, i.e. the file-editing best case, not a general rate.

**Prefill is the one real win: 2.2x, 1,077 vs 484.62**, credited to decoder SWA bounded replay.
For long-context coding work that is worth something. It is also the only number here that is.

**Why it is out, and this time it is not VRAM.** Gufo is a single-node engine — upstream documents
no RPC, no clustering, no tensor splitting, only an unmerged
[RDMA dual-box variant](https://github.com/neuhaus/gufo). So the 288 GiB aggregate is irrelevant
and the whole model must land on one box. Two constraints then cross:

| | disk free | can go headless-dedicated? |
| --- | ---: | :---: |
| host-a | 140 GB (93% full) | **no** — build box, needs ~12 GB system RAM |
| host-b | 44 GB | yes (usually powered off) |
| host-c | 53 GB | yes (usually powered off) |

Needed: **236.2 GB on one box** (120.7 backbone + 110.6 Engram + 4.9 drafter), and that box must
run with the firmware UMA carve-out at *minimum*, `amdgpu.gttsize=126976 ttm.pages_limit=32505856`,
booted to `multi-user.target`, leaving **1.75 GiB of host RAM**. The only box with the disk is the
only box that cannot be dedicated; the two that can be dedicated are each ~190 GB short.

**The unlock, if it is ever wanted, is a disk and not a model.** One ~1 TB NVMe in host-b or host-c
turns an already-headless, already-powered-off box into the host, costs nothing on host-a, and
displaces neither GLM-5.3 nor qwen3-vl-235b. Freeing host-a instead means deleting GLM-5.3 (237 GB)
and permanently surrendering the box Nathan builds on, which is not a trade.

**The quality rung is the other problem.** The resident rung is IQ1_M, and it is the compromised
one. ISTA's card reports AIME25 100.00 and GPQA-D 88.38; an independent
[Strata write-up](https://github.com/Niko1221/Strata/blob/main/docs/DEEPSEEK41.md) reports IQ1_M at
**+21% perplexity, KL 0.217, top-1 agreement 82.5%**, weakest on prose, and treats 1.75 bpw as the
fallback for when 2.00 is tight. Everything in this fleet runs at ~2.0–2.5 bpw, not 1.75. IQ2_XXS
is the rung that would be wanted and at ~138 GB it does not fit resident at all — which is why
the author's next step is the SSD streaming his title disclaims.

**Verdict: not now, and not on these three boxes as configured.** It needs a fourth
consideration — a disk — before the model question is even reachable. And the model question is
still the [[flash-tier-ceiling]] question: 763B total buys a wash on decode, so the case has to be
that V4.1 Flash is a *better model* than V4 Flash, which no number gathered here establishes.

### Gufo, separately, is worth a bridge

The engine is more interesting than the model it was found through.
[gufo-org/gufo](https://github.com/gufo-org/gufo) is not a llama.cpp fork but a ground-up engine
for exactly this hardware — `gfx1151` only, Ryzen AI MAX+ 395, Radeon 8060S — and it reads GGUF.
It already publishes a **DeepSeek V4 Flash 0731 IQ2XXS** row, which is the checkpoint already held
at `<model-cache>/deepseek-v4-flash-0731-ud-q2_k_xl` (91 GB on disk).

That makes a zero-download experiment available: serve a model we already have on the engine we
want to evaluate, and compare against our own llama.cpp numbers.

- **It is OpenAI-compatible.** `gufo serve llm --model X.gguf --host 0.0.0.0 --port 8080` exposes
  `/v1/chat/completions` plus a Responses API, with images, function tools, structured output and
  streaming. Antimatter's existing custom OpenAI-compatible source can therefore talk to a
  hand-started Gufo **with no code at all**; a managed bridge mirroring `src/main/llamaVulkan.ts`
  is only needed for the packaged product.
- **It does not speak llama.cpp's server API.** No `/health`, no `/props`, so readiness probing in
  `sourceReadiness.ts` cannot be reused as-is; `gufo diagnose` is the natural substitute for
  `probe.ts`. Flags differ too: `--model`/`-m`, `--context N` (not `-c`), `--host`, `--port`,
  `--sessions N`, `--cache-disk DIR`, `--speculative dspark|dflash2|mtp`, and **no `-ngl`**.
- **Two real prerequisites this fleet does not currently meet.** It is HIP/ROCm — qualified at
  **ROCm 7.2.3 with GCC 15.3** — and host-a has no `/opt/rocm` at all; the whole stack here is
  Vulkan (`vendor/llama-vulkan`). The container `ghcr.io/gufo-org/toolboxes/gufo-runtime:latest`
  avoids the host install. And Gufo is built around GTT rather than a dedicated carve-out, so the
  fleet's 96 GiB firmware carve-out is likely the wrong shape even for the cheap experiment —
  a reversible firmware change plus a reboot.
- **One feature worth stealing regardless.** `--cache-disk` restored a 12K-token conversation in
  13 ms after a server restart: 110 ms to first token instead of 12 s. That is directly relevant
  to chat resume in Antimatter, independent of which engine serves.

A shipped Gufo backend could not be bundled the way `llama-vulkan` is — gfx1151-only and
ROCm-dependent makes it a detected external engine or a container, not a packaged binary.


## Specialist candidates

### OpenMythos 27B — held, wired, serving

Full evidence in [its provenance note](model-provenance/openmythos-27b.md).

A security-focused fine-tune of Qwen3.6-27B from a hackathon, Apache-2.0, trained on
[CVE_Vulnerailities_Detailed](https://huggingface.co/datasets/build-small-hackathon/CVE_Vulnerailities_Detailed)
and a filtered arXiv import. 26,895,998,464 parameters, architecture `qwen35`, 262,144 context.

| Build | Size | Purpose |
| --- | ---: | --- |
| [Q4_K GGUF](https://huggingface.co/jabbatheduck/OpenMythos-GGUF) | 16.55 GB | **serving**, 3 slots x 262,144, q8_0 KV |
| Q6_K GGUF | 22.08 GB | held; +31.5% slower, see below |
| Q5_K GGUF | 19.23 GB | — |
| [BF16 safetensors](https://huggingface.co/build-small-hackathon/OpenMythos) | 53.79 GB | training base |

**There is no F16 GGUF in that repo** — the three quants above are all of it. The full-precision
weights exist only as BF16 safetensors in the base repo, which is also the only form any training
pipeline can consume.

This is the first model here where precision genuinely matters: at 27B there is no 13B-active MoE
sparsity to hide quantization error, so Q6_K is the floor worth serving rather than the ceiling.

Architecture support is confirmed in the pinned build: `vendor/llama-vulkan/runtime/libllama.so`
at build 11223 exports `llama_model_qwen35` and was compiled from `src/models/qwen35.cpp`.

Read from the checkpoint rather than the card: 64 blocks, 851 tensors, embedding 5120, FFN 17408,
24 attention heads over 4 KV heads of 256, rope base 1e7, vocab ~248320.

**It is a hybrid, and that is the interesting part.** `qwen35.ssm.*` is present and
`full_attention_interval = 4`, so only 16 of the 64 blocks hold a KV cache and the rest are
recurrent with state that is O(1) in sequence length. At 4 KiB per token per attending block that
is ~64 KiB/token, so the full native 262,144 window costs ~16 GiB — the whole model at maximum
context is ~37 GiB of a 96 GiB carveout. This is the cheapest full-context model held.

Wired and served on 2026-10-12: `llama-openmythos.service` on :8090, source
`local-openmythos-27b`, two workloads (`full-window`, `co-resident`), and the
`openmythos-security` orchestration profile. Two things were learned doing it and are recorded in
the unit: this architecture aborts on the first request under `--spec-type draft-mtp`, and
`--jinja` is mandatory because the packed template emits `<tool_call><function=...>` XML and
opens `<think>` unconditionally.

Measured on first boot: ready in ~10 s, **40.4 GiB resident** against a predicted ~37, full
262,144 window in one slot. `cache_reuse` is refused by this context, as a hybrid should refuse
it. Reasoning returns separately in `reasoning_content`; a tool call came back as a real
`finish_reason=tool_calls` with parsed arguments rather than as prose.

**Decode speed is purely a function of file size here, and that is the most
instructive thing in this document.** Measured 2026-10-12 over three alternating
Q6/Q4 rounds, one server at a time, identical flags, `max_tokens=200`,
temperature 0, reading llama.cpp's own `timings.predicted_per_second` so prefill
and HTTP are excluded:

| quant | file | tok/s (3 rounds) | VRAM | implied bandwidth |
| --- | ---: | ---: | ---: | ---: |
| Q6_K | 22.08 GB | 9.726 / 9.729 / 9.729 | 40.10 GB | **214.8 GB/s** |
| Q4_K | 16.55 GB | 12.797 / 12.798 / 12.790 | 34.89 GB | **211.7 GB/s** |

**Q4_K is +31.5%.** The two implied bandwidths agree within 1.5% and sit at ~84%
of the platform's 256 GB/s theoretical LPDDR5X ceiling, which is what a
bandwidth-bound model looks like: every token reads all the weights, so halving
the bytes per weight directly buys throughput.

This is the active-parameter rule running backwards. DeepSeek V4 Flash carries
10x the total parameters and is quick because it reads only a 13B-active slice;
OpenMythos is effectively dense, so **on this model, unlike every MoE in the
fleet, a lower quant buys speed and not merely disk.** The 27B precision
argument is real, but it is now a measured trade against 31.5%, not a default.

An earlier reading of 7.2 tok/s in this document and in the unit was wall-clock
including prefill, taken while two downloads were saturating NVMe. It is
superseded and should not be quoted. A methodological note worth keeping: do not
use `ignore_eos` against this server: on this build it ignored `n_predict`, ran
one task to 62,060 tokens and wedged the single slot.

## Open questions

1. Does MiMo V2.6 Pro's GGUF carry audio, or only vision? Decides whether Pro can be the
   all-in-one or whether Flash keeps that job.
2. Given GLM-5.3 struck Nathan as DeepSeek-class, what would make MiMo V2.6 Pro different?
   Worth answering before spending 236 GB of host-a's disk, since Pro displaces GLM-5.3 rather
   than joining it.
3. Does a `security`-dedicated model earn its residency, now that OpenMythos makes that testable
   for the first time?

The interconnect question is settled: `enp191s0` reports **2500 Mb/s**, so the fabric is 2.5 GbE
at ~280 MB/s. See `training-a-unimodel.md` for what that bounds.
