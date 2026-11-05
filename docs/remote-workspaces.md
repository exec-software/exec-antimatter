# Remote workspaces

Remote workspaces let a thin Antimatter client use a trusted Antimatter host without moving the
host's models, credentials, projects, tools, or running agents onto the client. The Android app is
the first client. The desktop host and Android transport now implement the authenticated chat
slice described here; the product contract lives in
`android/app/src/main/java/co/antimatter/app/remote/RemoteWorkspaceContract.kt`.

This alpha deliberately uses a selected LAN or VPN interface. It does not yet provide an
account-backed Internet relay, host discovery, or wake-on-demand service. The computer must be
running, Antimatter must remain in the tray, and the selected network must be reachable from the
phone. Those are the remaining infrastructure differences from Codex remote connections—not
permissions silently delegated to the phone.

## Authority

The host remains authoritative for:

- inference sources and provider credentials;
- source/model catalogs and model profiles;
- the hidden provider transcript, including tool calls and tool results;
- filesystem confinement, MCP execution, terminals, debugging, previews, and Carbon records;
- active turn ownership, approvals, cancellation, and orchestration;
- conversation revisions and the ordered event cursor.

The client owns transient presentation state, per-thread draft text, local navigation, reconnect
intent, and an encrypted pairing credential. It must not infer that a command completed merely
because its connection dropped.

## Identity

Identifiers which look similar are deliberately not interchangeable:

- workspace ID: one paired Antimatter host;
- thread ID: one visible conversation;
- request ID: one active turn/run;
- command ID: one idempotent start/cancel/steer/approval operation inside a run;
- response message ID: the assistant row receiving that turn;
- source/model pair: one model inside one workspace;
- activity ID: one tool occurrence, even when a provider reuses its call ID;
- approval ID: one run-scoped decision;
- event cursor: an opaque host epoch plus one strictly increasing position inside that epoch.

A model is therefore selected by `(workspaceId, providerId, modelId)`. Provider and model IDs are
not globally unique across paired computers.

## Pairing and transport

1. The host creates one visible, short-lived, single-use pairing offer and renders it as a QR only
   after the user chooses **Add device**. Replacing, dismissing, consuming, or expiring the visible
   offer invalidates it on the host.
2. The user scans the non-URL payload with Antimatter's in-app Android scanner. Manual copy/paste is
   retained as an accessibility and compatibility fallback. Android does not export a pairing
   intent filter, and the payload is never handed to a browser, app link, external camera workflow,
   or competing custom-scheme handler.
3. The client establishes an authenticated HTTPS connection and verifies the host identity and
   certificate pin carried in the offer.
4. The host records a named device with explicit capabilities and returns a revocable device
   credential.
5. Android stores that credential behind Android Keystore. It is never placed in a URL, log,
   conversation, backup, or UI state.
6. Subsequent sessions use pinned HTTPS commands plus bounded, cursor-based long polling. A lost
   connection resumes from its last cursor or reloads an authoritative snapshot after an epoch
   reset.

Plain HTTP, ambient provider credentials, Electron IPC names, and raw filesystem paths are not a
remote protocol. The listener is off by default, binds one explicitly chosen interface rather
than a wildcard address, rejects browser-origin requests, and uses a persistent self-signed leaf
whose SHA-256 pin is carried in the single-use pairing offer. Device bearers and the TLS private
key are encrypted by the operating-system keyring; Android stores its bearer behind Android
Keystore. Pairing devices can be revoked from desktop settings.

## Bootstrap and synchronization

After authentication the client requests a versioned snapshot containing only public data:

- protocol version and host/app version;
- granted capabilities;
- public sources and their model catalogs, without API keys or storage paths;
- conversation summaries, pins, projects, and revisions;
- the selected conversation body and its revision;
- currently active turn summaries;
- recent pending, already-finished, and failed command outcomes;
- the current event cursor for this host process.

Conversation mutations are typed operations with an expected revision. The remote API must not
copy the desktop's broad whole-file `conversations:save` IPC call. A revision conflict returns the
current revision and enough information for a deliberate merge or reload.

## Turn lifecycle

