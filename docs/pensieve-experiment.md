# Pensieve experimental memory

Public packages exclude the current derived `vendor/pensieve` bundle while its runtime
license/provenance and curriculum redistribution rights are reviewed. This does not remove
Antimatter's ordinary user/project note memory. The optional experiment remains available
to developers who explicitly configure a reviewed external runtime and curriculum below.

Pensieve is off in a fresh installation. Enable it under **Settings →
Experimental → Pensieve**. The switch applies to this Antimatter profile and
does not change the selected model. Disabling it preserves saved experience.

The initial experiment supports interactive chat/Code in a confirmed project
folder. Each canonical project root gets a separate SQLite store in
`<userData>/pensieve/projects/<sha256-root>/memory.pensieve`. Existing note memory
continues separately. Delegated and scheduled agents do not yet receive this
runtime; keep the workload in the interactive agent for this trial.

## Current local trial

The curriculum is pinned to current-release SDK source
`9e3341501ee697dd5150464a4d7ffc952644145b`, not the newer language-feature branches.
The v17 runtime uses the unchanged v16 curriculum: 395 NIL, Ny, Matrix, and shared reference entries.
Import validation checked 232 SDK payload hashes, compiled all 16 library
modules, and ran 63 positive fixtures plus a neutral multi-book syntax example.
Exact source revision, hashes, language labels, and evidence
levels travel with the bundle. Opposite-language fenced examples are omitted
from shared-reference presentation, with the transformation recorded and the
original source retained.

Open the application's project folder in Code and select the model and workload
being evaluated. Ask it to implement the application in Matrix, consult Pensieve, and
check its changes. Ordinary source edits and build commands now receive an
app-owned compiler check and diagnostic-specific recall automatically; explicit
`pensieve_check_project` remains available. A `nil.project.json` manifest is
required for the check. Antimatter's configured SDK must match the curriculum.

The model receives two tools:

- `pensieve_recall`: bounded language references, measured repairs, successful
  experiences, and explicitly labeled current failures. Matrix is the default
  language; the model can request Ny or NIL explicitly.
- `pensieve_check_project`: an app-owned, compile-only check. It captures complete
  project source units, hashes them, pins the SDK through its publication symlink,
  verifies all sealed SDK payloads before and after checking, and rechecks source
  identity. The driver is attested before even the project-description command.
  A failed check followed by a stable passing check can create
  a provenance-linked repair. This does not certify runtime or application behavior.

Complete project snapshots are retained as unverified audit context. A bounded
compile-only analysis supplies diagnostic source snapshots for failed checks and
the exact consumed source set for successful checks. Paths and text must match
the captured project; source and sealed SDK identity are checked again after
analysis. Imported-book corrections can therefore become learned repairs, while
unused files remain excluded. Missing or unsupported compiler evidence retains
the conservative entry-only fallback. Human-facing compiler diagnostics are
unchanged; the source-rich semantic report stays internal.

Repair diffs require actual changed text on paths evidenced in both observations.
More files becoming visible after a successful compile cannot manufacture a
repair. Corrections confined to previously unobserved files are conservatively
omitted. These observations still prove only compilation, not application behavior.

Automatic checks have a 60-second deadline and a 64-check limit per turn.
Unchanged source reuses hash-bound feedback. Each result states the actual entry
and that compilation covers only the entry and its imports. A substantial entry
collapse or replacement with a print/return-only stub within a turn warns about lost coverage
and cannot become a successful repair. These checks cannot certify the business
requirements; run the application and acceptance cases as part of the workload.
Track attempted
Python fallbacks as well as final source compliance. Raw tool arguments/results,
actual inference requests/responses, partial responses on failure, and retrieval
selections are retained. A `possiblePythonFallback` marker is a review aid, not
a complete language-compliance classifier. Arbitrary successful shell commands
are never promoted to verified repairs.

Fresh chats and process restarts reopen the same project memory. A bounded
automatic recall enters before prompt fitting; explicit recall can fetch more.
Learned evidence currently requires the same curriculum ID. A new bundle keeps
old events but excludes their learned records from recall, even if the SDK is
unchanged; cross-bundle evidence migration is not implemented. The failed v15
trial had no verified experiences to migrate.
The newest user request retains priority during compaction. Current failure
evidence and linked repairs survive process exit. Indexing failure does not
discard raw capture. A declared NIL application's legacy note memory is scoped
to that application instead of inheriting notes from an unrelated parent Git
project. Repository instruction files keep their existing scope.
This runtime intentionally leaves background consolidation
disabled while the integration is experimental.

The Settings card shows the curriculum, availability/errors, and counts for the
last project checked. A bridge error is visible; a request that cannot establish
memory capture fails rather than silently pretending memory is available.
Compilation checks currently cap source capture at 512 files / 4 MiB and require
regular files within the selected workspace, with dependencies from the pinned
SDK. UI-only compiler actions and external terminal actions are not automatically
verified Pensieve observations; use the agent's check tool for the measured record.

