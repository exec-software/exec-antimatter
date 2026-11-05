# Security

Use [private vulnerability reporting](https://github.com/exec-software/exec-antimatter/security/advisories/new)
when it is available. Otherwise, open an issue requesting a private contact channel
without posting exploit details, keys, private chats, pairing codes, or user data.
Do not attach a complete diagnostic bundle to a public issue without reviewing it.

Include the affected version, platform, safe reproduction steps, and expected and
observed behavior. Remove credentials, private paths, hostnames, conversation data,
and model inputs from examples. There is no guaranteed response-time SLA.

## Trust boundaries

- Agent prompts, tool outputs, websites, plugins and imported conversations are
  untrusted input. Permission prompts are not a substitute for an OS sandbox.
- Local tools can read or modify files and run commands under the user's account.
  Grant access only to the workspace and commands you intend to authorize.
- Keep provider credentials and device-pairing material private. Revoke compromised
  credentials/devices and review connected workspaces after suspected exposure.
- Remote workspace access should be limited to trusted devices and networks;
  do not expose a development server directly to the public internet.
- Optional model servers, native libraries and plugins have separate security and
  licensing boundaries. Only install artifacts from sources you trust.

Review [the publication checklist](docs/publication.md) before sharing source,
notebooks, diagnostic captures or release artifacts. Report a discovered secret
privately; deleting it from the latest commit does not remove it from history.
