# Antimatter v18

Desktop source **v18** uses compatibility package **18.0.0**. Android retains its
public **v1** label, with package **18.0.0** and upgrade counter **10012**.

This source update prepares Antimatter for standalone open-source distribution.
It adds the MIT license, contributor and security guidance, donation links, and
source/history audit tooling. Setup and release documentation now describe explicit
configuration, optional local runtimes, and reproducible checks without assuming a
maintainer's machine, private network, or installed companion project.

Dependency updates move Electron from 44.3.0 to 44.10.2, Vite from 6.4.3 to 6.4.5,
and the Model Context Protocol SDK from 1.30.0 to 1.32.2, with transitive lockfile
updates. Supported build hosts use Node.js 22.20+, 24.12+, or 25+, matching the
dependency requirements. Production
packaging still requires its own native-module, backend, installer, Android signing,
and device verification; this source version does not announce published binaries.

Public release identity, compatibility package versions, installer pins, and Android
package metadata are synchronized. Existing release history is retained below.

---

# Antimatter v14 — previous release

Desktop **v14** adds the Vault: credentials you keep on this computer that a conversation may
*use* without ever being told what they are. The compatibility build is **14.0.0**; Android
remains **v1**, with upgrade counter **10011**.

- **The Vault, off until you turn it on:** **Settings → Vault**. Store the credentials you would
  otherwise type by hand — your `sudo` password, a service login — each under a short tag, with a
  label, an optional account name and a note saying what it is for. Secrets are sealed by the
  operating system keyring and written to `<userData>/vault.json` at mode 0600. There is no
  plaintext fallback and no reveal control: on a session with no GNOME Keyring or KWallet the
  Vault refuses to store anything and says so, and the only way to change a stored value is to
  type a new one over it.
- **What a conversation can see:** two tools, and the difference between them is the design.
  `vault_list` returns tags, labels, account names, notes and the environment variable each
  credential would arrive under — never a value — and is a read, allowed in every permission mode,
  because a model that cannot see which credentials exist asks you for one in chat instead.
  `vault_use` spends one, and **always** stops for your approval first, including under Full
  access: the question is not whether a turn may change files but whether it may act as you, and
  no permission level can answer that in advance.
- **How the secret actually travels:** nowhere near the model. The unsealed value stays in
  Antimatter's main process — it is not sent to the window, to the bundled tool server, or into a
  tool argument, which is what the approval prompt quotes, what the transcript stores and what is
  replayed to the model on every later round of a turn. Antimatter sets it as an environment
  variable on the shell that runs the next command, not on the command line, because
  `/proc/<pid>/cmdline` is world readable on Linux and `/proc/<pid>/environ` is not. The model is
  told the variable's name and how to read it from standard input.
- **Bounded by the approval, not by the turn:** one approval covers at most ten commands and five
  minutes, so a privileged step of two or three commands does not become a reflex of repeated
  prompts. The grant is dropped when the turn ends, when the Vault is switched off, and when the
  credential is edited — a replaced secret never stays armed in a run already under way.
- **Accidental leaks are masked:** every tool result that passes the Vault, not only the shell's,
  is scanned and the granted value replaced with `[vault:<tag> redacted]` before the model or the
  transcript sees it. That covers `env`, a script that prints its own configuration, a file the
  secret reached and a delegated agent's report. It does not cover deliberate exfiltration — a
  model granted a secret runs commands that can encode it — which is why each use is a decision
  you make with the reason in front of you.
- **Its own card in the transcript:** a Vault call does not render as an ordinary tool row. It gets
  a framed card with the vault mark, the credential's tag, the stated purpose in full, and a
  standing line saying the value is not in the card, was not sent to the model and is not in the
  transcript. There is no "show value" control because the window was never given one.
- **Never unattended:** scheduled runs, orchestrated work and delegated sub-agents receive no Vault
  tools at all, catalogue included. There is nobody there to approve a use, and only the
  conversation you are watching can spend a credential.

Also fixed:

- **An unavailable Pensieve bundle no longer fails the turn it was attached to.** `vendor/pensieve/`
  is gitignored apart from its manifest, because the corpus is not distributable — so a checkout
  routinely carries the Pensieve opt-in from an earlier run with no `bridge.py` to honour it. The
  runtime was attached on the strength of the setting alone, and every turn then died with
  `Pensieve bundle unavailable: ENOENT …`, on every model, since the bundle has nothing to do with
  which model answers. Enabling now requires the bundle to be reachable as well as the setting to
  be on; an unreachable one stands the experiment down and reports itself on the Experimental page,
  where the reason was already being displayed.