The agent loop also stops after three consecutive completion claims whose entire
tool batch consists of literal completion echoes or `exit 0`. It records a
visible `no-progress` reason without asking the model for another summary.
It also bounds completion claims that repeat previously observed successful
literal `nilbuild check/run` results or app-owned Pensieve checks. Initial
distinct checks do not count; read-only inspection may separate repetitions.
Edits, new or changed validation evidence, complex commands, background activity,
and human input reset this allowance. Pensieve comparisons include source hashes;
ordinary shell comparisons use command, working directory, stdout and diagnostics
and cannot attest unnoticed external source changes. The guard reports redundant
work, not application acceptance, and also operates with Pensieve disabled.

## Packaging and development

The runtime is an app-owned local Python 3.10+ subprocess, with no model/network
dependency of its own. This infrastructure is not part of the generated Matrix
application. Vendor files are derived build inputs; the manifest is tracked.

```sh
node scripts/sync-pensieve.mjs \
  --source ../exec-pensieve \
  --curriculum /absolute/path/to/verified/curriculum.json
npm run bundle
```

`scripts/build-nil-curriculum.py` in Pensieve prepares the matching corpus from
the sealed SDK and its exact source revision. Do not regenerate it by recursively
ingesting an arbitrary checkout. `vendor/pensieve/manifest.json` records the
copied runtime and curriculum hashes. The public package excludes that vendor directory
until its distribution review is complete; Python must be available on hosts where a
separately configured runtime is used.

Development overrides are app environment variables only:
`ANTIMATTER_PENSIEVE_RUNTIME`, `ANTIMATTER_PENSIEVE_CURRICULUM`, and
`ANTIMATTER_PENSIEVE_PYTHON`. A project or model cannot supply executable paths
through the recall/check schemas. State changes use main-frame-checked IPC.

The committed default remains false. Local opt-in lives only in
`<userData>/pensieve/settings.json`. To reset a trial, disable the feature and
archive its project store separately; turning the feature off does not erase it.

## Bounded warehouse replay

`scripts/test-pensieve-workload.mjs` replays the original warehouse prompt from
`scripts/pensieve-warehouse-workload.json`. Preparation is the default and makes
no model requests. A new output directory gets a fresh Matrix project, a local
copy of the matching SDK, and a private memory store outside the project. No
existing application project is imported or modified. Linux bubblewrap is
required: model shell commands can write only the candidate workspace; the host
and copied SDK are read-only and shell networking is disabled. File mutations
also reject paths resolving into the SDK. Every sealed SDK payload is checked
before execution and again before final validation.

```sh
node scripts/test-pensieve-workload.mjs \
  --output /absolute/path/to/new-trial \
  --prepare-only

node scripts/test-pensieve-workload.mjs \
  --output /absolute/path/to/new-trial \
  --run \
  --endpoint http://127.0.0.1:8086/v1 \
  --model MODEL_ID \
  --memory on \
  --max-rounds 64 \
  --time-budget-seconds 1200 \
  --temperature 0.8 \
  --max-tokens 16384 \
  --context-tokens 262144
```

The runner only uses an existing OpenAI-compatible server; it does not start,
stop, load, or unload models. The example output/context budgets and temperature
match the original trial's requested limits and server default. Every setting
is saved. The loop has a fixed round ceiling, a wall-clock deadline, and no
developer auto-continue. Independent final `nilbuild check` and `nilbuild run`
each have an additional bounded timeout (`--check-timeout-seconds`, default 60).
Use `--help` for all overrides, including `--api-key-env` for credentials that
are not persisted in configuration.

The pipeline uses the actual provider, tool loop, Pensieve integration, context
fitter, and file/shell tool implementations. It offers a smaller toolset than
the GUI and uses a minimal system prompt. It omits subagents, GUI tools, network
tools, and persistent processes. These differences are recorded in
`prepared.json` and each phase's `result.json`; this is not an exact GUI replay.
Use a separate output directory for `--memory off`. Disabling memory also
disables automatic compiler feedback in the current production wrapper, so this
comparison measures the whole experimental feature, not retrieval alone. A later
retrieval study must hold compiler feedback constant and freeze the memory input.

Inspect `reservation/result.json`, `transcript.json`, inference/stream/activity
logs, source hashes, the copied candidate source, and the final check/run stdout
and stderr. The result always says `requires-human-review`. Exit zero, successful
compilation, and printed PASS labels are observations and never acceptance.
Review that the implementation computes results from supplied data, preserves
inventory on rejection, handles replay/cancellation and repeated SKU lines,
asserts every requested transition, exercises another catalog, and contains no
application/test helpers in another language or hardcoded expected output.

Only after manually accepting that candidate, create a separate acceptance JSON
containing the reviewer's name and the exact `sourceFingerprint` from its result:

```json
{
  "accepted": true,
  "reviewer": "REVIEWER_NAME",
  "sourceFingerprint": "FINGERPRINT_FROM_REVIEWED_RESERVATION_RESULT"
}
```

Then run the original fulfillment follow-up in a fresh conversation:

```sh
node scripts/test-pensieve-workload.mjs \
  --output /absolute/path/to/new-trial \
  --run --phase fulfillment \
  --accepted-initial /absolute/path/to/manual-acceptance.json
```

Fulfillment reuses only that workspace and its persistent memory, with a new
session and no reservation transcript. The gate rejects missing acceptance or
source changes since the reviewed reservation result. Each phase runs once per
output directory and preserves its evidence separately. Fulfillment also ends
with `requires-human-review`; verify the existing tests and all added revenue
and state-transition behavior before accepting it.
