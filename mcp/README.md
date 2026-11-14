# Antimatter tools (MCP)

Antimatter's own MCP server. It ships with the app rather than being discovered on the machine,
so the tool set is versioned with this repository and does not drift.

## Layout

| Path | What it holds |
| --- | --- |
| `server.ts` | stdio entry point: lists tools, dispatches calls |
| `workspace.ts` | workspace resolution and path confinement |
| `types.ts` | the `ToolDef` shape and output clipping |
| `tools/files.ts` | read, write, edit, list, find, search, stat |
| `tools/git.ts` | status, log, diff |
| `tools/goetic.ts` | Goetic work tracking: boards, cards, lifecycle moves |
| `goetic.ts` | the Goetic client and credential, shared with the Goetic tool window |
| `tools/security.ts` | secret and risky-code scanning |
| `tools/shell.ts` | run_command, launch_program |
| `tools/web.ts` | fetch_text, http_request |
| `tools/recovery.ts` | recovery_status, recovery_use (handled in-process by the app, not here) |

## How it runs

`vite.config.ts` builds `mcp/server.ts` to `dist-electron/mcp/server.js`. The app spawns that
file with Electron's own binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), so no system Node is
required and the same path works in a packaged build.

## Safety properties

- **Every filesystem path is confined to the workspace.** `insideWorkspace()` resolves the path
  and refuses anything that escapes the root, so `../../.ssh/id_rsa` fails.
- **Secrets are redacted in scan output.** `scan_secrets` reports the shape, position, and length
  of a match, never the value.
- **Git is invoked with an argument array**, never a shell string.
- **`http_request` and `fetch_text` allow only http(s)**, so a fetch cannot become a local read.
- **Output is clipped** so one tool call cannot swamp the model's context.
- **The Goetic token only goes to loopback over plain HTTP.** Goetic's preview has no TLS, so a
  plain-HTTP request to any other host is refused instead of putting a long-lived credential on
  the wire; https is allowed for a deployment behind TLS termination. The token is never returned
  to the renderer and never appears in a tool's output.
- **Goetic owns its own authorization.** These tools hold one scoped agent credential and cannot
  mint, rotate or widen it; what they may touch is Goetic's per-board decision, which no
  Antimatter permission mode changes.

`run_command` is deliberately unrestricted, and is classified as `danger` in
`src/main/toolPolicy.ts`: it requires explicit approval under "Ask first" and is refused
outright under "Read only". `launch_program` is classified the same way. It starts a program in
its own session with output going to a log file under the system temp directory, watches it for
a few seconds, and leaves it running after the call returns: that is how a turn checks that a
desktop application it built actually starts.

## Adding a tool

Add a `ToolDef` to the relevant module in `tools/`. It is picked up by `tools/index.ts`
automatically. Then classify it in `src/main/toolPolicy.ts` — anything not listed as read-only
or dangerous is treated as making changes, which is the safe default.
