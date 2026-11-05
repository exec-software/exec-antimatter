# Antimatter Linux releases

Current release: **v18** (compatibility package 18.0.0).

This guide documents the Linux desktop and Android companion assembly contract. Publication is
confirmed by the selected release's manifest and checksums, not by this source guide. Use the
instructions accompanying the build you download. Public distribution is subject to the source,
license, and dependency review; a version label alone does not announce release availability.

These files define the user-local Linux x86_64 release for Antimatter. The target
platforms are Ubuntu 22.04 or newer and Debian 12 or newer with GNU libc 2.34 or newer. The
installer refuses root and does not use `sudo`, a package manager, or system directories.
It uses Bash, Python 3, GNU tar/coreutils, and either `curl` or `wget` for the model transfer. The
GitHub CLI is required only when a release asset is not already beside the installer.

## Install a published artifact set

Download the complete artifact set from the project's
[GitHub Releases](https://github.com/exec-software/exec-antimatter/releases) page when available,
or copy it from a trusted distributor's release feed. The repository does not require access to
a maintainer's network, VPN, account, or server. Keep the complete artifact set together in a
local directory rather than running an installer directly from a network mount.

Read the included release notes and verify `SHA256SUMS` before running the installer as your
normal desktop user. Never pipe a downloaded installer directly into a shell.

```bash
chmod 755 ./install.sh
./install.sh --skip-model
```

Omit `--skip-model` to provision the default checkpoint. Allow about 30.25 GiB for its download,
plus the application and temporary files. For GPU inference, select
**llama.cpp compatibility (Vulkan)** in Model Library; the standard Beholdd source uses the CPU.

The GitHub CLI can download a complete release into a fresh local directory:

```bash
antimatter_release_dir=$(mktemp -d /tmp/antimatter-release.XXXXXX)
gh release download v18.0.0 \
  --repo exec-software/exec-antimatter \
  --dir "$antimatter_release_dir"
chmod 755 "$antimatter_release_dir/install.sh"
"$antimatter_release_dir/install.sh" --skip-model
```

Authenticate `gh` if the selected repository/release requires it. Browser downloads of a
published public release do not require the CLI. If the archive and `SHA256SUMS` are beside
`install.sh`, the installer uses those local assets. Otherwise its fallback downloader requires
an authenticated `gh` session; anonymous fallback downloads are not currently implemented.

The tarball is the preferred Linux payload because it contains the unpacked application and
does not require AppImage/FUSE support.

## Published assets

| Asset | Purpose |
| --- | --- |
| `Antimatter-18.0.0-linux-x86_64.tar.gz` | Preferred FUSE-free application payload used by the installer |
| `Antimatter-18.0.0-linux-x86_64.AppImage` | Standalone desktop application alternative |
| `beholdd-18.0.0-linux-x86_64.tar.gz` | Standalone copy of the unchanged bundled CPU inference server |
| `Antimatter-Android-v1-12.0.0.apk` | Production-signed Android v1, compatibility package 12.0.0 |
| `ANDROID_README.md`, `android-release.json` | Mobile installation guidance and source/APK/signer provenance |
| `install.sh`, `uninstall.sh` | User-local lifecycle scripts |
| `beholdd.streaming.yaml`, `co.antimatter.app.svg` | Hash-pinned installer support files |
| `model-manifest.json`, `release-manifest.json` | Exact model, source, build, dependency, ABI, and artifact provenance |
| `backend-inventory.json` | Verified packaged CPU/Vulkan/HAG runtime identities, library hashes, host requirements, and build-host Vulkan device enumeration |
| `hag-model.json` | Pinned optional Qwen3 0.6B HAG model download identity |
| `BEHOLDD_HAG_THIRD_PARTY_LICENSES.txt`, `BEHOLDD_HAG_THIRD_PARTY_LICENSES.manifest.json` | Exact feature-enabled Beholdd/HAG license graph and attribution |
| `SHA256SUMS` | Digest inventory covering every other published asset |
| `LICENSE-APACHE-2.0.txt` | Full Apache License 2.0 text used by Beholdd and the default model |
| `LLAMA_CPP_LICENSE.txt` | MIT license for the pinned llama.cpp Vulkan compatibility runtime |
| `BEHOLDD_THIRD_PARTY_LICENSES.txt`, `BEHOLDD_THIRD_PARTY_LICENSES.manifest.json` | License corpus and inventory for Beholdd's exact 71-package Rust runtime graph |
| `README.md`, `RELEASE_NOTES.md`, `THIRD_PARTY_NOTICES.md` | Installation, release, and dependency documentation |

The default installation also downloads Qwen3-Coder 30B A3B Instruct Q8_0 from its pinned Hugging
Face revision. The checkpoint is 32,483,934,528 bytes (about 30.25 GiB). Its exact size and SHA-256
must match `model-manifest.json`; a failed verification never replaces the final model. Downloads
use a `.part` file and resume on the next run.

To install only the application and configure an inference source yourself from the download
directory created above:

```bash
"$antimatter_release_dir/install.sh" --skip-model
```

`--skip-model` still creates the streaming Beholdd configuration when no configuration exists. It
points at the standard model destination so a later completed model download becomes usable without
rewriting the config.

## Install or test a local package

The release assembler places the installer, archive, and checksums together under `releases/dist`.
Run the sibling installer there, or name an archive explicitly:

```bash
./install.sh --package ./Antimatter-18.0.0-linux-x86_64.tar.gz
```

The package must have exactly one matching entry in a sibling `SHA256SUMS`. A checksum file in a
different location can be selected with `--checksums PATH`. Isolated installer QA should use a
temporary set of XDG directories and avoid the 32 GB download:

```bash
antimatter_qa_root=$(mktemp -d /tmp/antimatter-qa.XXXXXX)
XDG_DATA_HOME="$antimatter_qa_root/data" \
XDG_CONFIG_HOME="$antimatter_qa_root/config" \
XDG_STATE_HOME="$antimatter_qa_root/state" \
XDG_BIN_HOME="$antimatter_qa_root/bin" \
./install.sh --skip-model --package ./Antimatter-18.0.0-linux-x86_64.tar.gz
```

The installer validates the archive layout before extracting, rejects all archive links and special
files, stages the payload on the destination filesystem, and activates it with an atomic `current`
symlink. Installing the identical version again re-hashes the complete installed payload. A changed
regular-file payload is replaced from the verified archive; unsafe links, special files, foreign
ownership, and cross-filesystem entries are rejected for manual inspection.

## Installed locations

All paths honor the XDG variables in effect while the installer runs:

| Purpose | Default path |
| --- | --- |
| Versioned application | `~/.local/share/antimatter/releases/18.0.0` |
| Active-version link | `~/.local/share/antimatter/current` |
| Model and resumable part | `~/.local/share/antimatter/models/qwen3-coder-30b/` |
| Beholdd configuration | `~/.config/antimatter/beholdd/config.yaml` |
| Command-line launcher | `~/.local/bin/antimatter` |
| Desktop entry | `~/.local/share/applications/co.antimatter.app.desktop` |
| Scalable icon | `~/.local/share/icons/hicolor/scalable/apps/co.antimatter.app.svg` |
| Install receipt | `~/.local/state/antimatter/install.json` |
| Installed uninstaller | `~/.local/share/antimatter/uninstall.sh` |

The generated launcher exports `BEHOLDD_HOME` before starting Antimatter. It also exports
`ANTIMATTER_LLAMA_VULKAN_MODEL` as the absolute path to the installer's standard checkpoint:
`${XDG_DATA_HOME:-$HOME/.local/share}/antimatter/models/qwen3-coder-30b/Qwen3-Coder-30B-A3B-Instruct-Q8_0.gguf`.
The path is exported even after a `--skip-model` install, but the compatibility source is not
offered until that checkpoint exists (restart Antimatter after installing it). If either
`config.v2.yaml` or `config.yaml` already exists in
`BEHOLDD_HOME`, the installer reports and preserves it byte-for-byte. A corrupt existing final
model is also preserved and causes installation to stop; remove or relocate it yourself only after
inspection.

The validated profile requests a 14,000,000,000-byte runtime budget and keeps
`allow_unsafe_storage: false`. The installer warns when Linux reports less available memory, and
Beholdd can refuse a rotational, network, mixed, or unidentified model filesystem. Prefer a local
SSD/NVMe volume with sufficient free memory and storage.

The application also carries a temporary llama.cpp b11223 Vulkan compatibility runtime for Linux
x86_64. It is separate from native Beholdd v2 and requires the host's `libvulkan.so.1` plus a
working Vulkan ICD/driver. Antimatter does not redistribute GPU drivers. The package verifier runs
the bundled server's `--version` command in a minimal environment, resolves every ELF dependency,
and checks the complete materialized runtime tree against its tracked manifest.

To place the application and the large model on another mounted filesystem, set an absolute
`XDG_DATA_HOME` before the first install. Run later upgrades and the uninstaller with the same XDG
values.

## Vulkan compatibility bridge

This release exposes the installed default checkpoint to the package-private source labeled
**llama.cpp compatibility (Vulkan)**. It is a temporary compatibility bridge while native Beholdd
v2 GPU execution is completed. Native Beholdd v2 remains the bundled CPU path and the fallback
when the compatibility source is unavailable.

The compatibility service is lazy: it does not start or load the roughly 30 GiB checkpoint merely
because Antimatter starts. The model stays unloaded until the first chat prompt is sent to **llama.cpp compatibility (Vulkan)**, and is released again when that compatibility service stops. This avoids
loading the same checkpoint in both the native and compatibility services during ordinary use.

Antimatter bundles the application-side Vulkan compatibility runtime, not a graphics driver. The
host must provide all of the following:

- a Vulkan loader exposing `libvulkan.so.1`;
- a working Vulkan ICD for the installed GPU, supplied by the hardware vendor or by Mesa; and
- the OpenSSL 3 runtime libraries `libssl.so.3` and `libcrypto.so.3`.

The preset leaves layer placement to llama.cpp's fit logic. A 16/24 GB card can therefore use
adaptive partial Vulkan offload with CPU spill instead of failing because the 32.48 GB Q8 checkpoint
does not fit wholly in VRAM; performance depends on the device and memory layout. Release
verification covers dependency resolution and the unloaded router, not a full 30B generation on
every Vulkan device.

On Ubuntu 22.04 and Debian 12 the loader and OpenSSL ABI are normally provided by `libvulkan1` and
`libssl3`; the correct vendor or Mesa ICD package depends on the GPU. GPU drivers, kernel modules,
firmware, and ICD configuration are deliberately not bundled. A machine without a usable Vulkan
device continues on native Beholdd v2's CPU path.

## Experimental HAG opt-in

After updating, the welcome notice offers HAG as an optional backend. It uses a separate
Beholdd executable at `resources/vendor/beholdd-hag/bin/beholdd`; the standard CPU and Vulkan
engines remain available. Enable it in **Settings → Experimental → HAG runtime**, or use **Turn off HAG** there to revert. Disabling it preserves the
model download and your existing sources, so you can switch back to your usual engine.

The opt-in downloads only the exact Qwen3 0.6B Q8_0 checkpoint described by `hag-model.json`
(639,447,744 bytes, about 610 MiB), verifies its size and SHA-256, and runs it separately from
the other configured engines and the installer's default model. The download is not part of the app archive;
enabling HAG only registers the source and downloads or verifies its checkpoint. Choosing a
model does not start or load it. The first prompt sent to that model starts its contained
service and triggers the model load. Services may start with the computer only when they
can stay unloaded; HAG and the direct llama.cpp services start lazily to preserve that rule.

This first experimental package supports Linux x86_64, AMD PCI `0x1002:0x1586` / GFX1151,
an accessible amdgpu render node and a systemd user session. It does not broaden HAG support
to other GPUs or checkpoints. The composer preview is text-only: up to 64 output tokens,
a conservative 1,024-position total budget, and no tools, project instructions or memory context.
Existing user/assistant history is preserved when it fits; tool-bearing or over-budget history
is refused without deleting it. The runtime allocates a 16,384-position context internally,
but that does not increase the preview limit or qualify the full 8,079-token editor tool prompt.
Package verification checks provenance, dependencies and launchability without opening a HAG
compute device; it is not a GPU inference qualification for every receiving computer.

## Updates

The current updater supports a trusted local or mounted release feed containing buildd-compatible
`latest.json` metadata. Select the feed folder under **Settings → Updates**. Automatic discovery
also checks the conventional `/mnt/releases/antimatter` mount, the legacy
`/mnt/builds/managed/antimatter` mount, and compatible shares opened in the file manager. These
are optional mount conventions, not required infrastructure. A public HTTPS/GitHub updater is not
implemented; downloading GitHub release assets is a separate workflow.

Two seconds after startup, and every four hours thereafter, the updater checks the selected feed.
When a newer version is published it:

1. copies that build's `install.sh`, support files, `SHA256SUMS`, and application archive into
   `~/.cache/antimatter/updates`, checking every file's size and SHA-256 against what buildd
   recorded. A copy cut off by a network drop resumes where it stopped;
2. runs the copied installer as `install.sh --skip-model --package … --checksums …`, which verifies
   the archive again, installs the new version beside the running one, and moves `current`; and
3. confirms that the receipt and `current` both name the new version, then deletes the staged copy
   and keeps only `last-install.log`.

With automatic updates on, Antimatter restarts through the launcher only after chats, provider
requests, agents, terminals, environment runs, debugging, orchestration, recovery work, and file
edits are idle. The renderer must also report no unsaved editor buffers, capture the composer's live
draft, freeze interaction, and complete an awaited stable conversation checkpoint. Main releases
the renderer freeze whenever its final checks do not proceed to exit. Settings shows what is keeping a
restart waiting. The old/new version pair
is recorded before the detached relaunch helper starts, preventing an old launcher from repeatedly
restarting the same binary; a helper failure leaves the current app open. **Restart now** (Settings
→ Updates, or the notice in the sidebar) remains available for an explicit restart. Turn off
**Install updates automatically** to be asked before anything is copied and to disable automatic
restart. A failed installer changes nothing: its output is shown with the log path, and the verified
copy is kept for **Retry**.

An AppImage replaces itself in a single rename once the new image verifies. A copy running from
source, or unpacked without the installer, only reports what is published.

Before reading the share, Antimatter asks the server behind the mount whether it answers, so a
laptop away from the LAN reports that it is offline within seconds instead of waiting out the CIFS
timeouts. Updating does not cost the model its verification: with `--skip-model`, the installer keeps
`modelVerified` when the previous receipt verified the model and the same file is still there at its
exact size.

Every installed version stays under `releases/` until the uninstaller removes them.

## Uninstall

Quit Antimatter from its tray menu, then run:

```bash
~/.local/share/antimatter/uninstall.sh
```

The uninstaller never kills a process. It requires the mode-`0600` install receipt, reconstructs and
checks each receipted payload manifest, and removes only those validated version directories plus
installer-managed launch metadata. A changed payload is left in place until a verified reinstall
repairs it. It deliberately preserves:

- the downloaded model and any `.part` download;
- Beholdd configuration;
- Electron settings under `~/.config/antimatter`, including update preferences;
- conversations, carbons, agents, and workspaces under `~/.antimatter`; and
- user projects or external Beholdd services.

Delete preserved data manually only when you have verified the exact paths and no other install
uses them.

## Integrity boundary

`install.sh` verifies the selected tarball against `SHA256SUMS`. Its configuration, icon, and
uninstaller inputs are also pinned by SHA-256 inside the installer. The model is pinned to Hugging
Face revision `e9eb3e611bdcd5842e021c014b392c70746da574`, exact size `32483934528`, and SHA-256
`a4a0207f4653bfece73d9818c83acf714f5593525fe3aab7026347fd73090fcc`.

`SHA256SUMS` is not a cryptographic publisher signature: a checksum downloaded from
the same compromised origin as an artifact cannot establish provenance. Obtain assets only from the
project's GitHub Releases page and compare release metadata before running them.

## Maintainer assembly contract

Both the CPU and HAG payloads must be rebuilt from the clean public-history Beholdd commit
selected by `scripts/deps.json`. The checked-in binary manifests and license inventories describe
historical builds; do not ship them as the new release or relabel their source hashes.
Set `ANTIMATTER_BEHOLDD_SOURCE` and `ANTIMATTER_BEHOLDD_HAG_SOURCE` to clean checkouts at their
exact configured pins, then rebuild both payloads:

```bash
export ANTIMATTER_BEHOLDD_SOURCE=/path/to/clean/exec-beholdd
export ANTIMATTER_BEHOLDD_HAG_SOURCE=/path/to/clean/exec-beholdd
node scripts/sync-deps.mjs --release beholdd beholdd-hag
node scripts/generate-beholdd-licenses.mjs
node scripts/generate-beholdd-licenses.mjs --component beholdd-hag
```

The HAG build enables `hag-native` and records that feature alongside the source commit.
Both builds must meet the same glibc 2.34 ceiling as the rest of the package. Use a compatible
build host/sysroot rather than weakening the verifier. Review both regenerated attribution
corpora alongside the new binary manifests before assembly.
The HAG model descriptor is copied from tracked `releases/hag-model.json` and hash-bound in the
vendor manifest. Normal development uses the tracked MIT-licensed Displacer tokens. A full
Displacer source refresh requires a separately reviewed source checkout; use
`node scripts/sync-deps.mjs --release displacer` only when that source and its toolchain are
available. Import the pinned upstream Vulkan payload with
`npm run deps:llama-vulkan -- --archive /path/to/llama-b11223-bin-ubuntu-vulkan-x64.tar.gz` (or omit
`--archive` to download it), then run `npm run deps:llama-vulkan:verify`. The importer requires the
exact 31,348,616-byte archive with SHA-256
`d4505b5752a967e070fb418ec1d365d4448d692eccea1d7d4d0a6e75b7300025`, validates every tar member,
rejects traversal and special files, and materializes safe in-tree archive symlinks as regular
files. Run `npm run licenses:beholdd` whenever Beholdd's commit or
locked runtime graph changes, and review the generated attribution corpus. Generate the separate
HAG graph with `node scripts/generate-beholdd-licenses.mjs --component beholdd-hag`; it includes
the exact `hag-native` feature graph and the statically linked MIT-licensed `exec-hag` package.
Both graphs are required by `release:verify`. `npm run release:linux`
then creates a detached worktree at the clean Antimatter `HEAD`, copies only those verified vendor
payloads into it, runs a fresh `npm ci`, and publishes the result atomically to the ignored
`releases/dist` directory after every check passes. The live development checkout and its
`node_modules` remain untouched.

The application archive has one top-level directory named
`Antimatter-18.0.0-linux-x86_64` containing the unpacked Electron payload and an executable
named `antimatter`. `SHA256SUMS` covers every published file, while `release-manifest.json` records
the exact asset allowlist. The tracked inputs in this directory remain separate from generated
binaries so the release contract is reviewable without committing an application or model
artifact.

Before assembly, perform the shell syntax check without executing either lifecycle script:

```bash
bash -n releases/linux-x86_64/install.sh releases/linux-x86_64/uninstall.sh
```

`npm run release:verify` checks shell syntax, the sealed Beholdd license graph, and every duplicated
installer version, repository, model identity, filename, size, support-file hash, and the Android
application/version metadata. Assembly also runs `npm run android:verify`, the full desktop test
suite, packaged PTY and MCP execution, Beholdd health/model discovery, local-path leakage,
normalized archive ownership and modes, the glibc 2.34 ABI ceiling, install/repair/idempotence,
configuration preservation, and receipt-scoped uninstall. Android release assembly retains its
exact unsigned APK and commit/hash receipt in `releases/dist/.android-input/`. This directory is
never in the published asset list. The manifest remains `pending-signature`, and both publishers
refuse it until the production-signed APK has been verified and imported as described below.

Linux release assembly also requires a working Docker daemon. It rebuilds only the locked
`node-pty` package in the official `node:22.22.1-bullseye` image pinned by digest in
`scripts/lib/native-release.mjs` (glibc 2.31/GCC 10.2.1). Fresh isolated `npm ci` verifies the npm
source archives against the lockfile; Electron headers are downloaded for the installed Electron
version and verified against the official SHA-256 inventory. Every compiler/smoke container has networking disabled and its own 3-GiB memory limit,
zero swap allowance, one-CPU quota and 256-task cap. Compilation uses one job, and each
container command has a 600-second deadline with a ten-second kill grace. These limits
are recorded and checked in the native build receipt because Docker-created containers do
not inherit a wrapping user service's cgroup. Inputs remain read-only; outputs use disposable
scratch storage.

Both an actual PTY inside that older container and an actual Electron PTY must pass. The release
manifest records package integrity pins, source/header hashes, image/compiler identity, binary
hash and ELF requirements. Release packaging disables both automatic native rebuild paths and
checks that the packaged module is byte-identical to this verified output. The final packaged PTY
smoke and whole-package glibc 2.34 ceiling still apply. Ordinary developer installation/rebuild
behavior is unchanged; dirty-tree release rehearsals are no longer supported.

After reviewing the generated manifest and checksums, tag and push the assembled commit, then run
`npm run release:publish` when publishing to GitHub as well. The publisher refuses dirt, mismatched
tags/commits, missing or extra assets, and failed checksums. It verifies a draft's uploaded assets
before publishing a stable GitHub release or an explicitly labeled alpha prerelease.

## Publish a release or update feed

The public release follows Execute's rolling `v<N>` convention. Electron and existing updaters
retain `N.0.0` compatibility identities in filenames and receipts. These are two names for one
build, not separate release lines. Root `VERSION` is authoritative. Every default-branch commit
earns the next rolling number, committed with its changes.

`npm run release:version` mechanically increments `VERSION` and synchronizes package, installer,
Android, and current-release documentation pins. It refuses drift before writing. Do not
manually change one version field, skip release numbers, or reuse a published version.

After review, commit and tag the exact source, assemble the release, and complete the Android
signature/import handoff. Publication is an explicit maintainer action:

```bash
npm run release:linux
# Complete the Android signature/import handoff below.
npm run release:publish
```

The GitHub publisher verifies the assembled asset allowlist, source commit, both version tags,
and checksums before publishing. It does not configure repository visibility.

### Optional buildd feed

A distributor using buildd can stage the same verified artifact set for a local or mounted feed.
The tool is optional; public GitHub distribution does not require it. Configure the incoming
directory, its server-side equivalent, and the managed project folder explicitly:

```bash
npm run release:stage -- \
  --incoming /path/to/mounted/incoming \
  --server-incoming /srv/releases/incoming \
  --managed /path/to/mounted/managed/antimatter \
  --dry-run
```

Remove `--dry-run` only when ready to stage. The script verifies the exact assets, hashes, source
commit, tags, and Android signature state, then copies the files atomically to the incoming
directory. It never writes directly into the managed feed or runs the server-side import.
The older `release:lich` command and `--lich-incoming` flag remain compatibility aliases.

On the release server, set `BUILDD_CONFIG` to the distributor's bootstrap configuration and
run the printed `buildd` command using the displayed manifest/checksum trust anchors.
Use the importer's verify/dry-run facility first. Keep incoming staging private and expose only
the immutable managed output to readers. Retention and filesystem permissions are distributor
policy; they are not tied to a named host or account.

Installed applications can select the resulting project folder under Settings → Updates.
Only choose a trusted feed: checksums protect transfer integrity but do not independently
authenticate a publisher whose feed metadata has been compromised.

## Complete the Android production handoff

After `release:linux` finishes, preserve `releases/dist/.android-input/` with the release. It
contains `app-release-unsigned.apk`, a receipt binding its SHA-256 to the assembled commit and
Android package identity, and the mobile README from that revision. The isolated release wrapper
copies this hidden directory back before removing its worktree. Do not substitute an APK from a
later development build.

Follow [the protected signing procedure](ANDROID_SIGNING.md) to align a copy of that exact APK,
transfer it to a protected signing environment, and sign it there. The private key and password
stay in that environment. Return only the signed APK, then run from the clean release checkout:

```bash
node scripts/import-android-release.mjs --apk /absolute/path/app-release-signed.apk
```

The importer uses the repository-pinned Android SDK Build Tools (via `ANDROID_HOME`,
`ANDROID_SDK_ROOT`, or `android/local.properties`) and Python 3's standard ZIP library. It verifies
the production certificate against `android-signing.json`, a valid APK v2/v3 signature, the exact
application ID/versionName/versionCode, and the non-debuggable flag. It compares every unsigned
ZIP payload entry with the signed APK, excluding only signature records; alignment/signing must
not change code, resources or the manifest. Duplicate or unsafe ZIP entries fail verification.

The importer atomically replaces the assembled release with the signed APK, `ANDROID_README.md`,
`android-release.json`, an updated manifest/allowlist and complete `SHA256SUMS`. The provenance
records the source commit, unsigned and signed hashes, production signer fingerprint, public v1
label, compatibility version and upgrade counter. Staging refuses an absent or pending mobile
artifact. The release manifest defines the exact published asset set; the hidden unsigned input is excluded.
For a buildd feed, run the printed command with `verify` first, then with `import` to publish.

Existing debug-signed phone installations cannot upgrade in place to the new production signer.
Preserve their data and pairing until a deliberate migration is arranged. Production releases
must keep the same protected key and increase versionCode; changing the public v1 label does not
reset that upgrade counter.
