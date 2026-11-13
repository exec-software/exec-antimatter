# Antimatter for Android

The Android client is a native Jetpack Compose application inside the Antimatter repository. It
uses the same flat Clay roles as the desktop renderer and treats a paired desktop host as the
authority for inference, tools, files, credentials, orchestration, and active turns.
Public Android release: **v1**.

Current release: **v23** (compatibility package 23.0.0).

The current Android package version is `23.0.0`, synchronized with the desktop compatibility identity;
the monotonically increasing versionCode remains separate from the public Android label. The drawer
shows Android v1, and Settings includes the package build for support. The mobile public label does
not reset the package identity or Android's upgrade counter.

Production APKs accompany the desktop build on the project's release page or a trusted
distributor's release feed. Copy `Antimatter-Android-v1-<package-version>.apk` and the accompanying
`SHA256SUMS`/`android-release.json` from the published artifacts folder, verify the APK's SHA-256,
then open the APK on the Android device to install it. Android may ask you to allow installation
from the application used to open the file. The provenance records the production signer and
the desktop source commit; unsigned or debug APKs are not production releases.

An existing production installation upgrades with the same signing key and a higher versionCode.
A debug-signed test installation has a different signer and cannot upgrade in place to this
production APK. Preserve its data and pairing until a deliberate migration is arranged.

The Android companion provides the mobile application shell and its remote-host path:

- conversation drawer with Pinned, Projects, and Recent sections;
- chronological transcript with tool activity anchored beside the assistant text that caused it;
- explicit allow-once/decline controls for approval-gated tool activity;
- one unified composer with access and model controls;
- local suggested follow-ups that insert editable text only, never send automatically or replace
  an existing draft; suggestions make no additional inference requests;
- unsent text drafts encrypted with a separate Android Keystore key, scoped to host and thread,
  restored for paired hosts after process death, and removed after accepted sends or local forgetting;
- the shared card-based Model Library interaction;
- remote-workspace and settings surfaces with real desktop projects, project chat creation,
  saved computers, visible connection errors, retry, and local forgetting;
- a dedicated preview surface for opaque host assets and sandboxed public HTTPS pages;
- in-app QR pairing with a manual paste fallback, no browser/deep-link handoff, pinned HTTPS,
  Android Keystore credential storage, reconnect, and
  cursor-based event replay;
- remote host/project/model/conversation bootstrap plus host-issued create, select, model-change,
  rename, pin, and confirmed delete operations, with revision checks and authoritative updates;
- live remote turns with text, liveness, tools, approvals, stop, and steering/follow-up;
- reported prefill progress, cached tokens, and newly processed tokens, retained across reconnects;
- serialized snapshot recovery after event gaps, retryable network failures, and foreground
  return; cancelling a connection closes its socket and reconnecting never resends a chat command;
- disconnected onboarding in both debug and release builds. Preview data is an explicit test/UI
  fixture, never an automatically selected temporary workspace in the installed app.

It does **not** expose Electron IPC, host filesystem paths, provider credentials, or direct model
endpoints to the phone. The current transport connects to one explicitly enabled LAN or VPN
interface; it does not yet have an account-backed Internet relay or wake-on-demand service.
Attachment/preview asset transfer, direct terminal/orchestrator control, and durable notifications
after Android kills the application process also remain disabled. The host advertises only the
capabilities that are complete. The cross-platform boundary and reconnect rules are documented in
[`docs/remote-workspaces.md`](../docs/remote-workspaces.md).

Mobile deliberately omits nonfunctional attachment/voice buttons and empty model-management tabs.
Model downloads, API keys, skills, plugins, schedules, pull requests, and subagent management remain
desktop controls. Conversation archive is not yet part of the mobile protocol. Only publicly
reachable HTTPS pages can currently load on the phone; desktop localhost pages and authenticated
host assets need a future advertised preview transport, not the phone's own localhost.

### Mobile release checks

Before publishing a signed APK, verify on a physical device: fresh QR pairing; reconnection after
Wi-Fi loss; host revocation and re-pairing; selecting each real project; a streamed turn and approval;
rename/pin/delete synchronization; a suggested follow-up remaining a draft; and draft recovery after
closing the process. Keystore-backed encryption is device-tested separately from JVM cipher and
lifecycle tests. Notifications while the app is closed are not supported yet. The build gate does
not replace these network, camera, lifecycle, and signing checks.

