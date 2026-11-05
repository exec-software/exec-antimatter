# Single-box stack restored on 2026-10-03

> Publication note: host labels and local storage paths are anonymized. Raw workstation
> captures are not distributed with this note; historical measurements retain their original
> scope and are not a fresh qualification of another machine.


The saved `one-box` profile is DeepSeek V4 Flash 0731 **UD-Q2_K_XL** for
general, coding, and security work, with **Qwen3-Omni 30B A3B Thinking Q8_0**
for audio/image input and **Kokoro v1** for speech output.

This restoration was performed on `validation-host-a`, a Strix Halo machine with a
96 GiB Vulkan allocation and approximately 30 GiB of RAM available to Linux.
The earlier host B-related notes describe the same workload identities;
they are not evidence that these services are running on host B now.

## Files and serving configuration

All model payloads reside in `<model-cache>`:

| Directory | Runtime | Endpoint | Context / slots |
| --- | --- | --- | --- |
| `deepseek-v4-flash-0731-ud-q2_k_xl` | pinned llama.cpp Vulkan b11223 | `127.0.0.1:8080/v1` | 131,072 / 1 |
| `qwen3-omni-30b` | same binary, CPU weights and projector | `127.0.0.1:8081/v1` | 32,768 / 1 |
| `kokoro-onnx` | Lemonade Kokoro CPU backend | `127.0.0.1:13305/api/v1` | speech model `kokoro-v1`, voice `coral` |

The existing three DeepSeek shards and two Omni files passed full SHA-256
verification against the pins in [setup workloads](setup-workloads.md) and
[Omni provenance](qwen3-omni.md): 121.67 GiB in total. No replacement download
was needed. The old `kokoro-82m` PyTorch checkpoint remains intact.

Lemonade requires an ONNX checkpoint for its Kokoro backend. The new download
is `mikkoph/kokoro-onnx` at revision
`abf6e2a176872a599e992bd9cf38b370d0eea9e3`. Its `provenance.json` records the
verified file sizes and hashes. A supported local-path registration points to
`kokoro-onnx/index.json`; its internal name is `user.kokoro-v1`, exposed by
the public model list as `kokoro-v1`. No global cache relocation is required.

## Memory correction

The old Omni unit repeatedly exhausted system RAM during loading. The pinned
runtime enables CPU weight repacking, host operation offload, and projector
GPU offload by default. The restored unit explicitly uses:

```text
--n-gpu-layers 0 --device none
--no-mmproj-offload --no-op-offload --no-repack --load-mode mmap
--batch-size 256 --ubatch-size 64 --threads 8 --threads-batch 8
```

This keeps the large Q8 weight mapping reclaimable and the media model off
DeepSeek's GPU allocation. Media inference remains CPU-bound and can be slow.

Persistent user systemd overrides live under
`~/.config/systemd/user/llama-{deepseek,omni}.service.d/`. Both services belong
to `antimatter-inference.slice`, with an 18 GiB soft / 20 GiB hard aggregate
RAM limit and 1 GiB maximum swap. Per-service limits are 6 / 10 GiB for
DeepSeek and 12 / 16 GiB for Omni, each with 512 MiB maximum swap. Automatic
failure restarts are disabled so a failed model cannot repeat an OOM cycle.
The original unit files are preserved. Both services are enabled at user login.

## Subagents and routing

The app still selected `two-box`, whose Nemotron and `host-c-coder` bindings
were unavailable in the current source catalog. Selection was restored to
`one-box`; all ten installed agents now resolve to a configured source and
model. Automatic delegation and MCP tools were already enabled.

`--parallel 1` limits simultaneous model execution, not agent creation.
`start_agent` returns promptly and child model requests queue at the server.
The parent's inference slot is released before it executes tools or waits
for children. A regression test covers three children and their parent
finishing through one shared slot. A live test also submitted two concurrent
DeepSeek requests: both returned their requested markers and the server
remained healthy with one slot.

The historical four-sequence crash belongs to the **Qwen3.8-27B BF16 RPC
stripe** in `llama-stripe-qwen38.service`, not this DeepSeek configuration.
The recorded `tensor not allocated` abort reproduced with four distinct
prompts after MTP was removed. Raising this stack to four slots is therefore
neither required for dispatch nor supported by that historical evidence.

The main model choice and initial voice settings were restored to DeepSeek, Omni
audio input, and Kokoro/coral output. The dedicated live-input replacement below
supersedes that initial Omni transcription selection. Existing configuration files were
backed up privately before modification. Validation used synthetic requests;
no microphone capture was started.

