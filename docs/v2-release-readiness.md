# Client v2 readiness

This document tracks preparation of the **v2 Linux x86_64 tester release**. It is not a publication
record or a declaration that unchecked gates passed. Public release labels use `v2`; component
and package transport versions are recorded by the release manifests. The repository's rolling
`VERSION` is the authoritative public release label; the old development-only counter has been
retired without rewriting Git history. The compatibility package identity is `2.0.0` so existing
installers, buildd, and updaters can consume this release.

The [v1 checklist](./v1-release-readiness.md) is historical context, not evidence that a newly
packaged build or every target device has been tested. Android production signing/distribution
remains separate from this desktop release.

## Changes to validate

### Appearance and desktop companion

- Settings → General → Appearance selects Dark or Light and a preset/custom secondary accent.
  Dark is the default. The primary action color stays orange; derived accent tones adapt to
  the selected theme for readable contrast. Invalid colors do not overwrite the saved setting.
- Saved settings propagate to the main workspace, About window, and companion. Existing xterm
  sessions update their palette without a new shell or lost output. CodeMirror theme changes
  preserve the editor instance, document, selection, scroll, undo, and cached-tab state.
- The companion's portrait, name, and status are drag surfaces; toolbar icons remain interactive.
  Position persists across hide/quit, including a move immediately before shutdown. Restored
  bounds must remain usable when a display is removed or its work area changes.

### Model test prompts

- Developer includes eight complete project prompts in four foldable categories, from simple
  command-line tools to local web/data projects. The existing auto-continue settings remain.
- Copy preserves the complete prompt exactly. Clipboard failure offers manual text selection.
  Neither copy nor selection creates a conversation, sends a message, starts inference, or
  installs anything. Prompts assume a user-selected scratch workspace, protect existing work,
  avoid real credentials/external deployment, and bound useful independent delegation.

### Reviewed local chat imports

- Claude web/desktop exports and Claude Code JSONL, Codex rollout JSONL, and official OpenCode
  v1 session JSON exports have distinct reviewed import paths. OpenCode accepts exported JSON
  files or a folder of exports, not its live database/internal storage or shared-session URLs.
  Different OpenCode export schemas are not claimed supported without schema verification.
- Picking files does not auto-select candidates or start an import. Review notes, choose the
  conversations and destination project, then explicitly import. Originals are untouched;
  atomic append preserves existing chats, active chat, drafts, and pins. Duplicate source IDs
  are skipped, not merged. Limits and preview expiry are documented in the
  [import guide](./model-tests-and-chat-imports.md).
- Historical text/tool positions survive where supported. Historical tools cannot execute,
  trigger approval, open a preview, or restore a live child agent. Attachments are placeholders;
  imported Markdown images do not fetch automatically. Source configuration, instructions,
  permissions, and workspace paths are not adopted as authority. Imports start in Ask mode
  without a workspace. Continuing may send private history to the user's chosen provider.
- Source sidebar groups persist expansion independently, show an import action when empty,
  and temporarily expand matching searches without overwriting the saved choice. Pinning
  places an import only in Pinned; native Recent excludes imported conversations. Existing
  rename/delete/context-menu behavior and project filtering remain.

## Runtime baseline and limits

- Preserve native Beholdd CPU and the pinned llama.cpp Vulkan compatibility runtime in the
  Linux package. These are separate paths, not a claim of native Beholdd GPU acceleration.
  Missing GPU libraries must fail packaging instead of creating an accidental CPU-only build.
- Inspect the generated `backend-inventory.json`, packaged runtime hashes, library resolution,
  provenance, and host prerequisites. Vulkan loader/ICD, vendor/Mesa GPU drivers, and OpenSSL 3
  remain host requirements; CUDA/ROCm and system drivers are not bundled.
- The default installer model remains pinned Qwen3-Coder 30B A3B Instruct Q8_0, about 30.25 GiB.
  Verify model size/hash handling and preservation of an existing model/server configuration.
  Do not describe Nemotron or Omni experiments as the installed default or new native support.
- Voice is half-duplex and utterance-based. Doctor mode, historical-message repair, and Preview's
  3D/audio/dedicated code viewers remain out of scope. Preview is Web/Images, not a native-window
  embedding host. Android remains a companion testing/signing track with the limits in its README.

