# Qwen3-Omni provenance and the media roles

This note records why the built-in **Two boxes** orchestration profile binds its `audio` and
`image` roles to Qwen3-Omni-30B-A3B-Thinking, and what had to exist in Beholdd before that
binding meant anything. It is evidence for a deployment choice, not a claim that this model is
a better coder than the one it sits beside.

## What it replaced

Both media roles previously named `qwen3-coder-30b`. That model is text-only: an agent tagged
`image` was bound to something that cannot look at one, and `preview/vision.ts` says so in its
opening paragraph. The arrangement was honest while nothing on the box could see. It stopped
being honest once something could.

The `code` role did not move. Omni is not the better coder — see "What this is not" below.

## The checkpoint

- Served id: `qwen3-omni-30b`
- Repository: [`ggml-org/Qwen3-Omni-30B-A3B-Thinking-GGUF`](https://huggingface.co/ggml-org/Qwen3-Omni-30B-A3B-Thinking-GGUF)
- Pinned revision: `6807f126832efa5bce2969fec85a80594e21df9d`
- Base model: [`Qwen/Qwen3-Omni-30B-A3B-Thinking`](https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Thinking) at `2f443cfc4c54b14a815c0e2bb9a9d6cbcd9a748b`
- Architecture: `qwen3vlmoe` (128 experts, 8 active; 48 blocks; embedding length 2048)
- Precision: `Q8_0` weights and `Q8_0` projector
- Context in the checkpoint: 65,536 tokens (`qwen3vlmoe.context_length`)
- License metadata: base card declares `license: other` with `license_name: apache-2.0`; the
  GGUF conversion carries no license field of its own and declares only its `base_model`

The two files total 33,809,513,856 bytes (31.49 GiB):

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Qwen3-Omni-30B-A3B-Thinking-Q8_0.gguf` | 32,484,493,632 | `a146426ed58329962e3f9b582123d1e06dad64cb2454728d7be883bc7a5658c7` |
| `mmproj-Qwen3-Omni-30B-A3B-Thinking-Q8_0.gguf` | 1,325,020,224 | `2bd5459571f8230a0c251d3d0dd36267753f0800ed145449a34f220a31f93898` |

Held on NVMe at `~/.beholdd/models-local/qwen3-omni-30b`, reached through the
`~/.beholdd/models/qwen3-omni-30b` symlink the config path uses. The hashes above are of the
downloaded files on this box, not values copied from the card.

`bf16` (61.10 GB) and `Q4_K_M` (18.56 GB) exist in the same repository. `bf16` was not taken:
it fits VRAM but not comfortably beside anything else, and Q8_0 on a 30B-A3B MoE is not a
quality question worth 28 GB of a disk that was already 93% full.

## Why no new architecture was needed

The conversion is `qwen3vlmoe`, which the installed backend already carries. Checked against
the b10361 Vulkan build actually in use rather than against release notes:

- `libllama.so` exports `qwen3vlmoe` alongside `qwen3vl`, `qwen3moe`, `qwen3next`
- `libmtmd.so` carries `qwen3vl_merger` and `qwen3a`, the projector types this mmproj declares,
  plus `clip_graph_whisper_enc` and `mtmd_audio_preprocessor_whisper` for the audio tower

The projector header declares both `clip.has_vision_encoder` and `clip.has_audio_encoder`, so
images and audio both arrive through the one file.

The b10361 reading above is left as written, because it records what was checked at the time. On
2026-09-30 the pinned runtime moved to b11223 for an unrelated reason — b10361 cannot serve a
striped `glm-dsa` model, see upstream #28047 — and the same four symbols were re-checked against
the new build before the pin changed. All still present, so this conclusion carries forward. It is
worth re-checking on any future bump: Qwen3-Omni is the only thing serving the image and audio
roles, and a runtime that quietly dropped `qwen3a` would take both with it.

## What had to be built

Beholdd had no `mmproj` passthrough: `FitPlan::to_preset_section` emitted the model, the layer
count, the shards and the cache types, and nothing about a projector. The failure this produces
is not an error. llama-server starts, answers text normally, and reports
`modalities.vision: false` — which `preview/eyes.ts` correctly reads as "this model cannot
see", so the look is never routed to it.

`beholdd-fit` now finds the projector beside the weights, counts its bytes against memory
before deciding placement, and emits `mmproj =` into the preset. Exactly one `mmproj-*.gguf` in
the model's directory is a find; several are a refusal to guess, reported in the plan rationale,
because readdir order must not decide what the model computes.

## Known limitation: the served window

`default_context` in `~/.beholdd/config.yaml` is global, so this is served at 131,072 like
everything else, above the checkpoint's own 65,536. Antimatter's published-window table has the
correct 65,536, but a window a server reports is believed over a published one — by design, and
correctly, since what a server will accept is the fact.

For the media roles this is close to harmless: a look at a screenshot is a few thousand tokens.
If a long media turn ever starts losing its oldest messages, pin the window in that model's
profile. The real fix is per-model context in Beholdd, which does not exist yet; the same note
already sits against `minimax-m2` in that config for the same reason.

## What this is not

Qwen3-Omni-30B-A3B-Thinking is a perception model, not an agentic coder, and was not adopted as
one:

- Its window is 65,536 against the coder's 262,144
- It publishes no SWE-bench result; `BFCL-v3` is 63.2 and `MultiPL-E` 80.6, which is
  single-file completion rather than agentic work
- Qwen's own table shows the omni tax on text against the text-only sibling of the same
  generation — `AIME25` 85.0 on Qwen3-30B-A3B-Thinking-2507 against 73.7 here
- `salvage.ts` and `toolPolicy.ts` are written around `qwen3-coder`'s specific failure modes

What it is: 3B active parameters that can read a screenshot and hear a recording, served on the
loopback where a picture of this desktop never leaves the machine to be described.
