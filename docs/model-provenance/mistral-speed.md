# Mistral Small 4: speed investigation

> Publication note: host labels and local storage paths are anonymized. Raw workstation
> captures are not distributed with this note; historical measurements retain their original
> scope and are not a fresh qualification of another machine.


Recorded 2026-10-11 on `validation-host-a`, Radeon 8060S/RADV, after the
[F32 expert-operation repair](mistral-small-4.md). The patched b11223 runtime
generates approximately **44 tokens/s** with the existing Q4_K_M checkpoint,
131,072-token context, parallel 1, eight CPU threads and unchanged memory limits.
An independent host B A/B/A experiment shows lower prompt-processing latency
with the optional settings described below. host A's production defaults remain
unchanged pending an uncontended local comparison.

## Measurements and excluded experiments

The baseline used three prompts, three repetitions each, and 256 generated
tokens per request. Prompt lengths were 47, 46 and 1,258 tokens; all requests
reported zero cached prompt tokens. Disabling MMVQ was tested twice per prompt:

| Case | Baseline median tok/s | No-MMVQ median tok/s | Difference |
| --- | ---: | ---: | ---: |
| Coding | 44.549 | 45.275 | +1.63% |
| Explanation | 44.548 | 45.187 | +1.43% |
| Context edit | 43.496 | 44.262 | +1.76% |

This **1.4–1.8% matched-case gain is preliminary**. The runs were not
counterbalanced, the baseline's first round was slower, and the candidate has
only two observations per case. The pooled median's 2.6% increase mixes cases
and unequal sample counts; it is not a confirmed speedup. TTFT differences are
inconclusive, and some generated outputs differ. MMVQ retains its existing automatic selection by default.
Confirmation needs repeated, equal-count comparisons with matching warmup,
cache state and otherwise idle hardware, including a return to the original
configuration to check drift.

Vector workgroup experiments produced small microbenchmark gains insufficient
to justify adoption; those geometry changes were rejected. The graphics-queue
run overlapped compilation and is excluded from performance claims. Tile-cap 32
and the later control overlapped `Overwatch.exe`, which started at 13:02:03 local
time. Tile measurements ran from 13:02:43 to 13:03:28; the later control observed
99% GPU utilization and was stopped after three cases. Neither tile32's apparent
prefill improvement nor its apparent decode regression is verified. These runs
do not invalidate the earlier baseline/no-MMVQ measurements, which preceded the
game's launch.