---

# Antimatter v13 — previous release

Desktop **v13** adds persistent per-project memory, a review workspace shared between you and
the agent, and one Code workspace that holds Ny and Matrix together. The compatibility build is
**13.0.0**; Android remains **v1**, with upgrade counter **10010**.

- **Pensieve project memory, experimental and off by default:** enable it under **Settings →
  Experimental → Pensieve**. Project conversations gain a persistent memory of NIL, Ny and Matrix
  references, observed results and verified repairs. Each canonical project root keeps its own
  store under `<userData>/pensieve/projects/`, is recalled into later conversations, and survives
  application restarts; turning Pensieve off preserves what it has saved. The model receives two
  tools: `pensieve_recall` for bounded references and evidence, and `pensieve_check_project`, an
  app-owned compile-only check that pins the SDK and verifies source identity before and after.
  The switch applies to this profile and does not change the selected model.
- **What the memory trial does not cover yet:** interactive chat and Code in a confirmed project
  folder only — delegated and scheduled agents do not receive this runtime. The check needs a
  `nil.project.json` manifest and an SDK matching the pinned curriculum (395 entries at SDK source
  `9e3341501ee697dd5150464a4d7ffc952644145b`). Automatic checks cap source capture at 512 files
  and 4 MiB, with a 60-second deadline and 64 checks per turn. A passing check proves that the
  entry and its imports compile; it does not certify runtime or application behavior, so run the
  application and its acceptance cases as part of the workload. Learned evidence currently
  requires the same curriculum ID, and background consolidation stays disabled for the trial.
- **Code Review, shared between you and the agent:** capture working changes or selected source
  lines into an immutable snapshot, so findings stay anchored as the code moves on. Attributed
  discussion, verification states and review decisions persist per workspace. Open **Code Review**
  on the tool stripe or **Review code** in the editor; **Ask agent to review** prepares a chat
  draft, and agents can create and annotate reviews through their own tools. Only you can resolve,
  dismiss, approve or request changes. Review annotations never stage files, change source, or
  publish to GitHub.
- **One Code workspace for Ny and Matrix:** a new welcome screen starts a NIL Framework project
  with source, a build manifest and a runnable entrypoint — as a Ny application, a Matrix
  application, or a Matrix entrypoint with a Ny module — or opens an existing folder. Matrix joins
  Ny in editor highlighting and intelligence, with a reworked toolbar, console pane and framework
  project panel.
- **Code folders now follow the chat that opened them:** Code waits for its host chat binding and
  opens that exact folder and chat identity. Unsaved buffers hold a switch until **Save & switch**
  writes them in the previous root, and **Discard & switch** never writes a discarded buffer into
  either folder. Running work needs an explicit stop before another chat's folder opens, and a
  missing folder no longer falls back silently — the picker binds its replacement.
- **Service failures read as diagnostics, not as the model talking:** application and service
  failures collect in a **Diagnostics** drawer beside the conversation, timestamped and selectable,
  and are excluded from the context sent to providers. Model switching, cancellation and source
  loading were rebuilt around a single inference queue.
- **Guarded native OpenMythos HAG launch:** an explicitly qualified `openmythos-27b-hag` entry on
  the managed native service now has a launch path. This does not replace the vendored binary,
  enable the profile, or ship a qualification manifest — the existing Vulkan choice and the
  separate tiny HAG preview remain what you select. Startup and model-list requests keep the
  registry cold, each request for an unloaded OpenMythos model repeats memory and temperature
  admission, and first prompts share one queue with manual engine transitions: they refuse busy or
  externally owned sibling engines and await retirement before starting a replacement. Native
  faults require an explicit restart, and quitting waits for verified native service retirement.
- **NIL project streaming and cancellation** are verified end to end through the Electron PTY.

