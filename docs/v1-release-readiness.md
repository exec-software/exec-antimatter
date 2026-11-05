# Client v1 readiness

This checklist tracks preparation of `1.0.0`, not a declaration that it has been published.
Packaging and publication evidence is recorded separately; unverified target-device checks remain
explicit. Android production signing/distribution is separate from the Linux desktop release.

## Desktop workflows

- **Terminal** is the existing inline/floating console, not a separate external-app button.
  Approved bundled `run_command` calls in interactive chats and their child agents use dedicated
  command terminals there. A session picker also keeps manual workspace shells accessible.
  Sudo still needs approval, then the user enters credentials directly in that command's terminal.
  Keystrokes never enter the conversation; any user input withholds that command's entire output
  from model context and Carbon. Only exit status and a private-interaction notice return.
  Closing/hiding the panel does not stop a process; its explicit Stop control does. Long-lived
  servers still use `launch_program`; unattended tasks and third-party command tools keep their
  own noninteractive execution paths.
- **Suggested follow-up** appears after a successful completed response, only while the
  composer is empty. Click it or press Tab to fill the draft. Review and send it yourself.
  Suggestions are deterministic and do not make another inference request.
- **Preview** is a dockable side panel with Web and Images browsers, accessible from the tool
  stripe even in an empty chat. Agent preview tools and transcript links select content there
  without overlaying the conversation. Enter an HTTP(S)/localhost address, navigate/reload a
  page, or browse the conversation's images. A page's scripts cannot access Antimatter's desktop bridge; permissions, downloads,
  and unsolicited popups remain blocked. Electron/web apps can be previewed through their
  local web server; this is not a general embedded native-desktop application host. Native page
  bounds hide when the panel closes or another floating tool/dialog overlaps it. Audio, 3D,
  and dedicated code viewers have an explicit extension seam but are not implemented yet.
- **Live permissions** apply to pending and future tool calls in the current conversation and
  its child agents. Ask → Full releases only calls the policy now permits automatically; sudo
  and other always-confirm operations still ask. Downgrades are checked before execution.
  A mode change does not undo or stop an already-running action. The model's system guidance
  refreshes at the next inference boundary without needing a new conversation.
- **Desktop avatar** is opt-in in Settings. Choose Atom, Robot, or Cat; drag its name to move
  it, click its face to reopen Antimatter, or right-click to change/hide it. It displays active
  work and pending approvals. Choice, visibility, and position persist across restarts.
- **Live voice** connects explicit microphone sessions to the main chat and avatar controls.
  Speech starts turns or queues ordered guidance while coding; tool approvals stay separate.
  The first version uses utterance-based transcription and half-duplex spoken responses,
  not native realtime speech-to-speech. See [setup, privacy, and limits](./live-voice.md).
- **Settings** keeps the flat in-app layout, grouped into General, Models & providers, Voice,
  Remote devices, and Updates & about. Local-server controls live only under Local engine;
  model selection and generation settings remain in the Model Library. Advanced source,
  download, and engine details expand on demand. Unsaved forms survive category changes;
  leaving Remote devices intentionally cancels its pending pairing code.
- **Agents** have chronological text/tool transcripts, restored history, live guidance, and
  stop controls. Child runs inherit the calling chat's model unless explicitly pinned and
  cannot exceed the parent's current permissions. Completed tasks require a new dispatch;
  arbitrary recursive subagent trees are not implemented.
- **Scheduled** uses the existing persistent task queue. Review workspace, agent, model,
  access, interval, next run, and last outcome. Pause prevents future runs without cancelling
  a run already in progress. Antimatter must remain running (the tray is sufficient); it is
  not an operating-system wake service.
- **Pull requests** reads the selected workspace's GitHub.com origin using GitHub CLI. Sign
  in with `gh auth login` in your own terminal. Listing/inspection never checks out a branch,
  comments, merges, or modifies a pull request. Review opens a new read-only chat draft.
  Enterprise hosts and write-side PR management are not included in this first pass.