## Initial live validation and Omni transcription limitation

Both model services remained healthy together after the corrected startup.
Kokoro produced a valid mono 24 kHz WAV with the configured `coral` voice.
The two short concurrent DeepSeek requests completed in approximately 0.94
and 1.81 seconds, respectively; these tiny probes are not throughput benchmarks.

The actual Antimatter transcription adapter accepted the synthetic 3.075-second
Kokoro recording and returned text in about 20.7 seconds. It recovered
"Antimatter audio is ready." but appended "Please begin.", which was not
spoken. An independent short-prompt check also appended extra words. Audio
transport works, but this CPU Omni transcription path is slow and its fidelity
needs further tuning or a separately chosen dedicated transcription model.
Do not silently remove phrases from transcripts to make the check pass.

## Dedicated streaming transcription

The voice-input setting now uses **Moonshine-Medium-Streaming** through the
existing Lemonade service, while DeepSeek remains the coding model, Omni
remains the media-understanding model, and Kokoro/coral remains speech output.
Moonshine is an English-only recognizer. It runs on CPU and does not consume
the nearly-full Vulkan allocation. The installed Lemonade version is
`2026.40.0`; its CPU backend bundle is `moonshine0.0.62`.

Models are pinned to `UsefulSensors/moonshine-streaming` revision
`da30bae714913eb0057e733bccb4700104afb1b0`. Every downloaded large file was
checked against its upstream SHA-256; small Git-managed metadata files were
checked against their Git blob identifiers, and their SHA-256 was also recorded.
Exact byte sizes and hashes are in
[the validation manifest](moonshine-streaming-validation.json), as well as
each model directory's `provenance.json`.

| Directory under `<model-cache>` | Variant | Downloaded bytes | Selection |
| --- | --- | ---: | --- |
| `moonshine-small-streaming` | `onnx/small` | 463,482,214 | comparison retained |
| `moonshine-medium-streaming` | `onnx/medium` | 1,157,220,214 | live voice input |

Both use supported `local_path` registrations, with public model names
`Moonshine-Small-Streaming` and `Moonshine-Medium-Streaming`. The tokenizer's
derived `tokenizer.bin` was generated from the verified `tokenizer.json`
using the upstream server's conversion format. No global model-cache
relocation or Lemonade restart was needed. Kokoro stayed loaded throughout.

The synthetic controls use Kokoro speech converted to valid mono PCM16 at
16 kHz. No microphone was opened. Audio was sent in real time, in 100 ms
chunks, rather than uploaded instantly. These checks establish this machine's
behavior on these clips, not an accent/noise benchmark or a guarantee of
error-free recognition.

| Control | Observed result |
| --- | --- |
| Omni, normalized 3.075 s clip | 14.4 s; added "Please begin." |
| Omni, pure 2 s silence | 10.4 s; echoed "Transcribe this recording." |
| Omni, audio-only prompt | 21.9 s; added "Please say something." |
| Moonshine Small, same speech | first caption 1.2 s; misrecognized "Antimatter" as "And to matter" |
| Moonshine Medium, same speech | first nonempty caption 1.7 s; correct words, differing sentence punctuation; final at 3.227 s |
| Moonshine Medium, 14.875 s command | first caption 1.2 s; correct words and numbers including four agents, 27, and 15 seconds |
| Moonshine Small and Medium, 3 s silence | no transcript |

The actual Antimatter transport was then exercised with the same speech and
silence. It emitted `Antimatter audio. is ready.` and an empty silence result;
the final callback preceded the successful commit promise. A push-to-talk
commit arrived before the final event in the raw protocol, so an acknowledgement
alone is not treated as completion. Pending finals have a bounded deadline
and fail visibly instead of silently dropping the last words.

An end-to-end synthetic check also ran the actual `VoiceController`, its
stateful 24-to-16 kHz resampler, and this WebSocket transport against Medium.
It produced exactly one user turn, `Antimatter audio. Is ready`, at 3.136 s,
with the first draft caption at 1.207 s and no errors. The recording was fed
in the recorder's real 2,048-sample cadence; no microphone or speaker was used.

Moonshine can split a sentence into several native final segments and can
revise wrong interim hypotheses before finalizing. Antimatter combines these
segments until its local utterance ends; it does not submit partial captions
as chat turns or perform phrase-specific substitutions. It uses the
[documented realtime protocol](https://lemonade-server.ai/docs/guide/configuration/moonshine/)
over `/api/v1/realtime`, with no browser cloud recognizer.
