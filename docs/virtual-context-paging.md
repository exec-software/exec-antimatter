# Virtual context and KV paging

Status: research notes, 2026-10-09. Not a decision, a commitment, or a plan of record.
Parked deliberately — a later experiment, not current work.

The question that prompted this: the 32,768-token window on the new local coder card is workable
but small. Could the real window hold some kind of *trunk*, with a "virtual context window"
behind it — paging buffers out to disk — to present something like a million tokens?

The short answer is yes, but not in that shape, and the useful version is closer to the trunk
intuition than to paging. What follows separates the physics from the engineering, because the
naive form fails on bandwidth and the viable form is a different design.

All per-token figures below are computed from this box's actual checkpoint metadata, not
estimated. Bandwidth figures are nominal for the class of device and were **not** measured here;
they are order-of-magnitude, and the conclusion they support survives being wrong by 2x.

## The measured geometry

From the GGUF of `Qwen3-Coder-30B-A3B-Instruct-Q8_0`:

| key | value |
| --- | --- |
| `qwen3moe.block_count` | 48 |
| `qwen3moe.attention.head_count_kv` | 4 |
| `qwen3moe.attention.key_length` / `value_length` | 128 / 128 |
| `qwen3moe.context_length` | **262,144** |

KV cost per token is therefore

```
48 blocks x 4 kv heads x (128 + 128) x 2 bytes (f16) = 98,304 B = 96 KiB/token
```

GQA ratio sets this, not parameter count — which is why the 0.6B draft model on this box is
*more* expensive per token (28 blocks x 8 kv heads = 112 KiB/token) than this 30B target.

## Why the naive form cannot work

A context window is a **compute** limit, not a storage limit. Every token in the window
participates in attention at every layer, for every token generated. The KV cache is only the
memo of that work. Storing it elsewhere is easy; *attending* over it is the wall.

At 96 KiB/token, one million tokens of KV is **96 GiB** at f16 — and 96 GiB is, to the byte, this
machine's entire Vulkan carveout (103,079,215,104 B). The cache for a 1M window is the same order
as the weights it serves.

To generate one token with full attention over that window, all 96 GiB must be read:

| tier | nominal bandwidth | time per token |
| --- | --- | --- |
| NVMe | ~7 GB/s | ~14 s |
| host RAM | ~50 GB/s | ~2 s |
| GPU-resident | ~1 TB/s | ~0.1 s |

Fourteen seconds per token. Dead on arrival, and no amount of engineering rescues a design whose
inner loop is a full sweep of 96 GiB.

## The second ceiling, which is easy to forget

`context_length` is **262,144**. That is what the checkpoint was converted for and trained to.
Anything past it means RoPE scaling (YaRN or similar) into territory the model never saw, and
quality degrades whether or not the bytes are resident.

So "1M context" for *this* checkpoint is not a storage problem with a paging solution. It is an
extrapolation problem. Reaching a million tokens by retrieval into a correct 32k–262k window is
arguably more honest than stretching positional encoding to a million and calling the result a
context window. This is the same class of claim the project refuses elsewhere: see the served-window
note in [qwen3-omni.md](model-provenance/qwen3-omni.md), where a 65,536-token checkpoint being
served at 131,072 is recorded as a known limitation rather than a feature.

## Why the trunk intuition is right regardless

Attention is empirically **sparse**. For any given query only a small fraction of history carries
weight. The naive design reads all 96 GiB because it assumes every token matters equally; it does
not. The viable design keeps a cheap index of what is out there and pages in only the top-k
blocks. That is the trunk idea, moved to a granularity that survives the bandwidth math.

Prior art to read before building anything, grouped by mechanism:

- **Attention sinks and sliding windows** — StreamingLLM, LM-Infinite. A handful of initial
  "sink" tokens plus a local window supports indefinite generation on a small cache. The sinks
  are literally a trunk, and the finding that a few early tokens are load-bearing is the useful
  surprise.
- **Score-based eviction** — H2O, SnapKV, PyramidKV. Keep the heavy hitters by accumulated
  attention score, evict the rest. Lossy, cheap, no index.
- **Top-k block paging** — Quest, InfiniGen, ShadowKV. Full KV on CPU or disk, a small per-page
  summary resident on the accelerator, top-k page selection per decode step. This is the closest
  published form of the original question.
