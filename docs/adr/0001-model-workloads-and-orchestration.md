# ADR 0001 — Models own named workloads; orchestration profiles compose them

> Publication note: host labels and local storage paths are anonymized. Raw workstation
> captures are not distributed with this note; historical measurements retain their original
> scope and are not a fresh qualification of another machine.


- **Status:** accepted; stages 1–5 implemented. Stage 5 is read-only by design: capacity and
  inventory are published and authenticated; weight transfer and engine control are not — see
  **Stage 5: what was built** below
- **Date:** 2026-10-09
- **Design detail:** [model-workloads-and-orchestration.md](../model-workloads-and-orchestration.md)
- **Supersedes:** nothing. First ADR in this repository; `docs/adr/` is established by it.

This record exists so the work can be resumed by someone — or some session — that was not present
for the conversation. **Progress and resumption state** below is the part to read first and the
part to keep current.

## Context

The word *profile* names two unrelated things, on one IPC prefix:

- `profiles:get` / `profiles:set` / `profiles:storeInfo` → per-model settings in
  `src/main/modelProfiles.ts`, stored as `overrides[providerId:modelId]`: exactly one anonymous
  override per model.
- `profiles:list` / `profiles:select` / `profiles:rename` / `profiles:setMode` → global
  orchestration profiles in `src/main/agents/profiles.ts`, YAML files binding
  `roles{role → {provider, model}}`.

The Model Library renders model cards with an **Agent routing** section directly beneath. Its own
text says those profiles "are global and do not replace the chat model selected above" — accurate,
and still read as *these belong to the model above*. It was read that way by the project's own
author, which is the strongest available evidence that the information architecture is wrong
rather than under-documented.

Confirming evidence: on `validation-host-a` the orchestration profiles were hand-renamed to `Default`
and `Orchestrated`. Those names describe **how the coder is served** — one wide window versus six
narrow ones — not which model takes which agent role. The thing the names wanted to be is a
per-model workload, and there is nowhere to put one.

A third force: the difference between those two names is not prompt settings at all. It is
`--ctx-size` and `--parallel` in a systemd unit, switched by a `coder-mode` script that exists
only because the served window and the window recorded in `sources.json` must agree and nothing
enforces it.

## What a workload is, in the author's words

Worth recording verbatim in substance, because it is the clearest statement of the intent and it
settled two open questions at once.

A workload is a **modular unit that can be assigned**. Names are the author's labels and carry no
mechanism: `Default` was simply what one of them was called, and a DeepSeek workload tailored to
image generation sits beside it as a peer. Taking a hypothetical Omni that could code, see and
hear equally well, that one model would own `image`, `audio`, `coding 32k` and `coding 64k`.

Two things follow:

1. **Each is launchable on its own.** "If all I want is a single Omni running 32k, run that." So a
   workload is selected, not configured-and-left — which answers Q6.
2. **The new section composes several.** An orchestration profile is for the *more than one* case:
   `coding 32k` from Omni in one slot, an audio workload from another model in another. Loading
   the profile loads them all.

And on subagents: *"I think that's more server based, so maybe that goes to settings."* That
answers Q1 — a workload does not carry serving configuration. Slot count belongs with the
inference servers in Settings, because it is a property of the process, not of a way of using it.

Note that `coding 32k` and `coding 64k` need no server change: a server serves a maximum and a
workload chooses how much of it to use. Both are valid against one server holding 262,144.

## Decision

Adopt three levels, each answering one question.

1. **Model** — *what inference is available.* A source plus a served model id. Owns endpoint,
   protocol, engine, architecture, quantization, and the window the server reports. Substantially
   unchanged.
2. **Workload** — *how that model is used.* What `ModelProfile` becomes: 1..many per model, each
   with `id`, `name`, `description`, one marked default. Launching one sets the chat model and
   applies its settings in a single action.
3. **Orchestration profile** — *who runs what.* Keeps its role table, but slots bind a
   **workload** rather than a bare `(provider, model)` pair, surfaces its `description`, and has
   explicit load semantics: loaded profile applies its bindings, no profile means a straight run
   on the chat model.

Further decisions:

- **Split the IPC namespace** into `model-workloads:*` and `orchestration:*`. The shared prefix is
  the original cause; leaving it invites the confusion back.
- **One Models page.** Orchestration leaves the sidebar; the Agent routing section is replaced by
  a workload view bound to the selected model, with orchestration profiles as their own section
  one level up.
