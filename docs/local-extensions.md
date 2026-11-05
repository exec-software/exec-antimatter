# Local skills and plugins

Antimatter's first extension format is local and inspectable. There is no marketplace download,
remote installation, automatic script execution, or plugin hook runner.

## Skills

Put a named skill folder in either location:

- `<project>/.agents/skills/<name>/SKILL.md` for a project skill.
- `~/.antimatter/skills/<name>/SKILL.md` for a personal skill.

For example:

```text
.agents/skills/review-checklist/
  SKILL.md
  references/checklist.md
  scripts/check.sh
```

```markdown
---
name: review-checklist
description: Review project changes for correctness and missing tests.
---

Read references/checklist.md when reviewing a change. Report concrete findings.
Ask before running scripts or changing files.
```

Skill names use letters, digits, hyphens, and underscores. A model's initial context receives only
bounded names/descriptions, not all skill documents. The built-in `antimatter.skills/read_skill`
tool reads `SKILL.md` and then linked text resources progressively, inside the same skill folder.
It is a read-only capability bound to the conversation's workspace. Reading a script only returns
its text; it does not execute it. Normal tools and the conversation's access policy still govern
any later command or file change.

Open **Skills** to inspect documents/resources or choose **Use in chat**. This creates an unsent
`$name` draft. Names should be distinct across your project, personal skills, and enabled plugins
so a shorthand request is unambiguous.

## Local plugins

Choose **Plugins → Import folder**. The folder must contain either
`.codex-plugin/plugin.json` or a portable root-level `plugin.json`:

```json
{
  "name": "project-helpers",
  "version": "1.0.0",
  "description": "Local review instructions and optional project tools.",
  "skills": ["./skills"],
  "mcpServers": "./.mcp.json"
}
```

`skills` can be one relative path or an array. Each path can point to a skill containing
`SKILL.md`, or a directory whose direct child folders are skills. When omitted, an existing
`skills/` directory is discovered. The optional `mcpServers` declaration selects a relative JSON
file; otherwise `.mcp.json` is used if present. A skills-only plugin does not need an MCP file.

```json
{
  "mcpServers": {
    "project-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["${PLUGIN_ROOT}/server.js"],
      "env": { "SERVICE_TOKEN": "replace-with-your-local-token" }
    }
  }
}
```

`${PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` expand to the canonical imported folder in commands,
arguments, and environment values. Other environment substitutions are not performed. Use these
placeholders for file arguments: plugin processes are not promised a plugin-folder working
directory. Commands are executed with argument arrays, not a shell. If you explicitly configure
a shell as the command, it is still arbitrary code that you must trust.

Importing registers a plugin **disabled** and starts nothing. **Review & enable** displays exact
commands/arguments, environment variable names (never values), and the permissions involved.
Confirming enables the skills and starts declared stdio servers. These processes run as your OS
account with file/network access; they are **not sandboxed**. Tool approval gates model calls,
not what a process can do at startup. Only enable local code you trust. Keep sensitive config
files out of source control; Antimatter's registry stores the folder and approval fingerprint,
not copied environment values.

Changing/removing the manifest or MCP configuration invalidates approval and disables the
plugin. Refresh, review the new declarations, and enable it again. Derived plugin MCP servers
are not saved as standalone server entries; disabled or changed plugins cannot remain active
through a stale saved server config. Disabling stops them. Connection failures remain visible;
use the Tools view for connection status/retry.

The declaration fingerprint is not a code signature: review plugin source changes as well.
Hooks, plugin command/agent presets, HTTP MCP servers, remote marketplaces, and download/update
workflows are not implemented in this version. They are not silently executed.

## Bounds and file safety

- Up to 64 registered plugins; 32 skill paths and 16 stdio servers per plugin.
- Up to 128 catalog skills, and 128 immediate entries scanned per skills directory.
- Skill/manifest/config text reads are limited to 256 KiB; binary resources are rejected.
- Resource lists contain at most 256 files, scan at most 1,024 entries, and recurse at most eight
  levels. Truncation is disclosed.
- Model prompt metadata is limited to 16,000 characters.
- Resource paths must remain within the canonical skill/plugin folder. Absolute paths,
  traversal, symlinks, and directory replacement are refused.

If a registry cannot be read, plugins fail closed and the registry is not silently overwritten.
No network request or executable runs as part of discovery, import, or skill reading.
