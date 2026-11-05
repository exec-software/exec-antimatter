# Model testing and chat imports

## Copyable project prompts

Open **Developer → Model test prompts**. Eight complete prompts are grouped into foldable
sections, from small command-line tools to integrated applications:

- Tiny tasks CLI and folder audit report.
- Offline recipe notebook and Kanban board.
- Inventory API and Markdown search index.
- Local issue tracker and CSV exploration studio.

Each prompt includes project requirements, workspace boundaries, verification, and bounded
delegation where it helps. Choose a disposable scratch workspace and the model to test, then
copy the full prompt into a new conversation. Copying does not create a chat, run tools, or
start inference. If clipboard permission is unavailable, **Select text** provides manual copying.
Compare the actual artifacts, tests, and tool use rather than response length.

## Import Claude, Codex, or OpenCode conversations

The sidebar has foldable **Claude chats**, **Codex chats**, and **OpenCode chats** sections. The import icon beside
each heading opens a source-specific import page. Expansion state is remembered; a search
temporarily expands matching results. Imported chats can be renamed, deleted, or pinned like
other conversations. Pinned imports move to Pinned rather than duplicating the source list.

1. Choose files, or choose a folder containing the selected source's session transcripts or JSON exports.
2. Review the conversation list and import notes. No conversation is selected automatically.
3. Select conversations and a destination project, then click **Import selected**.

Supported inputs:

| Source | Input |
| --- | --- |
| Claude web/desktop | Extracted `conversations.json`, including a single conversation or a conversations array. Request the export in **Settings → Privacy → Export data**. |
| Claude Code | Local JSONL transcripts, usually under `~/.claude/projects`. Choose one project folder for a smaller batch. |
| Codex app/CLI | Local rollout JSONL transcripts from `~/.codex/sessions`, or `~/.codex/archived_sessions`. A configured `CODEX_HOME` is respected by the file picker. |
| OpenCode | Official session JSON exports, selected individually or as a folder containing exported JSON files. Live SQLite databases, internal storage directories, and share URLs are not supported. |

Claude's export process is documented in [Export your Claude data](https://support.claude.com/en/articles/9450526-export-your-claude-data).
Codex documents its persisted JSONL history and read-only thread operations in
[Codex App Server](https://learn.chatgpt.com/docs/app-server). The importer reads selected files
directly; it does not start an app server or connect to the source application or any provider.

To export an OpenCode session, run its documented CLI command yourself in your OpenCode environment,
replacing `SESSION_ID` with the session you want to copy:

```sh
opencode export SESSION_ID > session.json
```

Then select `session.json` under **OpenCode chats**, or put several exports in a separate folder
and choose that folder. The current [OpenCode export documentation](https://opencode.ai/docs/cli/#export)
also describes interactive session selection when the ID is omitted and an optional `--sanitize`
flag. Check your installed CLI's help if its command layout differs. Antimatter consumes the
exported JSON; it does not run OpenCode, query its database, automatically discover its internal
storage, or fetch shared-session URLs. Internal storage files are not session exports; choose a
separate export folder. Redacted or omitted source content cannot be recovered by importing it.

ZIP archives must be extracted first. Codex `history.jsonl` is prompt history, not a complete
conversation. Cloud-only chats, ChatGPT account exports, and encrypted reasoning are not
supported by this importer. Local transcript formats can change; unknown records produce
notes, and malformed or ambiguous inputs are refused rather than presented as complete history.

### Preservation and limits

- Import creates new Antimatter IDs and appends copies atomically. It does not write to source
  files, replace existing chats, change the active conversation, or discard drafts and pins.
- The source conversation ID identifies duplicates. Re-importing skips the existing copy; it
  is not a live sync and does not merge later source messages.
- Supported text and tool calls/results retain their transcript positions. Missing results are
  marked as incomplete historical records. Commands never replay, and imported tool records
  cannot request approval, open previews, or reconnect to live subagents.
- Source system/developer prompts and hidden reasoning are not imported as instructions.
  Provider configuration, working directories, and access permissions are not inherited.
  Imported conversations start with Ask access and no workspace selected.
- Attachments and unsupported media are placeholders. Embedded Markdown images in an imported
  conversation are not loaded automatically. Import does not fetch URLs or attachment paths.
- Source branches are resolved from available parent links, with notes about excluded branches.
  Codex rollback logs that cannot be reconstructed safely are refused.
- Imports are local, but the text itself may contain private data. Continuing a conversation
  sends its history to the model/provider you choose; review it first.
- Limits: 32 MiB per file, 64 MiB per batch, 200 selected session files, and up to 1,000 preview
  candidates. Preview batches expire after 15 minutes. The existing store holds 200 conversations;
  imports that would exceed that limit are refused without deleting older chats.

## Verification

`npm test` covers parser variants, bounds, duplicate detection, inert tool history, persistence,
failure atomicity, and sidebar behavior. `npm run bundle` builds the production renderer and
preloads. With a built renderer assets directory, run:

```sh
node scripts/smoke-chat-import-renderer.mjs /path/to/dist-electron/renderer/assets
```

This uses synthetic chats and mocked picker/clipboard/IPC in an isolated Electron profile. It
does not open real conversation files, start inference, or launch Antimatter's main process.