Pensieve and the native HAG path are both experimental, and neither is on in a fresh
installation. For the record on HAG sizing: the public `Hello.` fixture with the default built-in
tools measures 3,433 prompt tokens against the pinned OpenMythos tokenizer and template, so
reserving 512 output tokens needs at least 3,944 evaluated positions — already past the candidate
2,048-position limit, before app tools, standing instructions or history are added. Whole-model
numerical and lifecycle qualification remains outstanding.
Existing Android pairing and the protected production signing identity are preserved.

---

# Antimatter v12 — previous release

Desktop **v12** adds an optional experimental HAG backend. The compatibility build is
**12.0.0**; Android remains **v1**, with upgrade counter **10009**.

- **Try HAG after updating:** the welcome notice offers **Download & enable HAG** or **Keep current setup**. Enabling it
  provisions the pinned Qwen3 0.6B Q8_0 model (639,447,744 bytes, about 610 MiB) and a
  separate native Beholdd source. Enabling HAG or choosing its model keeps it unloaded;
  the first chat prompt starts its service and loads the model. You can select **Turn off HAG** in **Settings → Experimental → HAG runtime** and continue
  using your existing model sources.
- **Your working engines stay available:** the existing Beholdd CPU and llama.cpp Vulkan
  backends are still bundled. HAG does not replace OpenMythos or change its runtime profile.
- **Model selection stays cold:** choosing a model or restoring a saved selection no longer
  starts local model services. Models load on the first chat prompt; catalog and readiness
  checks remain observational.
- **Experimental hardware and model scope:** this release supports Linux x86_64 with AMD
  `0x1002:0x1586` / GFX1151, an accessible amdgpu render node and a systemd user session.
  The supported model is the pinned Qwen3 0.6B checkpoint. Other GPUs, models and quantizations
  are not enabled by this opt-in. The initial composer preview is text-only, with up to 64
  output tokens and a conservative 1,024-position total budget. It omits tools, project
  instructions and memory context; existing history must fit and cannot contain tool turns.
  Over-budget or tool-bearing histories are refused without deleting conversation content.
  The complete 8,079-token editor tool prompt and broad production workloads remain unqualified.
- **Separate, verifiable payload:** HAG ships in its own executable, with its source revision,
  Cargo feature set, model identity and complete license corpus recorded in the release.
  Disabling it keeps the downloaded model for a later retry.

The backend remains experimental. Its internal 16,384-position allocation does not enlarge
this release's bounded composer preview or qualify every position for numerical correctness
or performance.
Existing Android pairing and the protected production signing identity are preserved.

---

# Antimatter v11 — previous release

Desktop **v11** brings the recent workspace, Ny, model, voice, and coordination work into a
Linux x86_64 release. The Android companion graduates to **v1**, with repaired connection and
turn synchronization. Both use compatibility build **11.0.0**; Android's upgrade counter is
**10008**. Public mobile and desktop release labels are independent.

- **Android connection recovery:** old requests and failed connection attempts can no longer
  replace a newer healthy session. Foreground return and cold startup recover the paired host,
  and a successful reconnect clears its obsolete connection warning. Recovery does not resend
  accepted prompts; failed sends retain their drafts.
- **Phone and desktop turn control:** the host now publishes remote turn ownership before
  streaming begins and retains it through durable completion. Desktop shows phone-started work,
  including Stop, steering, and diagnostics. Reopening a chat restores active ownership without
  duplicating text, settling live tools prematurely, or losing a newer transcript. Phone control
  waits for a starting turn to be accepted and can target an existing desktop-owned turn.
- **Android v1 distribution:** the drawer and About screen use the stable public label, with
  the compatibility build available for support. The release APK uses a dedicated production
  signing identity, and distribution verifies its certificate, package metadata, and unchanged
  application payload against the tested unsigned build.

- **HAG development qualification:** the opt-in live editor smoke can click Stop after
  visible count-up content, verify the HTTP abort, and submit a fresh conversation.
  The external Beholdd gate still has to prove native cancellation, healthy reset and
  CPU parity on reuse; the client alone does not claim backend qualification.
- **Ny workspace:** create starter projects, discover or select a coherent Ny SDK, edit with
  highlighting and snippets, and use SDK completion, hover, definition lookup, and a searchable
  symbol outline. Check, Build, Run, and Debug save modified files and use the real toolchain.
  Source debugging adds breakpoints, stepping, call stacks, locals, and read-only evaluation.
  Semantic navigation remains document-local in the current Ny SDK; debugging targets source-mapped
  NIL in its VM.