- **Distribution becomes a workload property**, not a source-level fact, so one checkpoint can be
  local in one workload and striped in another — which `local-deepseek-v4-flash` and
  `stripe-deepseek` express today only by being two unrelated entries.
- **YAML remains the format of record** for orchestration profiles. They are deliberately
  hand-editable and version with the project; a UI that could only round-trip its own writes
  would be a regression.
- **Nothing breaks on first launch.** Migration is specified below and is mandatory, not optional.

## Consequences

Accepted costs:

- A store migration and an IPC rename, touching `modelProfiles.ts`, `agents/profiles.ts`,
  `index.ts`, the preload surface, renderer types, `ModelLibrary.tsx`, `ModelProfiles.tsx`, and
  the settings navigation.
- `ThinkingControl` and `ModelProfiles` both call `profiles.get/set` and must move to the new
  namespace. The thinking level becomes a workload field rather than a per-model one, so a model
  can be high-effort in one workload and off in another — an improvement, but it changes where
  the value lives.
- Stage 4 ships a UI with nothing behind it until stage 5. It must therefore read a static list of
  configured boxes before it polls anything, and must not imply liveness it cannot observe.

Stage 5 shipped the read half of the node agent: protocol, inter-box authentication, pinned TLS,
and a liveness model that cannot wedge the UI when a box is down. Verified weight transfer and
engine control stayed out, because they need a write scope rather than more code — see
**Stage 5: what was built**.

## Progress and resumption state

Keep this current. A stage is `done` only when typecheck and `node scripts/test.mjs` are green.

| stage | content | depends on | status |
| --- | --- | --- | --- |
| 0 | This ADR and the design doc | — | **done** |
| 1 | Workload store: 1..many named per model, one default; IPC split; migration | — | **done** |
| 1b | Workload selection: `workloadId` in the chat choice, resolution honours it | 1 | **done** |
| 2 | Models page: model list + workload view; Agent routing section removed | 1 | **done** |
| 3 | Orchestration v2: slots bind workloads, description surfaced, explicit load | 1, 2 | **done** |
| 4 | Distribution as a workload property, with a node list | 1, 3 | **done** |
| 5 | Node agent: liveness, capacity, inventory, inter-box trust | 4 | **done** — read-only; transfer and engine control are a separate decision |

## Where this was left — 2026-10-09

All five stages are implemented, pushed to `master`, and unverified on hardware. Typecheck clean,
`node scripts/test.mjs` 1395 pass / 0 fail / 5 pre-existing skips, renderer builds.

**The next session starts with testing, not code.** Nothing is half-written and nothing is waiting
on a decision; what has not happened is a person using any of it.

What has been exercised and what has not:

- Stages 1–4 have unit coverage and have never been driven through the UI by hand.
- **The v1 → v2 store migration has not run yet on this machine**, and that is the single most
  valuable thing to test first. `~/.antimatter/model-profiles.json` is still `version: 1` with two
  real overrides — `npu-gpt-oss-20b::gpt-oss-20b-FLM` and
  `local-gpt-oss-20b-vulkan::gpt-oss-20b-vulkan`. Migration is lazy, on the first `adopt()` that
  writes, so merely launching the app has not triggered it. It runs once, so the v1 file is
  already copied aside as `~/.antimatter/model-profiles.v1-before-adr0001.json` — nothing reads
  that name, and restoring it makes the migration testable again. What to check afterwards is the
  migration contract below: each override becomes that model's single workload named `Default`,
  marked default, settings byte-identical.
- Stage 5's pairing and report path is covered end to end over real TLS on loopback, including a
  wrong-pin rejection. It has **never run between two machines.** The interface list excludes
  loopback on purpose, so a live pairing needs Antimatter running on the second box with the agent
  turned on there. Until that happens, the remote half is tested code and untested deployment.

Known-good machine state at the handoff: `llama-coder` on 8086 serving 2 × 262,144 (`maxctx2`,
q8_0 KV), `llama-omni` on 8081 serving 2 × 16,384, Antimatter running from source under Vite with
the node agent wired in and **off**. `~/.config/antimatter/node-agent/` exists, mode 0700, empty —
which is what an agent nobody has enabled should leave behind.

One thing the author said they would do and had not yet: rename the orchestration profiles
(`Default` and `Orchestrated`) now that the hierarchy exists to rename them into — under it they
want to be coder *workloads* on the Qwen3-Coder model, with the orchestration profile named for
the workflow it describes.

## Update — 2026-10-09, later the same day

Two things happened that this section was waiting for, both on hardware.