For turn synchronization, exercise both directions in the same conversation: finish a desktop
turn, send a phone follow-up, steer and stop it from desktop, then send another desktop turn and
steer/stop it from the phone. Reopen each client during an active turn and after a completion it
missed. Verify that the running indicator clears, response text appears once, rejected sends keep
their draft, and reconnecting does not create another inference request. A successful reconnect
must not be replaced by an error from an earlier connection attempt.

`node scripts/smoke-hag-conversation.mjs --remote-turns` exercises desktop phone-turn mirroring,
distinct control/response identities, steering, cancellation, reload, and duplicate-text protection
through the actual App and preload with an isolated host-store fixture and no model execution.

## Connect to your computer

1. Keep Antimatter running on the computer and put the phone on the same LAN or reachable VPN.
2. In desktop Settings → Connections, enable remote access on that network interface and choose
   **Add device** to display a fresh, short-lived QR code.
3. On Android, open **Remote workspaces → Pair a computer** and scan the code. Manual paste is
   available if the camera cannot scan it.
4. Choose a project under the paired computer, then open its chats or start a new one. The desktop
   shares its current workspace and available directories associated with its existing tasks.

Temporary transport failures retry with backoff. Returning to the app reloads the selected chat
from the paired host and resumes event polling without resubmitting an accepted turn. A replay gap
or catalog invalidation pauses event application until an authoritative snapshot is available;
newer snapshots accepted during reconnect remain the starting point for the resumed stream.
Cancelling an old connection closes its socket promptly. Certificate verification remains strict,
while a dropped TLS handshake is retried as a network failure rather than requesting new pairing.

Saved computers stay visible when offline. **Retry connection** reuses the encrypted credential;
**Pair again** requests a fresh desktop QR when the credential is revoked or its certificate has
changed. If pairing succeeds but loading projects fails, retry the connection rather than reusing
the now-consumed code. **Forget computer** removes local connection data and tries to revoke the
device remotely; when the computer is unreachable, revoke the device in desktop Settings too.

## Build

Requirements:

- JDK 17 or newer
- Android SDK Platform 36.1
- Android SDK Build Tools 36.1.0

The Gradle wrapper downloads Gradle 9.6.0 and verifies the distribution checksum. From the
repository root, set `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) and make the JDK available through
`JAVA_HOME` or `PATH`, then run the complete Android gate:

```bash
ANDROID_HOME=/path/to/Android/Sdk \
JAVA_HOME=/path/to/jdk \
npm run android:verify
```

The gate runs unit tests, lints both variants, and assembles debug plus minified release APKs. The
debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`; the release output is
intentionally unsigned until the protected distribution environment supplies its signing key, so
it is a build-verification artifact rather than an installable release. The repository does not
track `local.properties`, signing properties or keys, APKs, Gradle caches, or IDE state.

Dependency versions are locked in `app/gradle.lockfile`, and resolved artifact checksums are kept
in `gradle/verification-metadata.xml`. When the version catalog changes, regenerate both with the
same complete task graph and review the lock/checksum diff:

```bash
cd android
./gradlew --no-daemon --write-locks --write-verification-metadata sha256 \
  :app:testDebugUnitTest :app:lintDebug :app:lintRelease :app:assembleDebug :app:assembleRelease
```

## Architecture boundary

`remote/RemoteWorkspaceContract.kt` intentionally speaks product commands rather than desktop IPC
channel names. A turn keeps four identities distinct: thread, request/run, visible response
message, and tool occurrence. Events carry an opaque host epoch plus a monotonically increasing
sequence, allowing a sleeping phone to reconnect with a cursor and resume without reconstructing
state or confusing a restarted host with the prior session.

Credentials remain host-owned. QR frames and pairing material remain transient, validated,
log-redacted inputs, and the complete device credential is encrypted with an Android Keystore-held
key before persistence.
Authenticated previews use opaque asset IDs instead of host paths; public pages are a distinct
HTTPS-only type and never receive workspace authorization. Workspace URLs require HTTPS without
embedded credentials.
