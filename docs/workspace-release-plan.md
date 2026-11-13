# Workspace release checklist

This release follows the desktop project checklist. Antimatter remains public. The IDE scope is an MVP for Rust and C++, with a new visual project board implementation. No external proprietary source, assets, or internal material may be incorporated. Other requested features remain release requirements.

Status is intentionally conservative: an item is complete only after host integration and relevant verification. This file is an acceptance checklist, not a claim that unfinished features ship.

| Area | Required behavior | Status |
| --- | --- | --- |
| Chat context | Optional idle compaction; cancels for foreground work; preserves visible history and newer edits | Implemented and verified |
| Chat notes | Private per-chat WYSIWYG Markdown notes; autosave, conflict handling, close/restart flush | Implemented and verified |
| Chat header | Carbon click copies, double click exports; compact view menu and status icons | Implemented and verified |
| Memory | Review Pensieve content; custom entries; immutable shipped entries/schemas with enable controls affecting recall | Implemented and verified |
| Navigation | Agent configuration and release/sidebar controls consolidated into Settings | Implemented and verified |
| Sidebar | Editable nested project groups, collapsible sections, private imports, ordering across sections | Implemented and verified |
| Desktop | Modal About with README support link; native/custom frame, window actions and always-on-top | Implemented and verified |
| Controls | Configurable shortcuts, send modifier and tool rail visibility | Implemented and verified |
| Themes | Separate Appearance view; extensible themes and established editor palettes | Implemented and verified |
| Doom | Playable local game with durable saves and packaging/license verification | Implemented and verified |
| Reply pad | Saved replies; optional floating/docked UI; one-click send obeys chat controls | Implemented and verified |
| Features | Feature management UI, C API and Matrix bindings with examples and tests | Implemented and verified |
| Cluster | Node vitals and scoped management with explicit device permissions | Implemented and verified |
| IDE | Rust/C++ projects, editing/navigation, build/run, debugging, tests, visual project board | Implemented and verified |
| Security | Scanning, findings management, overview and report export | Implemented and verified |
| Comms | Discord, Slack and Teams adapters; human and agent read/send workflows | Implemented; protocol and UI tests pass; provider registrations supplied separately |
| Email | Outlook, Google and Yahoo adapters; human and agent read/send workflows | Implemented; protocol and UI tests pass; provider registrations supplied separately |
| Copy | Concise labels and useful errors throughout changed screens | Implemented and verified |
| Release | Tests, isolated UI smoke, privacy/license review, version/What's New, GPU backend packaging, public GitHub release | Build and publication gated by CI and artifact verification |

External messages and emails must not be sent as tests without explicit recipient/content authorization. The build server is deferred; publication targets GitHub. Android production signing is not configured, so an unsigned artifact must be labeled accurately. Credentials, private user state and private repository history are excluded from publication.
