# Antimatter

Antimatter is a multi-model AI coding workspace for local inference and hosted providers.
It combines conversations, project tools, code review, terminals, previews, and agent
orchestration in an Electron desktop application. A native
[Android companion](android/README.md) connects to a paired desktop host.

Use OpenAI Responses, Anthropic Messages, OpenCode Zen, or an OpenAI-compatible endpoint
through the source-scoped Model Library. Local inference is optional: using a hosted provider
does not require a local model download or access to a particular development network.

## Project status

Current release: **v18** (compatibility package 18.0.0).

The repository is being prepared for public distribution. Release availability, license
review, standalone-build checks, and the source/history security audit must be completed
before a public release is announced. The source tree's version label is not evidence that
matching binaries have been published; check the selected release's manifest and checksums.

Linux x86_64 is the packaged desktop target. The Android companion is a separately signed
preview. Experimental features are opt-in and have explicit limits; availability in the
interface does not imply support for every model or device.

## Features

- **Multi-provider conversations:** one model library for local engines, hosted providers,
  model prompts, runtime limits, and agent routing.
- **Coding tools:** workspace-aware editing, permission-gated commands, an inline terminal,
  previews, code review, and per-project instructions.
- **Agent orchestration:** delegated agents, visible progress, approvals, steering, cancellation,
  scheduled workflows, and isolated issue workspaces.
- **Conversation navigation:** chronological tool activity, alternative transcript views,
  project grouping, pinned conversations, and reviewable chat imports.
- **Personalization:** dark and light themes, accent colors, spellchecking, a draggable desktop
  avatar, profile settings, and editable project/user memory.
- **Remote workspaces:** QR pairing, pinned HTTPS, and an Android client that leaves inference,
  credentials, tools, and project files on the desktop host.

Commands and generated changes require review. Full-access mode is not an operating-system
sandbox. Remote pairing is an explicit LAN/VPN workflow, not an Internet relay.

## Install a release

Obtain a complete artifact set from the project's
[GitHub Releases](https://github.com/exec-software/exec-antimatter/releases) page when available,
or from a release feed provided by a trusted distributor. Copy the files to a local directory,
verify their checksums, read the included release notes, then run the installer as your normal
desktop user:

```bash
chmod 755 ./install.sh
./install.sh --skip-model
```

The Linux installer targets Ubuntu 22.04+, Debian 12+, or another GNU/Linux distribution
with glibc 2.34+. It does not require root. `--skip-model` installs the application without
downloading a checkpoint; configure a provider or an existing local source in Model Library.

Omit `--skip-model` to provision the pinned Qwen3-Coder 30B A3B Instruct Q8_0 model. Its download
is approximately 30.25 GiB and is verified against a pinned size and SHA-256. Check memory and
storage requirements before choosing this option. See the [release guide](releases/README.md)
for the full asset list, integrity boundary, installation paths, and uninstall behavior.

### Local inference

The package's standard Beholdd source is the CPU path. The temporary
**llama.cpp compatibility (Vulkan)** source provides GPU offload and requires a working
system Vulkan driver. Drivers, firmware, kernel modules, and ICD configuration are not bundled.
The compatibility service starts lazily when the first request is sent; performance depends
on available memory and offload.

The **HAG runtime** experiment uses a separate Beholdd executable and a pinned Qwen3 0.6B
checkpoint. Its current package targets supported AMD GFX1151 systems and a bounded text-only
preview. It is not a general replacement for the CPU/Vulkan paths.
Read the [hardware and request limits](releases/README.md#experimental-hag-opt-in) before enabling it.

### Updates

The current updater reads a trusted local or mounted release feed selected in
**Settings → Updates**. It verifies artifacts and waits for active work and unsaved buffers to
clear before restarting. No particular server, account, VPN, or share is required to run
Antimatter. A public HTTPS/GitHub automatic-update transport is not implemented; GitHub release
downloads and the mounted-feed updater are separate workflows.
See [Updates](releases/README.md#updates).

## Build from source

Use Node.js 22.20+, 24.12+, or 25+, matching the repository's packaging requirements.

```bash
npm ci
npm run typecheck
npm test
npm run dev
```

The tracked Displacer token snapshot is sufficient for typechecking and renderer development.
The desktop can use a separately configured inference source. Preparing redistributable local
backend binaries is a separate step: `scripts/deps.json` defines source repositories, optional
source-directory overrides, exact pins where required, and artifacts to verify. Do not assume
that every optional companion dependency is already public or available on a fresh machine.

For a new packaged release, both Beholdd CPU and HAG binaries must be rebuilt from their clean
public-history source pins using `ANTIMATTER_BEHOLDD_SOURCE` and
`ANTIMATTER_BEHOLDD_HAG_SOURCE`. Existing checked-in binary manifests and license inventories
remain historical evidence; they do not qualify those binaries for this source release. Full
Displacer source refreshes require a separate reviewed checkout; ordinary renderer development
uses the tracked MIT-licensed token snapshot.
See [maintainer assembly](releases/README.md#maintainer-assembly-contract) and
[development and validation](docs/development.md).

For Android, configure JDK 17+ and Android SDK 36.1, then run `npm run android:verify`.
The [Android guide](android/README.md) distinguishes local debug builds, production signing,
and physical-device checks.

## Documentation

- [Provider keys and Model Library](docs/byok-and-model-library.md)
- [Personalization and setup](docs/personalization-and-setup.md)
- [Model runtime profiles](docs/model-runtime-profiles.md)
- [Agent workloads and orchestration](docs/model-workloads-and-orchestration.md)
- [Connected chats](docs/chat-coordination.md) and [bot chat](docs/bot-chat.md)
- [Remote workspaces](docs/remote-workspaces.md)
- [Live voice](docs/live-voice.md)
- [Model test prompts and chat imports](docs/model-tests-and-chat-imports.md)
- [Skills, plugins, schedules, and pull requests](docs/local-extensions.md)
- [Recipes](docs/recipes.md)
- [Beholdd execution limits](docs/beholdd-execution-limits.md)
- [Linux releases](releases/README.md) and [release notes](releases/RELEASE_NOTES.md)
- [Development and validation](docs/development.md)

Keep credentials, personal conversations, private project instructions, and machine-specific
configuration outside the repository. Sanitized examples should use placeholders and
documentation-only hosts rather than real accounts or internal infrastructure.

## Versioning

Antimatter uses Execute's rolling release scheme: `v1 → v2 → v3`.
`VERSION` is authoritative; `npm run release:version` performs the mechanical increment and
synchronizes package metadata. A default-branch change earns a new rolling version, committed
with that change. Do not manually change one version field in isolation.

Packages, filenames, manifests, and existing updaters retain the compatibility form `N.0.0`.
The `v<N>` and `v<N>.0.0` tags identify the same release commit, not separate release lines.
Component and plugin API compatibility versions remain independent.

## Support the project

You can support Execute Software's work through
[Buy Me a Coffee](https://www.buymeacoffee.com/execsoftware). Contributions are optional and
do not change provider fees or grant access to a maintainer's private infrastructure.

## License and publication

Antimatter is licensed under the [MIT License](LICENSE). Third-party components and models
retain their own licenses and notices. See the [publication checklist](docs/publication.md)
for the remaining source, history, dependency, and artifact review gates.