**The v1 → v2 store migration has now run on this machine, on the real store, and satisfies the
contract.** Both pre-existing overrides — `npu-gpt-oss-20b::gpt-oss-20b-FLM` and
`local-gpt-oss-20b-vulkan::gpt-oss-20b-vulkan` — became that model's single workload, named
`Default`, marked default, with settings byte-identical. `~/.antimatter/model-profiles.json` is
`version: 2`. It was triggered the way the design intends, by a write (`createWorkload`) rather
than by a migration command, and the pre-migration file is preserved twice over:
`model-profiles.v1-before-adr0001.json` and a timestamped `.bak-`. So the single most valuable
untested thing in this ADR is now tested, and it passed.

**The `Default` / `Orchestrated` rename happened by being superseded rather than renamed.** The
shape the author wanted — workloads on the coder, profiles named for the workflow — now exists for
real, on a new model:

- `Qwen/Qwen3-Coder-Next-GGUF` 80B-A3B Q4_K_M is in the prepared download catalog, pinned and
  SHA-256 verified, and served by `llama-coder-next.service` on port 8087.
- Two **model workloads** on it: `full-window` (262,144) and `fan-out` (65,536).
- Two **orchestration profiles**, `coder-next-straight` and `coder-next-pool`, whose role tables
  are identical and which differ *only* in the workload their coder slots bind. A test asserts
  that, because the moment they differ elsewhere they have stopped being a pair.
- `~/.local/bin/coder-next-mode` switches the serving mode and the recorded window together,
  the same job `coder-mode` does for the 30B.

This is the first use of stage 3's `workload` field by anything other than a test, and it is the
case the ADR was written for: one checkpoint, two ways of using it, named.

`single-box` and `single-box-maxctx` are deliberately left in place. They are the 30B
arrangement, they still work, and `llama-coder-next.service` declares `Conflicts=` on
`llama-coder.service` so the two can never fight over the carveout.

What this does **not** resolve: **Q2** is now more clearly worth doing, not less. The `fan-out`
workload asks for 65,536 and the server in `straight` mode serves 262,144 in one slot — fine. But
`full-window` against `pool` mode asks for 262,144 from a server serving 65,536 per slot, and
`withEngineContext` will clamp that silently. The pairing is currently documented in a comment and
enforced by nothing, which is exactly the drift `coder-mode` was built to prevent. **The honest
summary is that this work made Q2's absence easier to hit, not harder.**

The measurements behind the two profiles are in
[../model-provenance/qwen3-coder-next.md](../model-provenance/qwen3-coder-next.md): 12 of 48
blocks hold a KV cache at 24 KiB/token, six slots deliver 93.8 tok/s against 57.8 for one, a
130,007-token needle was retrieved correctly, and q8_0 KV does work through the hybrid allocator.

If testing turns something up, it goes in the stage table above as a regression against the stage
that owns it, not in this section. This section is only the state of play.

**Next action:** nothing is blocking. Two things remain deliberately out of scope and are
recorded under **Stage 5: what was built** below — telling another box to fetch weights, and
starting an engine on one. Both need a *write* scope on the node protocol, which is a separate
decision from publishing capacity and is not a thing to grant by inference.

The open follow-ups, in the order they would be picked up:

1. **The `workload` naming collision** (section below). It is the same mistake as `profiles:` and
   the longer both names persist the more likely someone reads one for the other.
2. **Q2 — warn when a workload wants more window than its server serves.** `withEngineContext`
   clamps silently today, and the Distribution section is now the natural place to say so, since
   it already reports what a box actually has.
3. **A write scope, if it is wanted.** See the two rows below for what each buys and costs.

**What stage 4 landed:**

- `src/api/nodes.ts`, `src/main/nodes.ts` — the roster, read from the peers that **recipes
  already declare** rather than from a new store. Recipes exist because a model that does not fit
  one machine is the same request with a precondition; they carry host, port, an optional start
  command and a probe. Two recipes naming one box collapse to one node keeping both reasons.
- `nodes:list` probes every box in parallel, so a roster of four down boxes costs one timeout
  rather than four. `nodes:storeInfo` points at the recipes directory.
- `WorkloadSettings.nodes` — `host:port` keys, validated by the same rule as a preset's RPC
  target so a stored value can never become an injected runtime flag. Capped at 16, deduplicated.
- A Distribution section in the workload editor listing boxes with live status
  (`answering` / `down · startable` / `down`), and saying plainly that selection is **recorded,
  not applied**: the runtime takes RPC peers on the command line, so this reports rather than
  reconfigures.
