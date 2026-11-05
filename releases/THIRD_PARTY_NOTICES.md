# Third-party notices

Antimatter includes or interoperates with the following third-party software and model artifacts.
Copyright remains with the respective authors. This notice is informational; the applicable
license texts control.

Antimatter itself is licensed under MIT. Its full license and Execute Software copyright
notice are shipped at `resources/ANTIMATTER_LICENSE.txt` in desktop application payloads.

## Bundled runtime and direct dependencies

| Component | License | Project |
| --- | --- | --- |
| Electron | MIT | <https://www.electronjs.org/> |
| Chromium and its bundled components | BSD-style and other licenses | Included as `LICENSES.chromium.html` in the application payload |
| React and React DOM | MIT | <https://react.dev/> |
| CodeMirror 6 packages | MIT | <https://codemirror.net/> |
| xterm.js | MIT | <https://xtermjs.org/> |
| node-pty | MIT | <https://github.com/microsoft/node-pty> |
| Model Context Protocol TypeScript SDK | MIT | <https://github.com/modelcontextprotocol/typescript-sdk> |
| Lucide React | ISC | <https://lucide.dev/> |
| react-markdown and remark-gfm | MIT | <https://github.com/remarkjs/react-markdown> |
| js-yaml | MIT | <https://github.com/nodeca/js-yaml> |
| ws | MIT | <https://github.com/websockets/ws> |
| node-qrcode | MIT | <https://github.com/soldair/node-qrcode> |
| AndroidX CameraX | Apache-2.0 | <https://developer.android.com/media/camera/camerax> |
| ZXing Core | Apache-2.0 | <https://github.com/zxing/zxing> |
| llama.cpp b11223 Vulkan runtime | MIT | <https://github.com/ggml-org/llama.cpp/releases/tag/b11223> |

The packaged JavaScript dependency tree contains additional transitive components. Their package
metadata and license files are retained in the packaged application where supplied. Electron's MIT
license and Chromium's generated license inventory are shipped in the top level of the unpacked
application payload.

## Bundled fonts

The USSR Stencil wordmark font by Anastasia Mihaleva and Jovanny Lemonad is licensed
under SIL Open Font License 1.1. The C64 Keyboard font reconstruction by Levente
Szabadkai is offered under CC0 1.0. Both license texts and the source/attribution
README are shipped under `resources/licenses/fonts/`; they remain independent of
Antimatter's license. The C64 reconstruction is unofficial and does not grant rights
to Commodore trademarks or historical keycap designs.

## Execute components

| Component | License | Project |
| --- | --- | --- |
| Beholdd | Apache-2.0 | <https://github.com/exec-software/exec-beholdd> |
| HAG (statically linked into optional Beholdd HAG executable) | MIT | <https://github.com/exec-software/exec-hag> |
| Displacer | MIT | Execute Software Displacer design library |

Displacer's `lib/libdisplacer-ts/package.json` declares MIT at the token snapshot's exact
source revision `bfb2c5ec59718d2795b4c550a7270ee0050a554e`. That historical tree did not
contain a project-wide license file. The full MIT text and Execute Software copyright
notice were supplied during public-release preparation and are retained at
`releases/licenses/displacer/LICENSE` and `vendor/displacer/LICENSE`; this is not a claim
that the license file existed in that historical tree. The token bytes and their recorded
source identity are unchanged. Future dependency synchronization copies and verifies this
license alongside the tokens, and packaged applications retain it under `resources/licenses/displacer/`.

The Beholdd binary and Displacer design tokens are built from the exact revisions recorded in their
vendored manifests and in the generated release manifest. The canonical Apache License 2.0 text is
published as `LICENSE-APACHE-2.0.txt`, embedded at `resources/licenses/Apache-2.0.txt` in both
application payloads, and included at the root of the FUSE-free and standalone Beholdd archives.
`BEHOLDD_THIRD_PARTY_LICENSES.txt` carries the complete license and attribution corpus for the exact
resolved Rust runtime graph; its machine-readable manifest pins the source commit, Cargo lockfile,
resolved graph, package licenses, input-file hashes, and bundle hash.

The separate experimental HAG executable is recorded in `vendor/beholdd-hag/manifest.json`.
Its feature-enabled graph is distributed as `BEHOLDD_HAG_THIRD_PARTY_LICENSES.txt` and
`BEHOLDD_HAG_THIRD_PARTY_LICENSES.manifest.json`, also embedded under
`resources/licenses/beholdd-hag/`. It includes the full MIT license for the statically linked
`exec-hag` code; that license is additionally preserved at
`resources/vendor/beholdd-hag/share/HAG_LICENSE.txt`. The standard Beholdd CPU license corpus
remains tied to its separately built CPU binary. Both binaries and their inventories must
identify the clean source revision selected for this release.

Rust standard-library notices from the exact pinned compiler are retained under
`resources/licenses/beholdd-runtime/`. Embedded Beholdd chat-template attribution is
under `resources/licenses/chat-templates/`. HAG's adapted IGT/AMDGPU/DRM packet and
UAPI sources retain their upstream notices in `resources/licenses/hag-upstream/`;
the files are copied from the exact public HAG snapshot, with its provenance and
third-party notice index alongside them.

The temporary Linux GPU compatibility service uses the official llama.cpp Ubuntu Vulkan x86_64
asset from tag `b11223`, commit `4da6337767f973e2b4d0797e5b323d77d8565e4a`. Its source archive
and every materialized runtime file are pinned by SHA-256 in `vendor/llama-vulkan/manifest.json`.
The upstream MIT license is preserved beside the runtime at
`resources/vendor/llama-vulkan/runtime/LICENSE`, embedded again under
`resources/licenses/llama.cpp/LICENSE`, and published as `LLAMA_CPP_LICENSE.txt`. The Vulkan loader
and a vendor-appropriate Vulkan ICD/driver are host dependencies and are not redistributed.

## Optional model provisioned by the installer

The model is not embedded in the Antimatter application archive. By default, `install.sh` downloads
this pinned artifact directly from Hugging Face when it is absent:

- Base model: Qwen/Qwen3-Coder-30B-A3B-Instruct
- GGUF quantization: lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF, quantized by bartowski
- License identifier: Apache-2.0
- Revision: `e9eb3e611bdcd5842e021c014b392c70746da574`
- Artifact identity: see `model-manifest.json`

Model source, license, use restrictions, and attribution are available from the
[upstream model card](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct) and the
[quantized repository](https://huggingface.co/lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF).
The model can produce inaccurate or unsafe output; its output should be reviewed before use.

The HAG opt-in separately provisions Qwen/Qwen3-0.6B through the
`unsloth/Qwen3-0.6B-GGUF` Q8_0 conversion at revision
`50968a4468ef4233ed78cd7c3de230dd1d61a56b`. Its Apache-2.0 license and exact file identity
are recorded in `hag-model.json`; the model is downloaded only when the user enables HAG.

## Complete license inventory

The release assembler generates `JAVASCRIPT_SBOM.cdx.json`,
`JAVASCRIPT_LICENSES.manifest.json`, and `JAVASCRIPT_LICENSES.txt` from the exact
installed lockfile and packaged payload. These cover JavaScript dependencies and
Electron; the CPU/HAG and Vulkan inventories remain separate. The machine-readable
inventory binds license/notice text and package identity to their hashes. This notice
does not replace the full license and attribution files distributed with each component.