- **NIL inspector:** open compiled artifacts or inspect a successful build to browse functions,
  instructions, constants, types, annotations, and source mappings without executing the module.
  Mapped instructions link back to source files inside the selected project.
- **Appearance and layout:** the chosen accent now reaches primary controls, the editor, terminal,
  About window, desktop companion, and recovery screen. The sidebar supports drag and keyboard
  resizing, remembers its width, and lets users hide unused sections. Orange is available in the
  accent presets. Atlas provides searchable exchange navigation; the new Flow view follows
  actions, agents, and decisions alongside Transcript, Research, and Code. Eligible tool panels
  can detach into separate windows, retain their position, and dock back into the workspace.
- **Live voice:** streaming input provides partial captions, and compatible speech output begins
  playback before the full response finishes. Interruption and bounded audio queues improve
  responsiveness. Voice still requires explicitly configured, compatible local or remote services.
- **Assistant and models:** configure the assistant's name and personality, supported thinking
  levels, and user-managed model names and visibility. Local, Distributed, and Provider filters
  separate the appropriate cards. First-run setup offers pinned, tested workload downloads and
  runtime configuration, with provenance and hardware requirements documented.
- **Diagnostics and delegation:** the inference overlay displays observed time to first token
  and server-reported prefill/decode measurements. Child-agent scheduling respects the configured
  request capacity so single-slot local servers can delegate work.
- **Engine profiles:** supported local llama.cpp model cards expose context per slot and parallel
  slots. Preserve a Straight shot baseline and switch to an Orchestration copy when the engine
  is idle. Applying a profile reloads and verifies the engine before requests resume.
- **Chat coordination:** explicitly connected chats in the same project can read visible history
  and exchange attributed notes until the connection is revoked. Experimental Bot chat adds
  monitored channels shared within this installation. Both preserve each chat's permissions;
  posting does not automatically start an idle model.

See the [Ny guide](../docs/ny-language-support.md), [Live voice guide](../docs/live-voice.md),
[setup guide](../docs/personalization-and-setup.md),
[engine profile guide](../docs/model-runtime-profiles.md), and
[Android guide](../android/README.md) for capabilities and current limits.

Android uses the paired desktop for inference; it does not run the model on the phone. Host asset
transfer, terminal/subagent management, durable background notifications, and an Internet relay
remain outside this mobile release. Existing debug APKs cannot upgrade in place to the new
production signing identity; Android requires a separate migration/reinstallation, which removes
local pairing and drafts. Do not uninstall a test build until those local data are no longer needed.

Physical-device checks covered the retained pairing, foreground recovery, and cold restart.
Automated transport and renderer tests cover turn/control races without model execution. These
checks do not establish GPU throughput or explain a particular model's thermal behavior.

---

# Antimatter v3 — previous source update

The chat composer now explicitly enables native spell checking and offers spelling corrections,
**Add to dictionary**, and standard editing actions on right-click. Corrections remain unsent
draft edits, including while steering a running agent; code and terminal inputs are unchanged.
Checking uses the operating-system/session language preference. Typed words are checked locally;
Electron may download its language dictionaries on Linux or Windows.

This source update does not replace the published v2 Linux tester artifacts. The inference
backends, default model, and Android feature scope are unchanged.

---

# Antimatter v2 — previous release

This Linux x86_64 tester release adds light and dark appearance controls, a more usable desktop
companion, ready-to-copy model tests, and reviewed imports of existing coding conversations.
The flat workspace, chronological transcript, integrated terminal, and Preview panel remain.

## What changed since v1

### Appearance that follows the workspace

- Choose **Dark** or **Light** in Settings → General → Appearance. Dark remains the default.
- Pick a secondary accent preset or a six-digit hex color. Orange remains the primary action
  color, and the accent tone adapts for contrast. Restore the default dark and teal appearance
  with one control.
- Appearance is saved across restarts and updates the workspace, About window, and desktop
  companion. Existing terminals change their palette without restarting the shell or losing
  output; open code editors keep their documents, selections, scroll positions, and undo history.
- Move the optional **Atom, Robot, or Cat desktop companion** by dragging its portrait, name,
  or status area. Its compact icon controls remain separate from the drag surface, and its
  position is saved when moved or hidden. Use the window icon to reopen the main app.