- 5 tests: roster merging, probe-throws-is-down, empty roster, key validation, and workload node
  storage including injection and cap rejection.

Q5 is still open in substance: `mode` could now be derived from a workload's boxes, but
`profileDeployment` continues to derive a profile's category from its bindings and nothing reads
`WorkloadSettings.nodes` for that yet.

**What stage 3 landed:**

- `RoleBinding` carries `workload: string | null`. The short `role: model-id` form still means
  "whichever source serves this, on its default workload", because these files are hand-edited
  and version with the project. A malformed workload id degrades to null rather than failing the
  profile — a typo should not take a whole workflow out.
- `serialized()` writes `workload` through, and keeps the short form where it says everything.
  A test caught this: without it every profile saved from the UI silently lost its workloads.
- `agentProvider` and `resolveProvider` take a workload, so a bound slot resolves under it. An
  agent that pins its own model does **not** inherit the role's workload: that workload belongs
  to a model it is not using.
- `orchestration:save` and `orchestration:remove`. Save validates the source, the model and the
  workload all exist, because an unresolvable binding otherwise surfaces at dispatch on whichever
  agent happened to be first. It refuses to rewrite a built-in, since `save()` re-serialises and
  would drop a hand-written file's comments.
- `OrchestrationEditor.tsx` — name, description, category, and a slot table whose rows pick a
  model and then one of its workloads, with workloads fetched per model on demand.
- Loading a profile adopts its `default` slot as the chat model (Q4, all-in-one). Role chips show
  the workload. Built-in profiles get Rename but not Edit slots.

**What stage 2 landed:**

- `renderer/src/components/hub/WorkloadPanel.tsx` — a model's workloads with Launch, New, Edit,
  Make default and Remove, plus an inline editor for window, reply ceiling, tool calls, thinking,
  compaction and the standing brief. Deliberately no slot count: that is the server's, in
  Settings.
- `ModelCard` gains `inspecting`/`onInspect`; the model name is now the affordance that opens the
  panel. Inspecting is page state, separate from the chat selection, so looking at a model's
  workloads cannot change which model answers next. A selected card keeps the primary ring; an
  inspected one gets an accent edge.
- The panel renders between the model grid and the orchestration section, resolved from the live
  entry list each render so a card that vanishes takes the panel with it.
- **Agent routing** is renamed **Orchestration profiles** and re-described as one level up from
  the workloads above, which is the misreading this ADR exists to fix.
- `onUseModel` carries an optional `workloadId` through `HubPage`, `App.handleSelectModel` and
  `saveModelChoice`, so Launch is a real selection.

Step 4 of the old plan — dropping orchestration from the settings sidebar — was a no-op:
`SETTINGS_SECTIONS` never had an orchestration entry. The UI only ever lived in the Model Library.

**What stage 1b landed:** `ModelChoice` gains an optional `workloadId`, validated on read and
write so garbage degrades to the default rather than being stored. `resolve()` takes a
`workloadId` and falls back to the model's default when it names one that is gone, so deleting a
workload cannot break a conversation that used it. `profileFor` reads the live selection, and
`model:set` accepts a third argument. `hasWorkload` exists for callers that need to say a chosen
workload is missing rather than quietly differ. Two tests cover resolution by name, fallback on
deletion, cross-model isolation, and malformed-id rejection.

**What stage 1 landed** (commit on master, 2026-10-09):

- `src/api/modelWorkloads.ts` — `ModelWorkload`, `WorkloadSettings`, `ModelWorkloadsView`, and
  boundary validation shared by store, IPC and renderer.
- `src/main/modelProfiles.ts` — store v2 `models[providerId::modelId] = { defaultId, workloads }`,
  with `adopt()` accepting both shapes. `resolve()` and `setOverride()` act on the default
  workload, so behaviour is unchanged. New: `listWorkloads`, `createWorkload`, `updateWorkload`,
  `removeWorkload`, `setDefaultWorkload`, `storedModels`.
- IPC split: `model-workloads:resolve|setDefaultSettings|storeInfo|list|create|update|remove|setDefault`
  and `orchestration:list|select|location|rename|setMode`. No `profiles:` channel remains.
- Renderer call sites moved: `ThinkingControl.tsx`, `ModelProfiles.tsx`, `ModelLibrary.tsx`.
- `test/model-workloads.test.ts` — 10 tests: migration from a real v1 store, many workloads per
  model, id collision, default promotion on remove, replace-not-merge updates, clearing
  behaviour, corrupt-entry tolerance, unreadable store, and boundary validation.