Commands are idempotent by command ID. The turn's request ID remains stable across its distinct
start, steer, approval, and cancellation commands. A retry after a timeout returns the original receipt and
must never start a second inference run or repeat a tool side effect:

- start a turn;
- cancel a turn;
- steer a live turn;
- resolve one approval.

The host owns active-turn identity for both desktop and phone submissions. A paired device may
control a desktop-owned turn in the permitted project; a phone-owned turn remains restricted to
its originating device. Project membership comes from the current conversation, including for
desktop submissions that do not carry a remote project ID.

Each conversation keeps a host-owned, canonical workspace binding. Selecting a different chat
does not change that binding or its confirmation. Existing chats recover the exact workspace from
their saved context when possible; recovery alone never grants access. Missing or replaced
folders require selecting the folder again on desktop. The private binding and filesystem path
are excluded from phone snapshots.

For the same conversation, model, settings, and access mode, both clients build the same standing
instructions and tool catalog. Collaboration tools still enforce desktop-only execution and inbox
access; presenting their schemas to the model does not grant phone permission to use them.

The desktop subscribes to a revisioned snapshot of phone-owned turns before reading the initial
snapshot. This restores running indicators, Stop, and steering even if the desktop renderer loads
mid-turn. Controls use the request/run ID; transcript and reasoning use the visible response ID.
Main persists remote text and tool activity, so the desktop takes that authoritative transcript
instead of appending the same raw deltas a second time. Mirroring never submits another model request.

The host durably records acceptance and the normalized private command payload before dispatch.
Pending and interrupted dispatches are recovered serially before the listener becomes reachable.
Conversation mutations write a command effect marker in the same atomic replacement as the
mutation, so recovery can distinguish work that still needs applying from work that landed before
a crash. Revisioned mutations are revalidated rather than blindly replayed; a turn whose transcript
was opened before a host restart is marked interrupted and is never silently submitted for a
second inference run. Ephemeral cancel, steer, and approval commands settle `already_finished` when
their process-local target no longer exists. While the desktop process remains alive, a dispatched
control outcome also survives listener rebinds: if only the terminal ledger write failed, recovery
retries that write without delivering the control twice. A thread-creation effect retains its
host/client thread identity, so an exact late retry reconstructs the original receipt even after
the bounded terminal ledger row expires.

Terminal failures remain queryable at `GET /v1/commands/:commandId` and appear in bootstrap command
outcomes even after an event-journal epoch reset. Terminal ledger rows shed the private command
payload and retain only its canonical hash, receipt, and outcome metadata.

Idempotency history is deliberately bounded: terminal ledger rows have a seven-day retention
window and a 50,000-row ceiling, while the conversation store retains 50,000 atomic effect
markers. An exact retry remains safe while either record is retained, including when a creation
receipt has expired but its effect marker still holds the original host/client thread identity.
Once both histories have aged or churned out, that command ID is outside the protocol's replay
horizon and must not be resubmitted as if it were current.

Every event carries a workspace ID and an epoch-scoped, strictly increasing cursor. Turn events
include:

- text delta and liveness/waiting state;
- tool activity changes and approval requests;
- steering acknowledgement;
- context and usage reports;
- reported prefill progress and cache reuse, when supported by the inference server;
- preview availability;
- turn finished or turn failed.

The client retains the last applied cursor for the active process. On reconnect it asks for events after that cursor.
The host either replays the retained range or declares the cursor/epoch expired and provides a
fresh authoritative snapshot through the bootstrap/snapshot operation. Duplicate cursors are ignored; gaps or epoch changes trigger
resynchronization. Mobile network loss is normal and never means cancellation.

Snapshot recovery is serialized with event consumption: later events wait until the replacement
snapshot has been applied. Foreground return refreshes the saved connection without resubmitting
commands, and cancelling an old poll closes its socket. Transient TLS transport failures retry;
certificate identity failures still require deliberate re-pairing.

An authoritative snapshot clears turns whose terminal event was missed. Only a locally submitted
start that the snapshot could not yet have observed may remain provisional; old active turns are
not preserved indefinitely. A lost command reply is retried under the original command identity,
and a rejected send keeps its draft. Responses from replaced connection sessions cannot update the
new session's state or cursor.