### Repeatable model tests

**Developer → Model test prompts** contains eight complete projects, ordered from small tools
to integrated applications: a tasks CLI, folder audit report, recipe notebook, Kanban board,
inventory API, Markdown search index, issue tracker, and CSV exploration studio.

Each prompt asks for real implementation and verification in a disposable scratch workspace,
preserves existing work, and bounds specialist delegation to useful independent tasks. Copy
the complete prompt into a new chat after choosing its workspace and model. Manual text selection
is available if clipboard access fails. Copying does not create a chat, start inference, execute
tools, install dependencies, or deploy anything. These are test projects, not benchmark scores
or a guarantee that a model will complete them.

### Bring existing conversations with you

New **Claude chats**, **Codex chats**, and **OpenCode chats** sidebar sections open a review-first
import flow. Choose files or a folder, inspect the available conversations and import notes,
then select the conversations and destination project yourself. Supported inputs are:

- Extracted Claude `conversations.json` exports and Claude Code JSONL sessions.
- Codex app/CLI rollout JSONL sessions, including archived sessions; `history.jsonl` alone is
  not a complete conversation.
- Official **OpenCode v1 session JSON exports**, such as the file produced by
  `opencode export SESSION_ID > session.json`. Raw SQLite databases, internal storage folders,
  share URLs, and unverified alternative export schemas are not supported.

Import appends new Antimatter copies without modifying source files or replacing existing chats.
Re-importing an existing source ID skips it rather than merging later messages. Source groups
remember their open/closed state, temporarily expand for search, and keep pin, rename, and delete
controls. Pinned imports appear in Pinned; imported chats are not duplicated in Recent.

Supported text and tool activity retain their transcript positions, but imported tools are inert:
they cannot execute, request approval, open a preview, or reconnect to a live agent. Source
instructions, provider configuration, workspace paths, and permissions do not carry over.
Imported chats start with Ask access and no workspace selected. Attachments use placeholders,
and embedded Markdown images are not fetched automatically. Malformed, ambiguous, or unsupported
records produce notes or a refusal rather than an invented complete history.

**Review sensitive content before continuing an imported conversation.** Import reads the files
locally, but continuing sends the conversation history to the provider you choose. This is a
one-time import, not a connection to the source app or a live sync. See
[`docs/model-tests-and-chat-imports.md`](../docs/model-tests-and-chat-imports.md) in the source tree
for supported formats, limits, and privacy details.

## Installation, updates, and scope

- Public versions now follow Execute's rolling **v2 → v3 → v4** convention. This release is
  **v2** in the app and **2.0.0** in artifact filenames, receipts, and the update feed so existing
  installers remain compatible. Both Git tags identify the same source commit.
- This release targets **Linux x86_64**. Android remains a separate companion testing and
  signing track, not a signed public mobile release. No Windows or macOS installer is claimed.
- The inference baseline is unchanged: **native Beholdd CPU** plus the bundled **llama.cpp
  Vulkan compatibility runtime**. The host still needs a working Vulkan loader/ICD and GPU
  driver, plus OpenSSL 3. Drivers are not bundled; this release does not add CUDA, ROCm, native
  Beholdd GPU acceleration, or a new native model architecture.
- The installer retains the pinned **Qwen3-Coder 30B A3B Instruct Q8_0** default download
  (about 30.25 GiB), verifies it before activation, and preserves existing model/server settings.
  Nemotron, Omni, and voice-output weights are not the installer default.
- Managed updates still verify their payload and defer restart while active work, voice, or
  unsaved edits need the current session. Closing the main window keeps the app in the tray.
- Voice remains utterance-based and half-duplex. Doctor/conversation repair and Preview's 3D,
  audio, and dedicated code viewers are not implemented in this release. Chat imports do not
  add historical-message editing or repair.

Use the accompanying installer README, manifests, asset checksums, and `backend-inventory.json`
for the exact package and host prerequisites. A build-host GPU enumeration is not an inference
benchmark or proof of compatibility with every GPU. The
[`v2 readiness checklist`](../docs/v2-release-readiness.md) tracks validation separately; these
notes do not assert that packaging, publication, or outstanding target-device checks have passed.

---

# Antimatter 1.0.0 — previous release