Resolved while implementing:

- **Q3 — workloads hang off a `(source, model)` pair.** The v1 key comment already made the
  argument: "so the same model name on two servers stays separate". What a model can do is a
  property of the server holding it, so the same weights behind two endpoints are two
  capabilities. Checkpoint-level grouping, if distribution needs it, is additive in stage 4.
- Settings validation accepts out-of-range numbers and lets resolution clamp them. An existing
  test asserts `maxToolCallsPerMessage: 0` is storable and reads back as the default, so
  validating ranges at the boundary would have been stricter than the store it replaced.

**Migration contract** (stage 1 must satisfy all of it):

- Each existing per-model override becomes that model's single workload, named `Default`, marked
  default, settings byte-identical.
- Each orchestration profile keeps `id`, `name`, `description`. Each role binding
  `{provider, model}` resolves to that model's `Default` workload.
- A model with no override gets no workload rows; the effective profile stays what
  `savedProfileFor` computes from catalog and server facts today.

## Stage 5: what was built

**The box you are sitting at.** Always in the roster, with real accelerator capacity read from
the driver through the same `vitals/sources.ts` readings the Vitals panel uses — `mem_info_vram_*`
from amdgpu sysfs, or `nvidia-smi`. Several devices sum; one that publishes nothing stays
*unknown* rather than counting as zero free. It sorts first, because the box you are sitting at is
never the uncertain one.

**Other boxes.** A node agent, off until someone turns it on, in `src/main/nodeAgent/`:

- `src/api/nodeAgent.ts` — the protocol (`antimatter-node-1`), its two IPC halves, the pairing
  code grammar, and `NODE_SCOPES`. There is exactly one scope, `inventory`, and it is read-only.
  An unknown scope is **refused at the exchange rather than stored**, so an agent built today
  cannot be talked into recording a grant it has no code to enforce.
- `trust.ts` — which controllers this box answers. The primitives are the ones
  `remote/pairingStore.ts` established for phones, unchanged: a 32-byte host secret sealed by the
  OS keyring, bearers persisted only as an HMAC keyed by it, constant-time comparison, offers that
  live in memory, and an atomic private write. It is a separate file and class because the thing
  trusted is different — a machine asking one read-only question, not a person holding an access
  ceiling over chat and files — and because revoking a phone and dropping a box should not be the
  same list.
- `server.ts` — two routes. `POST /v1/pair` consumes a live one-time offer; `GET /v1/report`
  answers capacity and inventory to a bearer. Nothing lists anything before pairing and nothing
  changes anything on the machine, so the agent is read-only *by construction* rather than by
  permission: the worst a stolen credential buys is one box's memory figures and checkpoint names.
- `peers.ts` — the other direction: boxes this controller has paired with, keyed `host:port` so a
  paired box and a workload's recorded box are the same string. The bearer is sealed and never
  crosses into the renderer; `list()` returns a view without it.
- `client.ts` — TLS with the certificate **pinned, not trusted**. A self-signed leaf cannot be
  validated by a chain, so the connection is made with verification off and then checked against
  the SHA-256 the pairing code carried, *before a single byte of the request — bearer included —
  is written*. A box whose certificate has changed is refused rather than re-paired silently.
  Every field of a report is treated as input from a machine this one does not control: lengths
  capped, non-finite and negative numbers dropped to null, unrecognised protocol refused outright.
- `src/main/nodes.ts` — a report attaches to a box's roster row **by host, not by port**: an agent
  listens on its own port while `--rpc` listens on another, and memory is a property of the
  machine rather than of either port. So the row keeps the RPC address a workload records while
  carrying the capacity the agent measured. A paired box no recipe mentions gets its own row. A
  report that never arrives leaves `agentError` set and the figures `null`.
- `InferenceNode` gains `capacityFrom: 'driver' | 'agent' | null`, so the UI never implies a
  provenance it does not have. The Distribution section shows *not measured* for a box with
  nothing on it, *capacity unknown* for one that is paired but silent, and a figure only where
  something measured it.
- `InferenceNodesPanel` under Settings → Models & providers → Inference nodes, both halves: this
  box answering (interface, port, pairing code, trusted controllers with revoke) and the boxes it
  uses (paste a code, forget). It unmounts when collapsed, because a pairing code must not outlive
  the screen that showed it.
