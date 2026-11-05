---
# Symphony workflow for Antimatter (spec: exec/directives/symphony).
#
# This file is the policy layer: the front matter is runtime config, and the Markdown body
# below it is the per-issue prompt template. Both version with the code they drive, which is
# the point of keeping the workflow in-repo.

tracker:
  # "snitch" reads work from the Snitch plugin: an item you press Fix on becomes a candidate
  # issue, is fixed in that project's repository, then goes through a QA pass that votes on the
  # result. Two other kinds are built in — "file" reads a JSON array of issues (endpoint is the
  # path to it, e.g. symphony/issues.json) and "linear" is waiting on an API token.
  kind: snitch
  # Snitch's two stages. Fixing writes the change, QA checks it; an item leaves the loop when it
  # reaches one of the terminal states, which is also what stops the orchestrator retrying it.
  active_states: [Fixing, QA]
  terminal_states: [Verified, Failed, Closed, Cancelled, Canceled, Duplicate, Done]

polling:
  # The snitch tracker reads local files, so polling is nearly free and a stage change should not
  # sit for half a minute before the next stage starts.
  interval_ms: 5000

workspace:
  root: ~/.antimatter/symphony-workspaces

hooks:
  # after_create runs once, when a workspace directory is first made. Its failure aborts
  # creation, so put anything the agent cannot work without here.
  # after_create: |
  #   git clone git@github.com:exec-software/exec-antimatter.git .
  # before_run: |
  #   npm install
  timeout_ms: 60000

agent:
  # Deliberately 1. Each Antimatter run now owns isolated MCP processes, but Snitch stages work
  # directly in a project's live checkout. Two issues for the same project could still edit that
  # checkout concurrently, so the scheduler rejects a higher limit for this tracker.
  max_concurrent_agents: 1
  max_turns: 20
  max_retry_backoff_ms: 300000

codex:
  # The spec names this block `codex` because its reference runtime shells out to the Codex
  # app-server. Antimatter is itself the coding agent, so these are the timeouts of our own
  # turn loop and the same WORKFLOW.md works against either implementation.
  #
  # Unpinned on purpose: the runner follows the chat.
  #
  # Leaving provider/model out now means "whatever source and model the person is actually
  # working with", which is what an orchestrator dispatching subagents should inherit — swap
  # the stack and the orchestrator swaps with it, with no edit here. Before, unpinned meant
  # `sources[0]`, an accident of list order: reconnecting a source once moved it to the end and
  # quietly changed the default model, and the first entry can be a source whose server is down.
  #
  # Pin both for a deterministic unattended run — a pin is a hard constraint and the chat cannot
  # override it. Use the source *id*, not the display name, which is editable from Settings:
  #     provider: local-deepseek-v4-flash
  #     model: DeepSeek-V4-Flash-0731-UD-Q2_K_XL
  #
  # The bundled beholdd executes on the CPU only — 0.85 tok/s against 50 tok/s for a Vulkan
  # build of the same checkpoint — so never point this at it for unattended work.
  # Orchestrated runs have no person sitting at an approval dialog. Refusing command execution
  # here makes an unattended coding agent incapable of building or testing its own change.
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
specific than the rest of this file — a QA pass in particular is asked to judge a fix rather
than to write one, and has a verdict line it must end with.

You are running inside a workspace dedicated to this issue. Everything you do happens there —
read the code before changing it, and prefer the smallest change that actually fixes the
problem over a rewrite.

1. Look at what is already in the workspace before you write anything. If there is existing
   code, match its conventions — comment density, naming and idiom should look like the file
   you are editing, not like a new author arrived.
2. Make the change. Write whole files with write_file, or replace exact strings with edit_file.
3. Verify what you can with the tools you actually have. Read your files back and check the
   logic by eye. If the issue states an acceptance check, make the code satisfy it exactly.
   Run relevant builds and tests yourself; report their real output rather than inventing it.
4. Report honestly. If a step failed, say so and show the output. If you skipped something, say
   that too. Do not describe work you did not do.

## When to stop

Stop when the change is made and verified, or when you are blocked on something only a human
can decide. Say which of the two it is.

During a fixing stage, producing no change at all is a failure, not a completion: if you find
yourself explaining what you would write, write it instead. A QA stage is read-only unless its
stage-specific instructions explicitly say otherwise.