Antimatter v1 brings the multi-provider coding workspace together: a flat desktop interface,
chronological chat and tool activity, an integrated terminal, and a persistent Preview side panel.
This release targets **Linux x86_64**. Android companion development is included in the source
tree, but a signed public mobile release is a separate distribution and validation milestone.

## What changed since alpha 2

### Conversations and control

- **Live permissions.** Change access without starting a new conversation. Pending and future
  tool calls, including child-agent calls, use the current mode. Ask → Full releases only calls
  the policy now permits; sudo, screenshots, and other always-confirm operations still ask.
  Downgrades are checked before execution. Changes do not undo or stop an action already running.
- **Integrated terminal.** Approved built-in `run_command` calls in interactive chats and their
  child agents run once in dedicated sessions in the existing inline/floating terminal. A session
  picker keeps manual workspace shells and command output together. Sudo input is entered there,
  not in chat. Any user input withholds that command's entire output from model context and Carbon;
  only its exit status and a private-interaction notice return. Hiding the panel does not stop work.
- **Preview as a workspace panel.** Web and Images views sit beside the conversation and can dock
  or float. Agents can show a workspace image or a live HTTP(S)/localhost application there; users
  can navigate, reload, retry failures, and browse the conversation's images. Preview pages cannot
  access Antimatter's desktop bridge. Downloads, permission requests, and unsolicited popups stay
  blocked. Locally served Electron renderer pages are supported, not arbitrary native windows.
- **Clearer child-agent activity.** Text and tool calls remain in chronological order, histories
  can be reopened, and active child tasks accept guidance or cancellation. Children inherit the
  calling chat's model unless explicitly pinned and cannot exceed its current permissions.
- **Suggested follow-ups.** After a successful response, an empty composer can offer an editable
  next message. Click it or press Tab to fill the draft; nothing is sent automatically and no extra
  inference request is made.

### Models, workspace tools, and settings

- **Bring your own provider.** Native OpenAI Responses, Anthropic Messages, OpenCode Zen Responses,
  local engines, and OpenAI-compatible Chat Completions endpoints share a source-scoped Model
  Library. Model cards collect prompts, runtime limits, and routing configuration; model availability
  and capabilities still depend on the selected source.
- **Memory and project instructions.** The About you profile, project instructions, and editable
  personal/project notes carry useful context across conversations. Memory tools follow the live
  conversation permissions.
- **Local skills and plugins.** Discover project and personal skills, inspect complete instructions
  and linked text resources, and insert a skill into a draft. Local plugins import disabled and
  require review before skills or declared stdio MCP servers are enabled. This is not a marketplace
  or automatic dependency installer. Plugin processes run as the user's OS account and must be trusted.
- **Scheduled work.** The persistent task queue exposes workspace, agent, model, access, timing,
  and outcomes. Antimatter must remain running, including in the tray; schedules do not wake a
  powered-off or suspended host.
- **Pull requests.** Browse and inspect the selected workspace's GitHub.com pull requests through
  an authenticated GitHub CLI. Review opens an unsent read-only chat draft. Browsing does not check
  out branches, comment, merge, or otherwise change a pull request.
- **Grouped settings.** General, Models & providers, Voice, Remote devices, and Updates & about
  replace the long mixed settings page. Advanced infrastructure controls expand on demand, and
  unsaved forms survive category changes.

### Voice and desktop companion

- Choose an opt-in **Atom, Robot, or Cat avatar**. It shows work and approval state and has compact
  voice controls; visibility, choice, and position are saved.
- Explicit microphone sessions use the main conversation and its coding model. Speech starts a
  turn when idle or queues ordered guidance while the agent works; spoken words never approve tools.
- This first voice mode is **utterance-based and half-duplex**, not realtime speech-to-speech or
  automatic spoken barge-in. A compatible transcription/audio-input source and an optional speech
  output source must be configured separately. The Linux installer does not download Omni or Kokoro
  weights. Audio clips stay in bounded memory, while recognized text follows normal chat history.
- Voice can continue with the main window hidden only while the avatar remains visible. Automatic
  updates wait for voice to stop. See the source documentation in `docs/live-voice.md` for setup,
  latency, privacy, and recovery details.

### Android companion progress