- **Block-granular cache management** — vLLM's PagedAttention. Pages KV in blocks, but for memory
  efficiency and sharing within a memory tier, *not* for context extension. Useful as the data
  structure, not as the answer.

No performance numbers are quoted here on purpose: none were reproduced on this hardware, and the
published figures are for other backends and other models.

## Two different projects live inside the question

**(A) Engine-level KV paging.** "Attend over this subset of blocks" is a property of the attention
kernels. llama.cpp exposes no such API, so this means patching the engine — selecting blocks,
gathering their KV, attending over the subset, and keeping the summaries that make selection
cheap. Genuine, and a research spike rather than a feature. It is also where the real prize is,
because it is the only path that gives the model true access to distant tokens.

**(B) Prompt-level virtual context.** Available at the Antimatter layer today, with no engine
changes: a durable on-disk span store, a relevance index, and a budgeted packer that fills the
real window each turn as `[system] [pinned facts] [retrieved spans] [recent tail]`. Rolling
compaction is already a crude, lossy version of exactly this.

The honest limit on (B), which should be stated in any UI that ships it: **it is not equivalent to
a wide window.** The model cannot find a relationship between two spans that never appear in the
same window. Retrieval decides what it is allowed to notice. For agentic coding — instructions,
a few files, recent history — that is usually a good fit, and when it is not, the failure is
silent, which is the dangerous part.

## What the pinned runtime already offers

Checked against `--help` on the vendored b11223 Vulkan build actually in use:

| flag | what it gives |
| --- | --- |
| `--cache-ram N` (`-cram`, `-1` unlimited) | a host-RAM KV tier beneath VRAM |
| `--slot-save-path PATH` | persist a slot's KV to disk and restore it |
| `--cache-reuse N` | reuse a cached prefix via KV shifting when it has moved |
| `--context-shift` | indefinite generation by sliding, dropping oldest (lossy) |
| `--ctx-checkpoints` / `--swa-checkpoints` | checkpointing for SWA caches |
| `--cache-type-k` / `--cache-type-v` | KV cache quantization |

`--slot-save-path` is the striking one: it is KV paging primitives already in the box, at
conversation granularity rather than block granularity. It does not widen a window, but it means
a stable prefix — system prompt, project instructions, pinned files — can have its KV computed
once and restored per turn instead of re-prefilled. Spend the real window on
`[warm trunk | live tail]` and never pay prefill for the trunk again. That is a cheap,
non-speculative version of the original idea and needs no new inference code.

## The cheaper win that precedes all of this

The current coder service spends ~18 GiB of VRAM on 6 slots x 32,768 at f16. Quantized KV is
roughly 51 KiB/token against 96, so the same ~18 GiB buys **6 slots x 65,536** — double the real
window, no paging and no new code:

```
--cache-type-k q8_0 --cache-type-v q8_0
```

Two caveats, both untested here: quantized **V** cache generally requires flash attention, and FA
support on the Vulkan backend is uneven, so this may need `-fa` and may simply not work on this
build. Cheap to find out, and worth finding out first — doubling the real window beats any
amount of cleverness applied to a 32k one.

## Ranked, by value per unit of effort

1. **q8_0 KV cache** — potentially a free 2x on the real window. Config only. Test `-fa` on Vulkan.
2. **Trunk / prefix caching** — `--cache-ram -1` plus `--slot-save-path`, with Antimatter keeping a
   stable prefix. Removes repeat prefill cost. Config plus modest app work.
3. **Prompt-layer virtual context** — a real Antimatter feature: span store, index, budgeted
   packer. Large perceived context, with the honest limit above stated in the UI.
4. **Engine-level top-k KV paging** — the research spike. Only path to genuine distant attention,
   and the only item here that requires patching llama.cpp.

## Open questions

1. **Which pain is actually binding?** Prefill latency and "needs distant facts in one window" are
   different complaints pointing at different items above. Item 2 fixes the first and does nothing
   for the second; item 3 is the reverse.
2. **Does q8_0 KV work on this Vulkan build at all**, and what does it cost in output quality on
   agentic coding rather than on a perplexity number?
3. **Is 262,144 enough?** If the honest ceiling is sufficient once reachable, items 1 and 2 may
   close the whole gap and items 3 and 4 never need to start.
4. **How does a packer avoid silent omission?** A retrieval layer that quietly drops the span that
   mattered is worse than a small window the person can see the edge of. Surfacing what was left
   out may matter more than the retrieval quality.
