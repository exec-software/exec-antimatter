# Local Vulkan F32 expert-input runtime

This is a local llama.cpp build for Mistral Small 4's F32 expert down-projection.
It is separate from the verified upstream `vendor/llama-vulkan` release. The source
pin, reviewed patch, build options and patched source hashes are recorded in
`vulkan-f32.json`. The generated `vendor/llama-vulkan-f32/manifest.json` records the
actual runtime files, compiler, effective build options and library dependencies.

Informational build metadata uses `redacted-local-build-paths-v1`: source, build,
dependency-prefix and home paths are replaced with labeled placeholders. This
normalization does not change source, patch, recipe or runtime-content hashes.
The existing manifest was sanitized for publication without rebuilding its payload;
its recorded validation scope and original artifact identities remain unchanged.

The build is qualified only to the extent recorded in
[the Mistral investigation](../../docs/model-provenance/mistral-small-4.md).
It is not a cross-platform released payload. Electron packaging explicitly excludes
`llama-vulkan-f32`; packaging it later requires its own inventory and installation
verification. The original runtime remains the default for every other model.

## Rebuild

Use a clean checkout of llama.cpp commit
`4da6337767f973e2b4d0797e5b323d77d8565e4a` (`b11223`). Apply the tracked patch from
this directory with `git apply /path/to/antimatter/patches/llama.cpp/b11223-vulkan-mul-mat-id-f32.patch`. Do not remove the model's F32 precision requirement:
activation values can exceed the F16 range.

Build prerequisites include a C++ compiler, CMake, Ninja, Vulkan headers/loader,
shaderc (`glslc`), OpenSSL development headers and SPIR-V headers. The tested host
uses GCC 15.2, CMake 4.2.3, shaderc 2026.1 and Vulkan/SPIR-V headers 1.4.341.
These are host prerequisites, not bundled GPU drivers. The CPU side requires
AVX2/FMA/F16C; `GGML_NATIVE=OFF` avoids additional host-specific instruction flags.

From the Antimatter checkout:

```sh
node scripts/build-llama-vulkan-f32.mjs \
  --source /path/to/patched/llama.cpp \
  --build /path/to/patched/llama.cpp/build-f32 \
  --jobs 2
```

When SPIR-V headers are installed outside the system search path, add
`--prefix /path/to/dependency/usr --include /path/to/dependency/usr/include`.
The include directory is passed explicitly to the C++ compiler; CMake's prefix
search path alone is not sufficient for this build.

The script builds `llama-server`, `test-backend-ops` and `llama-bench`. It checks that
the checkout contains exactly the reviewed changes, verifies CMake options, runs a bounded incremental build to prevent
stale outputs, copies the runtime into a staging directory, materializes
in-tree library symlinks as regular files, checks the shared-library resolution and
runs `llama-server --version`. It publishes the separate runtime only after those
checks pass. It never starts inference, edits a service, changes the upstream
runtime or installs system packages. These checks establish payload integrity,
not model correctness or GPU performance. Numerical backend tests and the actual
model placement/timing check must be run separately before deployment. The focused
numerical regression command is:

```sh
/path/to/patched/llama.cpp/build-f32/bin/test-backend-ops test \
  -b Vulkan0 -o '^MUL_MAT_ID_F32$' --require-support
```

Require all 44 cases to pass; skipped/unsupported cases are failures with this flag.
The cases compare Q4_K/Q6_K expert projections against a CPU double-precision oracle,
including values beyond F16 range, tiny values, cancellation, repeated expert routes,
and padded tensor layouts.

An existing build with exactly the same source and options can be imported
with `--import-build` added to the command above. This skips initial CMake configuration,
then validates the cache and incrementally builds the required targets with a 20-minute
deadline. Upstream has an always-dirty glob verifier, so a Ninja dry run cannot establish
freshness. Import can compile changed inputs; it never runs the GPU numerical tests. Offline payload verification is:

```sh
node scripts/build-llama-vulkan-f32.mjs --verify
```

The recipe is reproducible from the pinned source and patch. Binary hashes can
vary with the compiler and dependencies; the generated manifest identifies the
actual build and does not claim bit-for-bit reproducibility across toolchains.

## Optional per-process performance experiments

The patched runtime accepts `GGML_VK_F32_MMID_TILE_CAP=32`, `64` or `128` before
process startup. It caps the existing tile selector only for expert matrix
operations whose activation input requires F32. Smaller tiles can reduce work
on sparsely routed expert batches. The shaders, F32 activation storage, shared
tiles and accumulation remain unchanged. Ordinary matrix operations and the
expert vector path used for batches of up to eight tokens keep their existing
selection. With the variable unset, all selection remains at its default.

For an isolated comparison, prefix the existing server invocation with
`env GGML_VK_F32_MMID_TILE_CAP=32`; keep its arguments and all other environment
settings identical. Values `64` and `128` allow intermediate and original-size
comparisons; the cap never selects a tile larger than the normal selector would.
Invalid values are logged and ignored. Unset the variable and restart the process
to restore normal selection. If testing through a dedicated service override,
remove only that environment entry, reload the unit and restart when idle.
Installing this patch does not enable a cap or change a service's environment.

All 44 focused numerical cases passed separately with each cap on the tested
Radeon 8060S. To repeat a cap's accuracy check, prefix the numerical regression
command above with `env GGML_VK_F32_MMID_TILE_CAP=32` (or `64` or `128`). This is
accuracy coverage, not a performance qualification. Timing comparisons must use
an otherwise idle GPU, matching prompts and cache state, and repeated controls;
choose a cap only after verifying that workload's performance.

Upstream also provides `GGML_VK_DISABLE_MMVQ`, which disables its quantized vector
activation path. This is a separate experiment and is not enabled by the patch.
It is a presence flag: even `GGML_VK_DISABLE_MMVQ=0` disables MMVQ. To restore the
default, unset/remove the variable and restart; do not set it to zero. Qualify
ordinary quantized matrix/vector operations as well as the F32 expert tests when
changing this flag. Neither option changes the model checkpoint or its F32
precision requirement.

## Mistral-only deployment and rollback

The existing card uses `local-mistral-small-4-119b`, model alias
`mistral-small-4-119b`, at localhost port 8088. Its app-managed user service is
`llama-mistral-small-4.service`. Deployment can replace only that service's
`ExecStart` executable with the separate verified `llama-vulkan-f32/runtime/llama-server`,
using a dedicated systemd drop-in that resets `ExecStart` and repeats the original
arguments exactly. Keep the checkpoint, alias, context, parallelism, offload,
thread counts and host-memory limits unchanged for a controlled comparison.

Do this only while the service and GPU work are idle, after numerical and actual
model validation. A daemon reload does not itself start a model. Removing only
that dedicated drop-in and reloading restores the original executable; do not
remove unrelated unit overrides or profile settings. Existing saved runtime-profile
bindings intentionally reject externally changed service fingerprints, so any
binding for this service must be reviewed and captured again after the change.
