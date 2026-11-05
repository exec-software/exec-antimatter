---
# Portable workflow shipped with Antimatter. It deliberately does not pin a provider:
# a fresh install uses the first configured inference source, including bundled Beholdd.
tracker:
  kind: snitch
  active_states: [Fixing, QA]
  terminal_states: [Verified, Failed, Closed, Cancelled, Canceled, Duplicate, Done]

polling:
  interval_ms: 5000

workspace:
  root: ~/.antimatter/symphony-workspaces

hooks:
  timeout_ms: 60000

agent:
  max_concurrent_agents: 1
  max_turns: 20
  max_retry_backoff_ms: 300000

codex:
  # Unattended runs cannot wait at a dialog. Antimatter still filters destructive and
  # outward-facing tools through its unattended policy before allowing a call.
  approval_policy: never
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---

You are working on {{ issue.identifier }}. Everything you do happens inside the workspace
directory you were started in — for a Snitch item that is the project's own repository, for
anything else a scratch directory belonging to this issue alone.

**{{ issue.title }}**

{{ issue.description }}

Labels: {{ issue.labels }}
Current state: {{ issue.state }}
Attempt: {{ attempt }}

## How to work this issue

The description above says which stage this is and what it wants. Follow it where it is more
specific than the rest of this file. A QA pass judges the existing fix and ends with the exact
verdict requested by its stage instructions.

1. Inspect the workspace before changing it and match the project's existing conventions.
2. Make the smallest complete change that addresses the issue.
3. Run the relevant builds and tests yourself and report their real output.
4. Report failures and skipped checks honestly; do not describe work you did not do.

Stop when the change is made and verified, or when a decision truly requires a person. During a
fixing stage, producing no change is a failure. A QA stage remains read-only unless its specific
instructions explicitly say otherwise.
