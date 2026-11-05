# Development and validation

## Optional legacy integrations

Antimatter's built-in coding tools ship with the application. On first launch it can
also discover separately installed legacy MCP servers under `~/.beholder/mcp`.
That directory is optional; no legacy server source checkout is needed to build
or run the app. Audio/image production agents require compatible external
media tools and do not include a speech or image generation service.

Legacy server IDs, environment variable names, provider IDs and exact old profile
text remain in the compatibility layer. They preserve permission checks and saved
profile migrations; they do not configure a private hostname or supply a private
server. Configure providers explicitly before selecting a distributed starter.

## Build and verification

```bash
npm run build     # typecheck, bundle, package
npm run package
npm run release:linux  # verified Linux x86_64 release assets under releases/dist
npm run release:publish # publish the exact assembled asset allowlist after tagging
```

The optional Linux native-composer smoke test requires `Xvfb`, `xdotool`, and a cached stock
English dictionary: `node scripts/smoke-composer-spelling.mjs --dictionary /path/to/en-US-10-1.bdic`.
It starts its own private virtual display and temporary profile, blocks network access, and checks
real spelling corrections, draft preservation, undo/redo, submission, and steering. It does not
open your desktop application or read your conversations or personal dictionary.

`npm run test:hag-ui` checks two real composer submissions through the production App,
Electron preload and conversation store using captured HAG reply text. It runs headlessly
with hardware acceleration disabled, renderer network requests blocked and a private temporary profile.
It verifies reply rendering, IPC chunk/completion handling, persisted raw history and the
second outgoing request. It does not start inference; the default mode supplies IPC
events directly, while the optional provider mode below also exercises SSE parsing.
The printed temporary directory contains the report and source hashes.
Add `-- --reload-between-turns` to reload the renderer after the first completed
reply and verify disk hydration, restored completion metadata and exact message
IDs/content in the second submission. This keeps the fixture host running; it
does not test a full application restart.
Alternatively, add `-- --restart-between-turns` to exit the fixture application
after the first completed disk checkpoint and launch a new Electron process with
the same private profile. It checks restored history and completion metadata,
then verifies the second submission. The two modes are mutually exclusive. This
tests a complete fixture process restart; production main-process services and
graceful shutdown hooks remain outside the synthetic host.
Add `-- --provider-sse` to route composer requests through production request
preparation, the tool loop, OpenAI-compatible provider and transcript persistence.
This mode replaces fetch in the isolated fixture host with controlled, fragmented
SSE replies and checks the exact HAG request body and 128-token output budget.
It combines with either lifecycle flag, for example:
`npm run test:hag-ui -- --provider-sse --restart-between-turns`.
It still uses no inference server and does not boot the production main entry point.
Combine `--provider-sse` with `--interrupt-first=cancel` or `--interrupt-first=error`
to stop the first partial reply through the real composer button or a provider SSE
error, then complete a second turn. Add `--restart-between-turns` to verify recovery
from both saved conversation and host transcript. These cases check the partial
text, stop/error notice, completion state and exact follow-up history. The fixture
adapter mirrors main's cancellation/error boundary; it does not boot `streamChat`.

For the separate live client, use
`npm run test:hag-ui -- --live-base-url=http://127.0.0.1:PORT/v1 --prepare-live`.
This builds an isolated client and writes `prepared-live.json` with the launch
command, source/dependency-input hashes and bundle hashes, without contacting the
endpoint. An external qualification supervisor must verify these inputs and
provide server containment, prompt admission, CPU/native parity, healthy resets,
crash monitoring and process retirement. The client does not start a server or
establish an SSH tunnel. Its `antimatter-ui-history-c2048` evidence is separate
from the historical nonstreaming generated-history profile.

Omitting `--prepare-live` builds and runs against the explicitly selected loopback
endpoint. It sends at most two requests through the real UI/provider pipeline,
with C2048/M128, `stream:true` and omitted temperature. Each request, including
its body, has a 240-second deadline; the desktop process has one 355-second
deadline across both turns. Retries, redirects and other routes are rejected.
The first actual reply must match the retained oracle before turn two can start;
its raw text becomes second-turn history. Both JSON and SSE responses are
recorded with usage, finish reason, raw transport, callback counts and durable
renderer checkpoints. The renderer remains offline with GPU acceleration
disabled. Live mode cannot combine with replay or lifecycle flags. A passing
client report alone does **not** qualify the external backend or identify it as
HAG; it explicitly reports `backendQualified:false`.

The separate opt-in Stop/reuse profile is prepared with
`npm run test:hag-ui -- --live-base-url=http://127.0.0.1:PORT/v1 --live-stop-reuse --prepare-live`.
Its `antimatter-ui-stop-reuse-c2048` fixture first asks for a count with M64,
waits for actual numeric answer text in the renderer, and clicks **Stop generating**.
The real provider must observe the request's abort signal and close its unfinished
SSE body before the fixture accepts cancellation. It records the partial transcript,
Stop notice, transport bytes and ordered timestamps. Natural completion, timeout,
a terminal SSE frame, and an unaccepted or repeated Stop do not qualify.

The fixture then clicks **New chat** and verifies an empty, different conversation
before sending a fresh `ready` prompt with M16 to the same endpoint. The fresh
request has no cancelled history, must not resume the old transcript, and must
match the retained ready reply and usage. Both requests retain C2048, omitted
temperature, the 240-second request bound, and one 355-second process bound.
There is no successful first-response oracle and no claim about resuming a
cancelled conversation. The external supervisor must independently prove backend
cancellation, reset and warm reuse; the client report still has
`backendQualified:false`. Existing history and replay modes are unchanged.

The production catalog regression is available with
`npm run test:hag-production -- --full-catalog --output /absolute/fresh/directory`.
It uses the actual composer, preload and tool assembly with 39 current tools,
accepts a synthetic C16384 request and refuses C8192 before HTTP. The fixture
captures exact transmitted bytes, keeps saved settings unchanged and executes no
tools or models. Run it inside external resource/descendant limits; Electron has
a 90-second deadline. See [full-catalog evidence](beholdd-execution-limits.md#full-production-catalog-and-exact-wire-inspection--october-18).