## Automated and isolated validation gates

Run against the final source and the assets that will actually be packaged. Synthetic fixtures
must not read personal chat files, contact real providers, start the user's inference server,
access the microphone, or alter the running application/profile.

- [x] Full `npm test` and `npm run typecheck` pass after final version/display changes.
- [x] Appearance persistence, sender authorization, startup bootstrap, normalization, and
  light/dark color-contrast tests pass. Reject invalid input without reporting a false save.
- [x] `smoke-appearance-bootstrap.mjs`, `smoke-settings-renderer.mjs`, `smoke-about-renderer.mjs`,
  and `smoke-avatar-renderer.mjs` pass with isolated profiles, mocked IPC, and production assets.
- [x] `smoke-editor-theme.mjs` and `smoke-terminal-renderer.mjs` pass, including live theme
  changes and real editor/terminal state preservation without restarting a shell.
- [x] Prompt copy/fallback, import parser/service/storage, imported-history rendering, and
  sidebar tests pass, including malformed/oversized input, duplicate IDs, inert tool records,
  attachment privacy, refused ambiguous histories, and no data loss on persistence failure.
- [x] `smoke-chat-import-renderer.mjs` passes with synthetic exports and mocked picker/clipboard
  IPC; all three sources are reachable and the selected source matches the import page.
- [x] What's New displays v2 while retaining v1/alpha history, marks the current release read,
  and describes the actual supported import formats and unchanged platform/runtime scope.
- [x] Production bundle and `npm run release:verify` pass with the sealed licenses matching the
  pinned Beholdd vendor manifest. A newer implicit sibling checkout is explicitly reported and
  excluded from graph comparison; an explicitly selected mismatched source is rejected. Use
  isolated build output until the user is ready to replace a running build.

## Packaging, publication, and target-device gates

- [ ] Build a fresh Linux archive/AppImage and installer from the same committed source, with
  exact runtime provenance and `backend-inventory.json`. Do not relabel previous artifacts.
- [ ] Check release/platform/model manifests, checksum coverage, asset names, public v2 label,
  and the package/update transport version for consistency before any external publication.
- [ ] Exercise the user-local installer and uninstall/data-preservation path in a clean isolated
  environment. Test absent/default model, interrupted download/resume, invalid hash, and existing
  configured model; do not overwrite a tester's configuration or download weights as a unit test.
- [ ] Run actual inference through the packaged Vulkan compatibility runtime on a target GPU.
  Device enumeration alone is insufficient. Verify CPU fallback and actionable driver errors
  separately; record GPU, driver, model, command, and result without claiming universal support.
- [ ] Exercise managed upgrade from the released v1 installer: verified download, rejection of
  a bad payload, safe-idle restart gating, saved drafts, and preserved conversations/configuration.
- [ ] Validate light/dark readability, custom accent, companion drag/restore, terminal/Preview
  placement, and native web content on the supported Linux window managers/display setups.
- [ ] Complete any previously deferred real microphone, phone QR/reconnect, approval, stop, and
  draft-recovery workflows before making claims about those devices. A signed Android upgrade
  path is required for public mobile distribution; unsigned/debug APKs are test artifacts only.
- [ ] Stage on the managed build server and verify the downloadable assets, public labels,
  checksums, installer link, and latest-release metadata after publication. Record the URL,
  source revision, exact package inventory, and validation evidence here or in the release log.

## Evidence recorded for this release

Pre-commit validation on 2026-09-26: 1,040 desktop tests passed, zero failed or skipped;
typecheck, isolated production bundle, release-input verification, and all seven listed renderer/
bootstrap smoke checks passed. Fixtures use synthetic data and isolated profiles. The About light
accent assertion was corrected to account for the palette's contrast-adjusted tone.

Native CPU and Vulkan payload manifests and library resolution passed; a Radeon 8060S enumerated
without loading a model. This is not an inference result. The pinned Beholdd commit remains
`7dbcc3962029359d65cab3f08af1d2c8292a48e5`, not the newer sibling checkout.

The final clean-commit assembler must rerun packaging gates. Record its manifest, publication
identity, and later target-device evidence in the release log; unchecked hardware/device gates
remain tester follow-up and are not implied by the automated results above.
