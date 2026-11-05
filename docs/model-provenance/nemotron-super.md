# Nemotron 3 Super provenance and deployment choice

> Publication note: host labels and local storage paths are anonymized. Raw workstation
> captures are not distributed with this note; historical measurements retain their original
> scope and are not a fresh qualification of another machine.


This note records why the built-in **Two boxes** orchestration profile names the pinned Q8_0
checkpoint, while retaining Q4_K_M as a smaller manual alternative. It is evidence for a
deployment choice, not a claim that native Beholdd can execute the model.

## Single-pool Q4_K_M fallback

The model already used by the local llama.cpp router is:

- Served id: `lmstudio.NVIDIA-Nemotron-3-Super-120B-A12B-Q4_K_M`
- Repository: `lmstudio-community/NVIDIA-Nemotron-3-Super-120B-A12B-GGUF`
- Pinned revision: `16410500b9bdc62081c34cc2dff52471e001f970`
- Architecture: `nemotron_h_moe`
- Precision: `Q4_K_M` weights; the old router separately used Q8_0 for its K/V cache
- Context in the old router preset: 32,768 tokens
- License metadata: `nvidia-open-model-license`

The three GGUF shards total 86,051,079,584 bytes (80.14 GiB):

| Shard | Bytes | Upstream SHA-256 |
| --- | ---: | --- |
| `NVIDIA-Nemotron-3-Super-120B-A12B-Q4_K_M-00001-of-00003.gguf` | 39,205,633,408 | `2cf8e99b9b71babc5932eb594b1fe1f9b9e407a460a5b49b0625f0c25e0ba799` |
| `NVIDIA-Nemotron-3-Super-120B-A12B-Q4_K_M-00002-of-00003.gguf` | 39,720,681,760 | `770b505e6fe3b19b422b5b0dd06201b07218d0af99e72e69086208983fe54219` |
| `NVIDIA-Nemotron-3-Super-120B-A12B-Q4_K_M-00003-of-00003.gguf` | 7,124,764,416 | `7420107ccfc77230deaf57971ae84a58a18c4e6e035aa99cf0e25fbbc4c7614a` |

The shard sizes and GGUF metadata were checked on the model host at
`<model-cache>/lmstudio-community/NVIDIA-Nemotron-3-Super-120B-A12B-GGUF`. The hashes above are the
repository's pinned LFS object hashes; the 80 GiB share was not reread solely to duplicate them.
The local router path convention was
`~/.lmstudio/models/lmstudio-community/NVIDIA-Nemotron-3-Super-120B-A12B-GGUF/` followed by the
first shard's filename.

This is the only published precision in the inventory that leaves credible runtime and cache
headroom in the current 96 GiB GPU-visible memory pool. A fit remains subject to context length,
cache precision, driver allocations, and the serving runtime; 80.14 GiB on disk is not a promise
that every 96 GiB configuration will load it.

## Default Q8_0 checkpoint

Antimatter previously completed this four-shard Q8_0 download, and the built-in orchestration
profile now uses its stable catalog id `nvidia-nemotron-3-super-120b-a12b-q8_0`:

- Repository: `unsloth/NVIDIA-Nemotron-3-Super-120B-A12B-GGUF`
- Pinned revision: `036038fb30334a2d56a146c6f0d4871ab5edccbb`
- Total: 128,472,991,680 bytes (119.65 GiB)
- License metadata: `nvidia-nemotron-open-model-license`

| Shard | Bytes | SHA-256 |
| --- | ---: | --- |
| `Q8_0/NVIDIA-Nemotron-3-Super-120B-A12B-Q8_0-00001-of-00004.gguf` | 7,872,576 | `7efc3a9c77a65929897e2fed1d1d670d514297508485f80996e77004f5e81332` |
| `Q8_0/NVIDIA-Nemotron-3-Super-120B-A12B-Q8_0-00002-of-00004.gguf` | 49,004,160,864 | `1dd0a70006703d67ab63a07b49c5ef97cf3081b94549daef6eb792ce225a48b9` |
| `Q8_0/NVIDIA-Nemotron-3-Super-120B-A12B-Q8_0-00003-of-00004.gguf` | 49,284,659,200 | `31dea2f2172a5ce5456ee5d55f4d4cc2bf18e5ddc6c3e6d512281fe65163deba` |
| `Q8_0/NVIDIA-Nemotron-3-Super-120B-A12B-Q8_0-00004-of-00004.gguf` | 30,176,299,040 | `4962476f3703a5f9e613b431b866d0344ac361ccae61a0e7e21ed8f8b47b5d3b` |

The same pinned Unsloth revision also publishes `UD-Q8_K_XL` at 132,485,760,992 bytes. That is a
real alternative, but it is not the artifact named by Antimatter's retained download record and
costs another 4,012,769,312 bytes before runtime state. The default therefore selects the exact
Q8_0 checkpoint instead of guessing between two similarly named eight-bit variants.

The persisted download record reached `ready` and registered the path with the old external Vulkan
source. Native Beholdd rejected its `nemotron_h_moe` architecture. No retained Carbon proves a
successful Q8_0 inference, and the weights alone exceed one 96 GiB pool. The default therefore
requires a compatible source that can stream the exact checkpoint or use the configured RPC peer;
it must fail clearly instead of silently substituting Q4 or another architecture.

## High precision is BF16, not FP16

The official high-precision model is
[`nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16`](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16),
pinned during this review at `2dc98e2afe4face0e4ce40972a915c45368bd34a`. The corresponding
Unsloth BF16 GGUF set at the Q8 revision above is five shards totaling 241,518,659,424 bytes. There
is no FP16/F16 sibling in that repository. NVIDIA's model card calls for at least eight H100 80 GB
GPUs for the official BF16 deployment path; it is not a one-host fallback.

The conversion repositories expose different license labels, and this record preserves that
distinction rather than treating similarly named NVIDIA terms as interchangeable:

- The pinned LM Studio Q4_K_M card declares `nvidia-open-model-license` and links the
  [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/).
- The pinned Unsloth Q8_0/BF16 card declares `nvidia-nemotron-open-model-license` and links the
  [NVIDIA Nemotron Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/).

These are provenance facts rather than a legal conclusion. Read and retain the license named by
the exact artifact revision before redistributing weights; Antimatter does not bundle them.

## Previous Fable binding

The original profile used `gpt-oss-120b-fable5`, whose locally verified Q5_0 file matches
`autotrust/gpt-oss-120b-Fable-5-Distilled-GGUF@6267ea7916542d06b45846a7bbd2c4657a7f16a4`
(80,689,581,856 bytes, SHA-256
`e1e9238376dfe63559c4aa5767c96ec911f9ad6c3ba1ad69cfb9732b9f1d84a4`). The derivative's model
card declares no license. Apache-2.0 covers upstream GPT-OSS, but must not be assumed to authorize
redistribution of this derivative. The built-in migration therefore changes only an exact,
byte-for-byte generated profile; any user-edited YAML remains untouched.

## Runtime boundary

The bundled native Beholdd engine does **not** currently support `nemotron_h_moe`. The profile is
usable only when exactly one configured compatible source advertises
`nvidia-nemotron-3-super-120b-a12b-q8_0`. Until native support reaches parity, that source is
expected to be a separately configured llama.cpp router and must not be labeled native Beholdd.