The [experimental runtime options](../../patches/llama.cpp/README.md#optional-per-process-performance-experiments)
document the optional F32 matrix tile cap and upstream MMVQ flag. Both are opt-in;
installing the patch does not enable them. They preserve the checkpoint and
Mistral's required F32 expert input, but changing activation kernels need not
produce identical token sequences.

## Where generation time goes

An instrumented 32-token request produced 31 decode timing tables. Startup's
two-token probe and the actual prompt-processing table were separated from
decode. Expert matrix operations account for **45.1%** of measured decode GPU
time, including **16.0%** in the repaired expert down-projections. The vocabulary
output projection accounts for 8.5%; attention accounts for 1.3%.

Using the exact quantized block sizes, four selected experts, and distinct MLA
head matrices gives approximately 4.307 GB of useful weight payload per decode
step. Dividing by the matrix/vector operation times gives 206 GB/s; dominant
large operations individually reach roughly 188–228 GB/s. Their low arithmetic
intensity and similar byte-proportional costs are consistent with
memory-dominated decoding. These estimates are **not DRAM counter measurements
or proof of hardware-bandwidth saturation**: cache reuse, repeated reads,
activation traffic and profiling overhead affect the interpretation.

## host B sustained-load check

host B's initial baseline completed all nine requests, but it did not sustain
its starting speed. The first two rounds produced roughly 42 tokens/s on the
short prompts and 41 tokens/s on the context-edit prompt. The last round fell
to 38.29, 31.52 and 23.12 tokens/s respectively. Recorded GPU temperature rose
from 54°C before the first request to 87°C after the last.

This is a **sustained-load regression**, separate from the prefill result below.
Reported core clocks rose during the slowest requests, while the memory-clock
listing stopped identifying an active level. Neither observation proves a
particular throttle mechanism. The baseline's inference-window observer saw no
OOM/max-memory events and only 273 microseconds of additional full memory
pressure; active cgroup reclaim does not explain the large slowdown. Loading
caused much greater reclaim earlier and is measured separately.

The second and third rounds generated identical per-case output hashes. Their
decode rates fell by 9.95%, 26.30% and 43.67%, while prefill rates changed by only
0.31–1.05%. Continued graph reuse and stable allocated VRAM also argue against
changing output, repeated graph construction or growing allocation explaining
this particular drift. The memory observer ran separately from the baseline
harness and may omit approximately the final second; its counters are not an
exact whole-request boundary measurement.

The remote checkpoint is on network storage. Its baseline loaded in 663.5 seconds
using sequential reads (`--load-mode none`), avoiding whole-file mmap prefaulting.
That startup time is excluded from prompt/generation timings. Both configurations
use this loading mode, the same weights, 128K context and parallel 1. host A's
existing local-storage loading mode remains unchanged.

The candidate combined `GGML_VK_F32_MMID_TILE_CAP=32` with
`GGML_VK_DISABLE_MMVQ=1`. A return to the original settings completed after HAG's
qualification window, producing 27 total requests across A/B/A. Each case has
three serial observations per configuration, with these descriptive medians:

| Case | Initial tok/s | Candidate tok/s | Return tok/s | Initial TTFT | Candidate TTFT | Return TTFT |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Coding | 42.520 | 43.457 | 42.724 | 1.189 s | 1.048 s | 1.191 s |
| Explanation | 42.777 | 43.442 | 42.798 | 0.993 s | 0.818 s | 0.985 s |
| Context edit | 41.050 | 42.359 | 41.678 | 7.523 s | 4.732 s | 7.473 s |

The candidate's last round still fell to 41.33, 36.17 and 26.53 tokens/s, with
recorded edge temperature reaching 86°C. Its inference-window memory-event and
pressure deltas were all zero. The return control fell to 35.67, 28.97 and 21.02
tokens/s in its last round, with only 94 microseconds of additional full memory
pressure and no max-memory/OOM events. All 27 measurements are retained; no hot
rows were discarded.

**Prefill improvement repeated across these host B fixtures.** Candidate
prompt processing was faster in all nine matched requests against both controls.
Context-edit median prefill rates were 167.37 / 268.12 / 168.51 tokens/s in A/B/A
order; the two controls' median prompt times differed by only 0.67%. Candidate
TTFT on that prompt was about 37% lower than either control. These results support
the combined configuration on this benchmark, not individual attribution to
either flag, general workload coverage, or unchanged answer quality. Some output
hashes differ, and three serial rounds are not three independent process trials.

**A sustained decode improvement remains unqualified.** Median decode gains were
1.55–3.19% against the initial control and 1.50–1.71% against the return control.
All three runs slowed markedly over time. Shorter prefill changes the cumulative
heat exposure before later decoding, so a matched-round advantage does not
isolate a faster decode kernel. The interpretation plan (`interpretation-plan.json`, private capture)
was recorded before return-control results arrived.

An auxiliary read-only observer sampled the return control's AMD `gpu_metrics`
every five seconds: 19 samples over 90.05 seconds. The reported fast/slow package
power-limit residency counters increased by 4,863 and 50,277 raw units. GPU and
SoC thermal counters did not increase; the core thermal counter increased by one.
This establishes reported power-limit activity during the sampled interval, not
the fraction of time throttled or the exact cause of the throughput loss.

Early context decoding sampled a filtered fabric target of 1,834 MHz; late
context samples showed 1,628–1,661 MHz while GPU core targets rose. Sampled memory
targets did not collapse to 400 MHz. The sysfs listing's missing active marker can
simply reflect a filtered 999 MHz value differing from its listed 1000 MHz state.
Rising temperature and lower fabric targets are correlations; the firmware
counters do not establish GPU thermal throttling as the cause of the slowdown.

The parser uses the [Linux 6.17 ABI](https://github.com/torvalds/linux/blob/v6.17/drivers/gpu/drm/amd/include/kgd_pp_interface.h#L1497),
[driver exporter](https://github.com/torvalds/linux/blob/v6.17/drivers/gpu/drm/amd/pm/swsmu/smu14/smu_v14_0_0_ppt.c#L540),
and [firmware field definitions](https://github.com/torvalds/linux/blob/v6.17/drivers/gpu/drm/amd/pm/swsmu/inc/pmfw_if/smu14_driver_if_v14_0_0.h#L178).
These are filtered target clocks and raw cumulative counters, not instantaneous
hardware clock measurements or throttle percentages. host B's OEM kernel may
contain downstream changes; the header, layout and known values were validated.
The observer was present only for the return control, and its overhead was not
separately measured. Its first/last samples omit roughly 0.35/2.45 seconds of the
request sequence. The independent telemetry review (`control-telemetry-independent-review.json`, private capture)
retains all samples, alignment, counter differences and source hashes.

The decision is to retain both options for experiments and leave host A production
defaults unchanged. host B uses a different driver/compiler; host A still has
competing GPU activity, so its production workload needs an uncontended local
comparison before enabling these settings. host B's final temporary service
was stopped and its GPU was idle at 14:21:41 EDT. No further Antimatter work is
scheduled there. The staged
checkpoint remains under `<model-cache>/` for
reproducibility; the native build and test harness remain under
`<private-build-directory>/`.

## Validation and evidence

The three optional tile caps each passed all 44 required GPU numerical cases
against the CPU double-precision oracle. Twelve additional ordinary quantized
operation cases passed with MMVQ disabled. Numerical correctness does not qualify
performance. The application test gate passed **1,550 tests with five skipped**,
and the production build passed.

Application changes reduce redundant transcript copying and heartbeat-driven
presentation updates. Memoized message and Markdown boundaries also prevent
unchanged history from being reparsed for each new chunk or reasoning update.
An isolated Electron regression keeps 40 historical messages at one parse each
through 20 streamed text chunks, reasoning/context changes and cloned history
checkpoints. It checks immediate current-text updates, history edits, thinking,
approvals and imported-image restrictions. Run `node scripts/smoke-message-rendering.mjs`
to repeat it. These application changes have no measured engine tokens/s claim.

Local evidence is retained in
the private validation archive (not distributed):

- Baseline (`baseline.json`, private capture) and
  no-MMVQ comparison (`no-mmvq-analysis.md`, private capture).
- Profiler analysis (`profile-analysis.md`, private capture) and
  weight-bandwidth calculation (`bandwidth-analysis.md`, private capture), with reproducible analysis scripts alongside them.
- GPU-contention evidence (`gpu-contention.json`, private capture),
  excluded tile32 analysis (`tile32-analysis.md`, private capture) and
  incomplete control (`control-validity.md`, private capture).
- `tile32-accuracy.log`, `tile64-accuracy.log`, `tile128-accuracy.log`,
  `no-mmvq-accuracy.log`, the workgroup logs, and
  `tile-cap-patch-verification.json` in the same evidence directory.
- host B comparison (`comparison.md`, private capture),
  with raw requests, runtime logs, memory snapshots, final idle state, native build
  manifest, GPU telemetry and reproducible analysis script in the same
  `host-b-results` directory.

host B provided an idle Radeon 8060S for the independent experiment. Its older
glibc cannot run host A's payload, so the exact source/patch was built natively
with GCC 13.3. A task-local shaderc 2025.2 enables the same integer-dot/MMVQ
capability; no system packages or existing services were changed. Each tile cap
passed all 44 strict GPU cases there, and all 12 ordinary no-MMVQ cases passed.
These full-model measurements are reported separately from host A because
compiler, driver and host differ. The A/B/A comparison is complete. It establishes
a repeated prefill observation on the measured host B fixtures; it does not
qualify a host A production-default change or a sustained decode speedup.