- **Skills / Plugins** discovers project `.agents/skills` and personal `~/.antimatter/skills`
  packages. Models see bounded metadata and use the app-owned `read_skill` tool for complete
  instructions and linked text resources. Existing agent tool allowlists must explicitly include
  `read_skill`; they are not silently widened. Local plugins are imported disabled and require
  an explicit review before enabling their skills or stdio MCP servers. This is local import,
  not a marketplace, hook runner, or automatic dependency installer. See
  [local extension formats](./local-extensions.md).

The agent design follows the documented [parent/child workflow](https://learn.chatgpt.com/docs/agent-configuration/subagents)
and [local scheduling model](https://learn.chatgpt.com/docs/automations?surface=app), not a claim of
complete parity with every Codex capability.

## Android workflows

The phone is a client for a paired desktop, not a second inference host. It works with the
desktop's real projects and conversations. Rename, pin, delete, send, stop, guidance, and
approval actions go through the authenticated host protocol; failed operations are not
reported as successful local edits. Unsent drafts are encrypted with Android Keystore and
scoped to their host and conversation. See [Android setup and scope](../android/README.md).

Before a public mobile release, explicitly choose whether these remaining capabilities are
in scope: background completion notifications, attachment transfer/authenticated image and
web previews, mobile terminal access, and desktop-only agent/extension management. Unsupported
controls should stay hidden or explain their limits, not offer a nonworking action.

## Release gates

- [ ] Complete a physical QR pairing/reconnect run on the tester's phone and network. Verify
  the displayed identity and project before sending a real task.
- [ ] Exercise a real end-to-end chat with tools, an approval, stop, and reconnect from Android.
  Verify no duplicate send and that drafts survive a process restart.
- [ ] Exercise two parallel child tasks with different parent models/workspaces; reopen their
  transcripts, guide/stop one, and lower parent permissions while a child is running.
- [ ] Test preview navigation, failure/retry, closing, and hiding the main window on target
  platforms, including actual locally served web/Electron development projects.
- [ ] Validate native terminal and avatar placement/restore on each supported desktop OS.
- [ ] Validate real Omni transcription, then a user-started microphone conversation with coding,
  speech interruption, mic mute, approvals, avatar-only background use, and reconnect/failure.
  Verify latency and GPU memory contention with the actual input/coding models before shipping.
- [ ] Review local extension trust/permission behaviour and scheduled-task restart behaviour.
- [ ] Run `npm test`, `npm run typecheck`, `npm run bundle`, `npm run release:verify`, and
  `npm run android:verify` against the final release tree.
- [ ] Provision a protected Android signing key and test the signed upgrade path. Debug APKs
  are for sideload testing; unsigned release APKs are not a production installer.
- [ ] Perform clean-machine installer/GPU-backend and automatic-update tests before publishing
  a new version to the managed build share. Do not reuse stale alpha artifacts as this build.

The current desktop project headings are still fixed grouping buckets; per-conversation
directories and the remote project's real paths are authoritative. A fully editable desktop
project catalog is separate work and should not be advertised as complete.

## Verified in this client pass (2026-09-26)

- 748 desktop tests and 98 Android JVM tests pass. Desktop typecheck/bundle, Android debug
  and release lint, and debug/release APK assembly pass.
- Native Linux smoke: local HTTP content renders inside the preview panel with no desktop
  bridge or Node access; closing removes the native pane. Avatar enable/change/hide and
  restricted bridge work. External terminal opens in the exact conversation repository.
  Skills, Plugins, Scheduled, Pull requests, and Settings pages load without errors.
- The new debug APK is installed on the attached phone without clearing data and cold-launches
  successfully. The device is currently unpaired, so physical QR/workflow tests remain open.
- Release inputs pass using the source matching the vendored Beholdd commit (`7dbcc396`), and
  the bundled Vulkan runtime verifies. If a sibling Beholdd checkout has advanced, point
  `ANTIMATTER_BEHOLDD_SOURCE` at a clean checkout of the vendored commit when running
  `npm run release:verify`. Do not regenerate licenses from a different revision just to
  silence a mismatch. No new release was packaged or published in this pass.

## Voice implementation checks (2026-09-26)

- 828 desktop tests pass, including the real tool loop with fake inference/tools: ordered voice
  and typed guidance, delivery/cancellation, and spoken words never approving a write.
- Typecheck and a separate production bundle pass without replacing the running pairing build.
- The installed local Kokoro service generated a valid synthetic WAV in memory. No microphone
  was opened or audio played during this check.
- Isolated Electron control/visual smoke passes with simulated audio and real microphone/network
  access denied: Start, mute, playback interruption, transcript recovery/retry, Stop, and remote
  consent. Repeat after bundling with `node scripts/smoke-voice-renderer.mjs`.
- Actual 30B Omni transcription and a user-started microphone session remain release gates.
  The running app was not restarted while the user was testing phone pairing.

## Settings implementation checks (2026-09-26)

- 836 desktop tests, typecheck, and a separate production bundle pass. The application's
  live build was not replaced or restarted during this settings pass.
- Isolated Electron renderer smoke verifies category visibility, lazy reads, profile/source/
  voice/token draft retention, QR cancellation, engine/download deep links, narrow layout,
  and engine information retry without overwriting config/host/port edits. All IPC is mocked;
  network, device access, and actual server lifecycle calls are blocked.
- Repeat the smoke after bundling with `node scripts/smoke-settings-renderer.mjs`. An alternate
  production assets directory can be passed as the first argument for isolated builds.

## Permissions, terminal, and Preview checks (2026-09-26)

- Desktop regression tests cover live permission upgrades/downgrades, pending approval races,
  child-agent permission ceilings, current grounding, and no terminal dispatch before approval.
  The full desktop suite, typecheck, and isolated production bundle pass.
- `node scripts/smoke-terminal-backend.mjs` runs real Electron/node-pty processes using only
  synthetic input. It verifies exact-once execution, output privacy, snapshot offsets, and
  cancellation of Bash and its child. This is not a real privileged/sudo operation test.
- `node scripts/smoke-terminal-renderer.mjs` verifies real xterm rendering with mocked IPC:
  session selection, replay without duplicate output, manual-shell adoption, docking/hiding,
  private-input focus protection, delayed selection races, and confirmed-versus-pending stop.
- `node scripts/smoke-preview-panel.mjs` checks Web/Images UI and mocked native-browser lifecycle,
  image reloads, navigation, error recovery, visibility, conversation isolation, and overlapping
  floating-window/dialog handling. It does not replace end-to-end browser tests on target OSes.
- Renderer smoke scripts accept a production assets directory for an isolated build. The live
  application has not been restarted or replaced during this pass.
- Conversation repair remains a [design proposal](./conversation-repair-proposal.md). Start with
  an idle-only **Continue as repaired copy** workflow; editing visible text alone cannot safely
  repair the separately retained model/tool history.

## v1 release preparation checks (2026-09-26)

- The final desktop preflight passes 900 tests and typecheck. Android v1.0.0 / versionCode
  10003 passes 98 JVM tests, debug/release lint, and both APK assemblies. APK metadata confirms
  camera, autofocus, and camera.any are optional so manual pairing remains available without
  camera hardware. The release APK is still unsigned.
- The pinned native Beholdd CPU binary and llama.cpp Vulkan compatibility payload verify,
  including runtime hashes and shared-library resolution. Vulkan device enumeration detects
  the build host's Radeon GPU; enumeration alone does not establish inference compatibility.
- Stable-version packaging now records an explicit backend inventory from the packaged
  resources. Missing or changed Vulkan libraries fail assembly instead of silently producing
  a CPU-only release. GPU drivers and Vulkan ICD configuration remain host prerequisites.
- Packaging, real installer/upgrade checks, and publication must still finish successfully.
  Their generated manifests and logs are the release evidence; these preparation results
  do not mark the outstanding physical-device and live microphone checks complete.
