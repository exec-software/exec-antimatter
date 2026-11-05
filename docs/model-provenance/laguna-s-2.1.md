# Laguna S 2.1 provenance, and why it needed no engine work

Added to the workload catalog on 2026-11-01 as `laguna-s-21-118b-iq4`.

## The checkpoint

| field | value |
| --- | --- |
| repository | `unsloth/Laguna-S-2.1-GGUF` |
| revision | `750f92f90cf54159c4d7a610cb7b3e74498e75c6` |
| quantization | `UD-IQ4_XS` |
| files | three shards, 53.6 GiB total |
| upstream model | `poolside/Laguna-S-2.1`, 118B total / ~8B active MoE |

| shard | bytes | sha256 |
| --- | --- | --- |
| `UD-IQ4_XS/Laguna-S-2.1-UD-IQ4_XS-00001-of-00003.gguf` | 3,683,648 | `a6378c893a836ee2649fbb24d60e3e9489313bd873fa53c7ffeb814466fe8867` |
| `UD-IQ4_XS/Laguna-S-2.1-UD-IQ4_XS-00002-of-00003.gguf` | 49,820,135,904 | `d9d8482e132457db41c8407958bc478dbc4f1389c53e55ae8a8fd48a478142c2` |
| `UD-IQ4_XS/Laguna-S-2.1-UD-IQ4_XS-00003-of-00003.gguf` | 7,742,884,768 | `6fde44340ca9be41cddc86661acce1518cbaf08875f0daa6e393b62228b59dbd` |

Both halves of that table were established twice and independently: once by hashing the files
already on this box, and once from what Hugging Face publishes for that revision
(`POST /api/models/unsloth/Laguna-S-2.1-GGUF/paths-info/750f92f9…`, reading `lfs.oid`). The two
agree exactly on all three sizes and all three digests.

Shard 1 being 3.5 MiB is not a truncated download. It holds metadata only; the weights are in
shards 2 and 3. A directory listing therefore looks lopsided, and that is expected.

## Why this rung

The Unsloth ladder for this model is 37.0 (UD-Q2_K_XL) / 50.3 (UD-Q3_K_M) / **53.6 (UD-IQ4_XS)** /
68.4 (UD-Q4_K_XL) GiB. On the recorded 96 GiB carve-out, 68.4 GiB fits the weights and leaves
essentially nothing for cache and compute buffers. IQ4_XS leaves roughly 25 GiB clear after
weights and a 131,072-token q8_0 cache, which is what makes it servable rather than merely
loadable.

## The cache, read from the header rather than assumed

48 blocks, `head_count_kv` 8, k/v length 128, and a `head_count` array of `[48, 72, 72, 72]`
repeating. That last part is the whole story: **one block in four is global attention and the
other three are sliding-window at 512**. Only the 12 global blocks grow with the conversation, at
4 KiB/block/token = **48 KiB/token**; the 36 sliding-window blocks are a fixed ~72 MiB regardless
of how long the conversation gets.

So 262,144 tokens would cost 12.0 GiB at f16 or 6.0 GiB at q8_0 — cheap for a 118B model. The
checkpoint reaches 262,144 by YaRN at factor 32 from an 8,192 original context length. The
catalog pins **131,072**, because that is the window actually served and measured on this box;
the larger one is available but is not what the evidence covers.

## Why no engine work was needed

This is the part worth recording, because the assumption going in was the opposite.

`laguna` is **upstream in llama.cpp** and is compiled into the b11223 Vulkan runtime this
application already ships at `vendor/llama-vulkan` (tag `b11223`, commit
`4da6337767f973e2b4d0797e5b323d77d8565e4a`). Checked by the usual method — grepping the shipped
runtime's own symbols, the same way a GGUF is vetted before it is downloaded:

```
$ strings vendor/llama-vulkan/runtime/libllama.so | grep -i '^laguna'
laguna
laguna.cpp
Laguna: unexpected attention gate width %lld at layer %d (expected %lld per-head or %lld per-element)
```

The bare arch name sits alongside `qwen3moe` and `deepseek2`; `laguna.cpp` means the model
implementation is linked in, and the third line is a Laguna-specific runtime diagnostic. This is
real support, not an incidental string. It was verified **before** the 53.6 GiB was spent.

Consequences, stated plainly so they are not re-litigated:

- **No backend has to be fetched from the build server** for this workload, and nothing new has
  to be placed in the Beholdd repository. A stock install can already serve it.
- `vendor/llama-vulkan-f32` — the F32 repair that Mistral Small 4 depends on — has **no** laguna
  support, and does not need it. That repair exists for MLA expert computation and is a
  different path.
- HAG (`vendor/beholdd-hag`, the native Rust server) is a separate engine and does not serve
  this. Laguna is pinned to `backend: vulkan`, which is what every other large workload here
  uses, so HAG's coverage does not gate it.
- `exec-software/strix-llama.cpp` carries its own `src/models/laguna.cpp` and conversion script.
  That fork is not what served this model and is not required by this entry.

ROCm is not an option on this APU for this checkpoint regardless: it advertises only free system
RAM (~26 GiB of 31), which cannot hold these weights. Vulkan is named explicitly rather than
`auto` for that reason.

## What was measured

One session, carbon `54f608a4`, on 2026-10-31/11-01. Laguna S 2.1 wrote an **end-to-end Matrix
application that runs** — the first model on this box to do so. Matrix is a language no model has
training data for, which is precisely why it is the interesting test: scale alone buys nothing.
Roughly **18 tok/s** during that work, over about 456 tool calls.

Beholdd's own fit planner reported, for this model on this box:

```
model+headroom ~65 GiB > sysfs (Vulkan/RADV — full UMA) ~56 GiB, but this is an MoE
(3.9% of experts active per token) -> experts to CPU, dense trunk on GPU.
Slower, identical output
```

That spill is why 18 tok/s is the number and not something higher, and it is also why the spill
is acceptable: with 3.9% of experts active per token, a partial offload is slow rather than
useless.

## What this is not

- **Not a benchmark.** One observation, one box, one task. poolside publishes its own agentic
  scores; none of them are reproduced here and none are claimed by this entry.
- **Not evidence for Pensieve.** The run happened inside the Pensieve corpus directory, and the
  model reached the corpus with `read_file` rather than `pensieve_recall`, which it never called.
  Whatever produced this result, the recall path was not exercised. See the session notes.
- **Not a statement about smaller machines.** Every memory figure above is from the recorded
  96 GiB allocation. A smaller card will spill further; that has not been measured.