The phone uses a paired desktop's real projects, models, and conversations rather than a temporary
workspace. QR pairing uses a short-lived offer and pinned HTTPS on an explicitly enabled LAN/VPN
interface. Host-authorized operations include chat creation, rename, pin, confirmed deletion,
streaming turns, approvals, guidance, and stop. Reconnection uses cursor-based event replay, and
unsent drafts are encrypted with Android Keystore and scoped to the host and conversation.

Android does not run inference or receive provider keys. Mobile attachment/host-preview transfer,
terminal access, desktop agent/extension management, background completion notifications, public
Internet relay, and wake-on-demand are not included. Only public HTTPS pages can load directly on
the phone; desktop localhost is not the phone's localhost. Debug APKs are sideload test artifacts,
not production installers. Physical-device/network validation and a protected signing/upgrade path
remain required for mobile distribution; see `android/README.md` in the source tree.

## Linux installation and inference backends

- Ubuntu 22.04+, Debian 12+, or a compatible x86_64 Linux desktop with glibc 2.34+.
- The user-local installer requires Bash, Python 3, GNU tar/coreutils, and `curl` or `wget`.
  It does not request root or install system GPU drivers. The unpacked archive does not need
  AppImage/FUSE support; an AppImage is an alternative.
- **Native Beholdd CPU** and the **llama.cpp compatibility (Vulkan)** runtime are separate bundled
  execution paths. The Vulkan bridge is not native Beholdd acceleration and is loaded only when
  selected. It uses adaptive GPU offload with CPU spill when a model does not fit in VRAM.
- Vulkan requires the host's `libvulkan.so.1`, a usable vendor or Mesa Vulkan ICD/driver, and
  OpenSSL 3 (`libssl.so.3` and `libcrypto.so.3`). GPU drivers, firmware, kernel modules, and ICD
  setup are not bundled. This package does not claim a CUDA or ROCm runtime.
- Unless `--skip-model` is supplied, the installer downloads the pinned **Qwen3-Coder 30B A3B
  Instruct Q8_0** checkpoint, exactly 32,483,934,528 bytes (about 30.25 GiB). Downloads resume and
  require the expected size and SHA-256 before activation. Existing model/server configurations
  are preserved. Nemotron and voice-model experiments are not the installer's default model.
- The default coder is text-only. Image analysis requires a separately configured source that
  advertises vision. Native Beholdd vision and Nemotron architecture parity are not claimed by this
  desktop release. Compatibility depends on the selected model and runtime, not a model-card label.

The installer, model manifest, runtime provenance, `backend-inventory.json`, and exact asset
checksums accompany the build. The backend inventory identifies the packaged runtimes and their
host-driver requirements; a build-host device probe is not a compatibility claim for every GPU.
Checksums detect corrupt or incomplete files; they are not a signed release attestation. Use the
managed project release share or the project's authenticated GitHub release, not an untrusted copy.
See the accompanying `README.md` for install commands, supported host libraries, and troubleshooting.

## Updates and data

Installed builds check the configured managed release share, verify and stage new payloads, then
install alongside the running version. With automatic updates enabled, Antimatter restarts only
when chats, agents, commands, voice, orchestration, edits, and unsaved buffers are clear. The live
composer draft is saved before restart. Settings shows blockers, offers **Restart now**, and lets
you disable automatic installation/restart. A source checkout is notified of a release but is not
replaced by the updater.

Closing the main window leaves work and the server running in the tray; explicitly **Quit** before
uninstalling. The uninstaller removes verified installer-owned application files and preserves
models, configuration, conversations, workspaces, and user projects.

## Scope and known limitations

- Doctor/conversation-repair mode is a design proposal, not a shipped feature. It does not yet edit
  or repair retained tool history.
- Preview's 3D, audio, and dedicated code viewers are extension points, not implemented viewers.
- Arbitrary recursive agent trees, an editable desktop project catalog, plugin marketplaces/hooks,
  GitHub Enterprise/write-side pull request management, and OS-level scheduling are not included.
- Interactive terminals apply to bundled chat command tools. Unattended scheduled/orchestrator work
  and third-party command tools retain their own noninteractive execution paths; long-lived servers
  continue to use `launch_program`.
- Voice latency and GPU memory contention depend on the configured audio/coding models. Automated
  tests and synthetic smoke checks do not establish compatibility with every microphone, GPU,
  window manager, phone, or network. Target-device and clean-machine checks remain release gates;
  this changelog does not declare those checks complete.