Host snapshots include text and tool activity already emitted at their cursor, even before a
desktop renderer checkpoint. Mobile-owned text batches are flushed before projection; failed
persistence returns a retryable error instead of a snapshot that silently skips text.

Optional `context.updated.inference` and `activeTurns[].inference` carry the current request round,
phase, elapsed time, and reported token counters. Prompt progress includes the cached prefix in
the processed count; newly evaluated tokens are processed minus cached. Missing counters stay
unknown, and progress frames do not count as first-token output. Reconnect restores this state
without replaying inference. Older clients may ignore these additive fields.

Desktop debug details and Carbon records also include app-session keyed request fingerprints and
counts, allowing comparison of system instructions, tool catalogs, settings, and the common message
prefix without copying prompt bodies into diagnostics. These fingerprints stay on the host and
cannot be compared across app restarts. A cold model or changed prompt can still require extensive
prefill; a progress display is not evidence that thermals have improved.

An approval request includes a redacted caution reason and a complete, canonical action
description suitable for a human decision. It does not rely on the transcript's potentially
truncated arguments preview. Approval decisions are allow-once or decline; broader policy changes
remain host settings.

Every identifier and requested access level arriving from mobile is untrusted. The host binds
workspace, thread, request, model, attachment, and approval IDs to the paired device and current
session. The host's access ceiling overrides a mobile request for full access, and approval IDs are
run-scoped and consumed exactly once.

## Files, attachments, and previews

Workspace operations are capability-gated and scoped to the host-confirmed project root. Writes
carry an expected file revision so an offline client cannot silently replace newer work.

The protocol reserves bounded attachment uploads referenced by opaque IDs. The alpha host does
not advertise the files or previews capabilities yet, so Android keeps those actions unavailable
instead of pretending they succeeded. When enabled, transcript state contains their name, size,
media type, and asset ID—not an absolute client or host path.

Preview images and pages are also addressed by opaque, expiring asset IDs. A host may separately
authorize an external HTTPS page, but opaque assets and external URLs are distinct wire variants.
Authorization headers are never attached to a cross-origin page. The host never sends `file://`
URLs or local paths to the client. Web previews start with JavaScript, mixed content, file access,
and ambient credential sharing disabled.

Host failures use stable error codes plus a deliberately redacted user message. Raw provider
exceptions, tokens, host paths, and credential-bearing URLs never cross the mobile boundary.

## Capabilities and unavailable UI

The host advertises capabilities such as chat, files, previews, terminal, and orchestration.
Clients hide or clearly disable surfaces they cannot perform. Desktop-only update installers,
local engine controls, arbitrary terminals, and environment/debug controls do not become mobile
features simply because a similar Electron IPC call exists.

Protocol changes are additive within a major version. Unknown event kinds are retained in the
cursor stream and safely ignored for presentation; unknown commands are rejected. A required
capability or incompatible major version fails closed with an actionable upgrade message.

## Implemented alpha surface

The current host/client path includes:

- in-app QR pairing with a manual copy/paste fallback and no browser or deep-link handoff;
  encrypted device credentials, reconnect, and desktop revocation;
- host, project, model, conversation, selected-thread, and active-turn bootstrap state;
- host-issued conversation creation plus model, rename, pin, and delete operations with revisions;
- remote turn start, live text and liveness, chronological tool activity, allow-once/decline,
  cancellation, and steering/follow-up commands;
- idempotent command receipts and bounded event replay with snapshot recovery;
- crash-recoverable host command dispatch with atomic conversation-effect reconciliation and
  durable terminal outcomes;
- desktop and remote conversation synchronization through the main-process authoritative store;
- an opt-in keep-awake policy while the listener remains available behind the system tray.

Not yet implemented are the public relay/account discovery layer, durable background Android
notifications after the OS kills the client process, a durable mobile cursor/transcript/command
outbox, attachment/asset transfer, and direct mobile terminal or orchestrator control. In
particular, Android still keeps outbound envelopes only in process memory; host-side recovery does
not make a command durable until the host has received and accepted it. The host advertises only
`chat` and `approvals` until those surfaces have end-to-end implementations.
