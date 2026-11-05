# Setup workload catalog

> Publication note: host labels and local storage paths are anonymized. Raw workstation
> captures are not distributed with this note; historical measurements retain their original
> scope and are not a fresh qualification of another machine.


The catalog in `src/main/workloads.ts` freezes four GGUF downloads and records the scope of
the evidence behind their settings. The term **prepared workload** does not mean certified
on every supported machine. This implementation pass did not download weights or run inference.

All revisions, file sizes, and SHA-256 LFS identities were checked through the publishers'
Hugging Face model APIs on 2026-10-03. Downloading uses Antimatter's existing Hub queue, with
resume, free-space checks, and SHA-256 verification before activation. Paths and file lists
come from the main-process catalog. The renderer supplies only a catalog ID.

| Workload | Frozen revision | Payload | Runtime |
| --- | --- | ---: | --- |
| Qwen3-Coder 30B A3B Instruct Q8_0 | `e9eb3e611bdcd5842e021c014b392c70746da574` | 32,483,934,528 bytes | llama.cpp Vulkan |
| Qwen3-Omni 30B A3B Thinking Q8_0 | `6807f126832efa5bce2969fec85a80594e21df9d` | 33,809,513,856 bytes | llama.cpp Vulkan with `mmproj` |
| DeepSeek V4 Flash 0731 UD-Q2_K_XL | `fbbb5b93fb787c21338159b0af3318bb3f4d9768` | 96,832,508,352 bytes | llama.cpp Vulkan |
| MiMo V2.6 Flash RL MXFP4 | `a5d1269fdcf9c3346934411f700038e9cd9d5102` | 167,369,465,152 bytes | llama.cpp Vulkan across configured RPC peers |

## Consumer coding workload

Qwen uses the exact file, revision, size, and hash already in `releases/model-manifest.json`.
The existing installer and Beholdd serving documentation are the integration evidence. The
[upstream model card](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct) describes a
30.5B-total/3.3B-active text coding model with tool calling. The frozen quantization is from
[lmstudio-community](https://huggingface.co/lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF/tree/e9eb3e611bdcd5842e021c014b392c70746da574).

The setup preset uses one slot and a 32,768-token context floor, with an 8,192-token reply
ceiling. GPU offload remains adaptive with explicit `fit = on`. With no RPC peers it selects
the local `Vulkan0` device; with peers it leaves the device list open so remote GPUs participate.
This is a conservative prepared preset, not a claim
that the Q8 weights fit entirely on a 16 or 24 GiB card; those machines need CPU spill and
enough host memory. The existing native Beholdd CPU streaming installer profile remains
separate; this workload does not automatically fall back to that engine.

## Multimodal workload

Qwen3-Omni reuses the pins already recorded in [its provenance note](qwen3-omni.md): revision
`6807f126832efa5bce2969fec85a80594e21df9d`, the `Q8_0` weights at 32,484,493,632 bytes, and the
`Q8_0` projector at 1,325,020,224 bytes, with the SHA-256 identities taken from the downloaded
files on the verified box rather than copied from the model card.

This is the catalog's first entry whose weights are not the whole workload. The hub groups an
`mmproj` file as a `projector` variant rather than a model shard, so the catalog carries it as a
separate `projector` pin with its own variant key. Both pieces are enqueued as independent
resumable records, each SHA-256 verified; `listWorkloads` reports the weaker of the two states, so
the card reads `ready` only when both files have been verified. Setup then checks both against
their pinned size and hash before writing a preset, and emits `mmproj =` beside `model =`. The
reason for that strictness is that the failure mode is quiet: llama-server starts without a
projector, answers text normally, and reports `modalities.vision: false`.

The preset pins `ctx-size` and `fit-ctx` to the checkpoint's own 65,536 tokens, which is what
`qwen3vlmoe.context_length` declares, rather than the 131,072 the global Beholdd config serves to
everything. Offload uses adaptive `fit = on` like the other 30B entry, so a smaller card spills to
CPU rather than refusing to load. The provenance note records that the pinned b11223 Vulkan build
carries the `qwen3vlmoe`, `qwen3vl_merger`, and `qwen3a` symbols this checkpoint needs; that
symbol check, and the serving of the media roles, is the evidence here. The model publishes no
agentic coding result and was not adopted as a coder.

## DeepSeek

The three [Unsloth GGUF shards](https://huggingface.co/unsloth/DeepSeek-V4-Flash-0731-GGUF/tree/fbbb5b93fb787c21338159b0af3318bb3f4d9768/UD-Q2_K_XL)
have the same pinned revision and SHA-256 identities as the local download metadata under
`<model-cache>/deepseek-v4-flash-0731-ud-q2_k_xl/.cache/huggingface/download`.
Only metadata was read, not the weight files. The existing `llama-deepseek.service` uses
131,072 context tokens, one slot, and full GPU offload. Its documented hardware is a 96 GiB
GPU allocation. `src/main/agents/profiles.ts` independently records this exact quantization
as the one-box generalist. The setup preset preserves those values.

Historical experiments using a different engine or checkpoint format do not establish a
benchmark for this GGUF deployment. Native bundled Beholdd is not advertised as a DeepSeek server.

## MiMo

The [ggml-org two-shard MXFP4 set](https://huggingface.co/ggml-org/MiMo-V2.6-Flash-RL-GGUF/tree/a5d1269fdcf9c3346934411f700038e9cd9d5102)
matches the filename, quantization, and 155.87 GiB size in the Beholdd MiMo decode gate. That
gate compared a native correctness harness with llama.cpp Vulkan across two machines. It
explicitly did not claim production native Beholdd serving support. The local gate notes do
not record SHA-256 identities, so this catalog does not claim a retrospective hash match to
that experiment; the download hashes are independently frozen from the publisher's metadata.

Antimatter's `src/main/modelProfiles.ts` documents actual MiMo session behavior and the
16,384-token reply ceiling and 16-call batch limit derived from it. The prepared preset uses
those limits and a 131,072-token context. No developer LAN addresses or SSH commands are
copied into the catalog. A person supplies reachable RPC peers running the same llama.cpp
build. The 155.87 GiB weights need combined memory beyond one 96 GiB GPU, plus runtime and
context space. Configuration is lazy: selecting the model starts its runtime.

## Verification boundaries

The catalog tests check complete shard grouping, trusted IDs, frozen installer identity,
exact revision matching, settings bounds, and rejection of injected preset fields. For the
multimodal entry they also check that the projector groups as its own complete `projector`
variant, that both files are enqueued against the one reviewed revision, that the combined
download state is the weaker of its parts, that a projector workload cannot be configured without
its projector, that a text-only workload cannot be handed one, and that the projector path is held
to the same absolute-path and injection rules as the model path. Setup
tests cover private atomic persistence, resumed first launch, preservation of existing
installations, and write failures. Target-hardware inference and multi-host peer validation
remain separate runtime checks; a successful download alone is not a model capability test.

See [the single-box restoration](single-box-restoration.md) for the subsequent
live DeepSeek/Omni/Kokoro checks, CPU memory correction, and remaining voice limitation.
