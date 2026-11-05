# Model workloads and orchestration profiles

> Publication note: host labels and local storage paths are anonymized. Raw workstation
> captures are not distributed with this note; historical measurements retain their original
> scope and are not a fresh qualification of another machine.


Status: design proposal, 2026-10-09. Not yet implemented.

This replaces the current split between "model profiles" and "agent routing" with one hierarchy:
a **model** defines inference, a **workload** defines how that model is used, and an
**orchestration profile** assigns workloads to slots in a multi-model task.

## The problem, which is partly a naming problem

The word *profile* means two unrelated things today, on the same IPC namespace:

| channel | what it actually is | shape |
| --- | --- | --- |
| `profiles:get` / `profiles:set` / `profiles:storeInfo` | per-model settings | `overrides[providerId:modelId]` — exactly **one** per model, an override map rather than a named entity |
| `profiles:list` / `profiles:select` / `profiles:rename` / `profiles:setMode` | global orchestration profiles | YAML files, `roles{role → {provider, model}}` |

Model profiles live in `src/main/modelProfiles.ts`; orchestration profiles live in
`src/main/agents/profiles.ts`. They share a prefix and nothing else.

The Model Library renders both: model cards above, an **Agent routing** section below, whose own
copy says the profiles there "are global and do not replace the chat model selected above." That
sentence is correct and still misleading — placing a global, chat-irrelevant control directly
beneath a list of models reads as *these belong to the model above*. It was read that way.

The renames on this machine show what was actually wanted: the orchestration profiles were
renamed `Default` and `Orchestrated` — names that describe **how the coder is served**, not which
model takes which agent role. That is a workload, and there is nowhere to put one.

## The hierarchy

```
Model              what inference is available
  qwen3-coder-30b  the checkpoint, served somewhere, with an engine and a window
  |
  +-- Workload     how this model is used; 1..many per model, named, launchable
  |     Default         1 wide window, no fan-out
  |     Orchestrated    6 narrow windows for subagents
  |     Reviewer        same model, different brief and tool-call ceiling
  |
Orchestration profile    a whole workflow; assigns workloads to slots
  Single box      code -> coder/Orchestrated, image -> omni/Perception
```

Three levels, each answering one question: **what can run**, **how it runs**, **who runs what**.

### Model

Unchanged in substance: a source plus a served model id. It owns the facts about inference —
endpoint, protocol, engine, architecture, quantization, and the window the server reports.

### Workload (what a model profile becomes)

A named, launchable configuration of one model. Today's `ModelProfile` is the seed: instructions,
`contextTokens`, `maxOutputTokens`, `maxToolCallsPerMessage`, `compaction`, `thinkingLevel`. It
gains an identity (`id`, `name`, `description`), stops being a single anonymous override, and
becomes 1..many per model with one marked default.

Launching a workload is one action that sets the chat model **and** applies that workload's
settings — which is what the current two-step (pick model, then edit its settings) was
approximating.

The open question with the most leverage is whether a workload should also carry **serving**
configuration. On this machine the difference between `Default` and `Orchestrated` is not prompt
settings at all, it is `--ctx-size` and `--parallel` in a systemd unit, switched by a `coder-mode`
script that exists only because two places have to agree. If a workload carried slot count,
window, and KV cache type, then selecting `Orchestrated` could reconfigure the server, and the
script and the drift it guards against both disappear. That is strictly more honest than today,
where Antimatter's recorded window and the served window are kept in step by hand.

It is also a much larger change: it makes Antimatter responsible for restarting inference
servers, which it currently only does for engines it spawned itself (`llamaVulkan`, `beholdd`),
not for externally managed systemd units. See the open questions.

### Orchestration profile

Keeps its job — assigning models to agent roles — and gains:

- **Slots bind to a workload**, not to a bare `(provider, model)` pair, so a profile can put the
  same model in two roles under different briefs and ceilings.
- **A description**, because a profile describes an entire workflow and the name cannot carry it.
  The YAML already has `description`; nothing surfaces it usefully.
- **Explicit load semantics.** Loading an orchestration profile applies its bindings; with none
  loaded, a run uses the chat model straight. That is already the behaviour — "Agents inherit the
  chat source when no routing profile is selected" — but it is implicit and reads as a fallback
  rather than a mode.

## UI

One Models page. The orchestration entry leaves the sidebar and its content moves here.