- 15 tests in `test/node-agent.test.ts`, including a real TLS pair-and-report against a listener
  on `127.0.0.1` and a rejection of a wrong pin, plus a hostile-report case.

**Trust model, stated once.** The agent mints a short-lived offer; the person carries its one-time
code to the other box out of band; the exchange returns a bearer the agent keeps only as a keyed
hash. The code is spent the moment its secret checks out — including when what follows is a
refusal — so holding the secret does not buy repeated attempts at different asks. A controller is
revocable from the agent, which is the half that owns the machine being described. What an
unauthenticated caller can learn is exactly what a TCP connect already revealed: nothing.

### Deliberately not built

| piece | why not |
| --- | --- |
| telling a box to fetch weights | needs a **write** scope. The hub queue already does resumable SHA-256-verified transfer on each box, so a person opening Antimatter there and clicking download gets the same result with no new authority; the report now tells them which box is missing which checkpoint, which was the useful part |
| starting an engine on a box | needs a write scope *and* runs into the slot-count question: Antimatter restarts engines it spawned, not external systemd units. `recipes.ensurePeers` already runs a person's own configured command, which is the safer shape |

Publishing capacity and accepting commands are different decisions, and the second was not the one
taken. An agent that accepts "fetch these weights" is a materially larger thing to get right than
one that answers "how much memory have you got", and nothing above it in the stack needs it yet.

Selecting boxes on a workload is therefore still **recorded, not applied** — the runtime takes its
RPC peers on the command line — but it now reports what those boxes actually have rather than only
whether a port is open.

Q5 remains open in substance: `mode` could be derived from a workload's boxes, but
`profileDeployment` continues to derive a profile's category from its bindings and nothing reads
`WorkloadSettings.nodes` for that yet.

## A naming collision worth fixing separately

`workload` now means two things in this repository, which is the same mistake as `profiles:`
and should not be left to settle:

- `src/api/workloads.ts` + `src/main/workloads.ts` — the **prepared download catalog**: pinned,
  SHA-256-verified checkpoints offered by the setup wizard and the Models → Workloads tab.
- `src/api/modelWorkloads.ts` — ADR 0001's **named way of using a model**.

They are unrelated. The catalog ones are downloads; these are configurations. Renaming the
catalog to something like *prepared downloads* would touch the setup wizard, its docs and its
tests, so it is deliberately not bundled into this ADR — but it is a real follow-up, and the
longer both names persist the more likely someone reads one for the other.

## Open questions

Blocking stage 3 or later, safe to defer:

- **Q2 — should a workload warn when it wants more window than the server serves?** Q1 settled
  that a workload holds no serving configuration, so a workload asking for 64k against a server
  serving 32k is resolvable — `withEngineContext` already clamps it — but silently. Warning is
  cheap and would have caught the kind of drift `coder-mode` exists to prevent. Stage 5 makes the
  Distribution section the obvious place for it, since it already reports measured capacity.
  **Now live rather than hypothetical:** the `full-window` workload asks for 262,144, and
  selecting it while `coder-next-mode` has the server in `pool` mode (65,536 per slot) clamps
  without a word. A comment in two YAML files is the only thing pairing them. This is the
  highest-value remaining follow-up in the ADR.
- **Q7 — should the node protocol ever accept a command?** Opened by stage 5 rather than answered
  by it. Publishing capacity needed one read-only scope; fetching weights or starting an engine
  needs a write scope, and the two are different decisions about someone's machine.
- **Q4 — does loading an orchestration profile also set the chat model** from its `default` slot?
  It makes "load a workflow" one action, at the cost of silently changing which model answers next.
- **Q5 — where does `mode` (local/distributed/provider) come from** once distribution is a
  workload property? Currently a profile-level tag used for filtering; would become derivable.

## Machine state this was designed against

`validation-host-a`, 2026-10-09. Not part of the decision; recorded so a later reader knows what the
examples refer to. None of it is in the repository.

- `llama-coder.service` — Qwen3-Coder 30B Q8_0, port 8086, mode switched by `~/.local/bin/coder-mode`
  (`pool` 6×32,768 f16 · `maxctx` 1×262,144 f16 · `maxctx2` 2×262,144 q8_0).
- `llama-omni.service` — Qwen3-Omni 30B Q8_0 + projector, port 8081, 2×16,384.
- `llama-deepseek.service` — down since an oom-kill on 2026-10-08; cannot coexist with the above.
- Orchestration profiles in `~/.antimatter/profiles/`, renamed `Default` and `Orchestrated`.