```
+-- Models ------------------------------------------------+
|  [Local] [Distributed] [Provider]        search          |
|                                                          |
|  Qwen3 Coder 30b        Qwen3 Omni 30b      GPT 20b      |
|  6 slots x 32,768       2 slots x 16,384    XDNA2         |
|  3 workloads            1 workload          1 workload    |
|  ^ selected                                              |
+----------------------------------------------------------+
|  Workloads - Qwen3 Coder 30b                    [+ New]  |
|                                                          |
|  * Default        1 x 262,144, no fan-out      [Launch]  |
|    Orchestrated   6 x 32,768, subagent pool    [Launch]  |
|    Reviewer       read-only brief, 4 calls     [Launch]  |
|                                                          |
|  Selecting one opens its settings in place:              |
|  brief - window - reply ceiling - tool calls -           |
|  compaction - thinking - distribution                    |
+----------------------------------------------------------+
|  Orchestration profiles                         [+ New]  |
|                                                          |
|  Single box          "Coder thinks, Omni sees."          |
|    default  -> Qwen3 Coder 30b / Orchestrated            |
|    code     -> Qwen3 Coder 30b / Orchestrated            |
|    image    -> Qwen3 Omni 30b  / Perception              |
|  [Load]  [Edit]                                          |
|                                                          |
|  Straight run (no profile)                      [Load]   |
+----------------------------------------------------------+
```

The bottom section is no longer a global control sitting under a model list pretending not to be
one. Workloads belong to the selected model; orchestration profiles are plainly their own thing,
one level up, and say so by composing named workloads rather than naked model ids.

## Distribution

Distribution moves from a source-level fact to a **workload** property, which is where it
belongs: the same checkpoint can be served alone on one box in one workload and striped across
three in another. That is exactly what `stripe-deepseek` and `local-deepseek-v4-flash` express
today by being two unrelated entries.

A workload's distribution section would show the boxes it can use:

```
Distribution - Qwen3 Coder 30b / Orchestrated

  [x] validation-host-a   this machine    96 GiB free   online
  [ ] validation-host-c    192.0.2.220      48 GiB free   online
  [ ] validation-host-b 192.0.2.221      --            offline

  weights: present on validation-host-a - [Send to selected]
```

This needs something to ask. The proposal is a small agent on each box — one per node, polled for
liveness, capacity and which weights it holds, able to accept an assignment and fetch weights.
The comparison drawn was Octopus Deploy's tentacles, and it is a good one: a thin, boring agent
per machine, a central thing that knows which agents exist, and deployment as "tell these
tentacles to hold this". It would live beside Antimatter and load as an extension, so a
single-box install never runs it.

Scope honesty: this is its own project. It needs a protocol, authentication between boxes, a
weight-transfer path with resumption and verification, and a liveness model that does not wedge
the UI when a box is down. The payoff is that distributed setups stop being hand-maintained
systemd units on three machines, which is what they are now.

## Migration

Nothing should break on first launch.

1. Each existing per-model override becomes that model's single workload, named `Default`, marked
   default. No settings change.
2. Each existing orchestration profile keeps its id, name and description. Each role binding
   `{provider, model}` resolves to that model's `Default` workload.
3. The `profiles:` IPC namespace splits — `model-workloads:*` and `orchestration:*` — because the
   shared prefix is the original sin and leaving it in place invites the same confusion back.
4. The YAML stays the format of record for orchestration profiles. They are deliberately
   hand-editable and version with the project; a UI that can only round-trip its own writes would
   be a regression.

## Staging

| stage | content | depends on |
| --- | --- | --- |
| 1 | Workload store: 1..many named per model, one default. IPC split. Migration. | — |
| 2 | Models page: model list + workload view beneath. Agent routing section removed. | 1 |
| 3 | Orchestration profiles v2: slots bind workloads, description surfaced, explicit load. | 1, 2 |
| 4 | Distribution as a workload property, with a node list. | 1, 3 |
| 5 | Node agent: liveness, capacity, assignment, weight transfer. | 4 |

Stage 1 is the gate: every later stage reads the workload identity it introduces. Stages 1–3 are
ordinary application work. Stage 4 is a UI with nothing behind it until stage 5 exists, so it
should ship reading a static list of configured boxes before it polls anything.

## Open questions

1. **Does a workload carry serving configuration** — slot count, window, KV cache type — or only
   prompt-side settings? Carrying it removes the `coder-mode` script and the hand-kept agreement
   between served and recorded windows, but it makes Antimatter responsible for restarting
   servers it did not spawn. A middle path: a workload *records* the serving configuration it
   expects and warns when the live server disagrees, without acting.
2. **What launches a workload whose server is configured differently?** If `Default` wants one
   262,144 window and the server is serving six of 32,768, the honest options are refuse, warn,
   or reconfigure. This is question 1 in concrete form.
3. **Do workloads belong to a model or to a (source, model) pair?** The same checkpoint served on
   two boxes is two sources today. If workloads hang off the pair, a striped and a local variant
   cannot share one; if off the checkpoint, they can, and the source becomes part of the
   workload's distribution.
4. **Does loading an orchestration profile also set the chat model** from its `default` slot?
   Doing so makes "load a workflow" one action, but means loading a profile silently changes
   which model answers the next message.
5. **Where does `mode` (local/distributed/provider) come from once distribution is a workload
   property?** It is currently a profile-level tag used for filtering, and would become derivable.
