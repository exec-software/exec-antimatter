# Personalization, model setup, and inference diagnostics

On a new installation, Antimatter opens a four-step setup wizard: your profile, your
assistant, model workloads, and finishing touches. Every step can be skipped. An interrupted
first run resumes; existing installations keep their configuration and can open the wizard from
**Settings → General → Your assistant → Open setup wizard**, or from **Models → Workloads → Run
setup wizard**.

The final step is optional and turns nothing on by itself. It recommends the phone companion app
and offers the switch that allows local-network connections, a shortcut to device pairing, and an
**Advanced** box for the theme. The companion-app download link is a placeholder until the
published app has a URL.

## Your assistant

Set a name and a personality or working style in **Settings → General → Your assistant**.
The name appears in the composer, and both fields become part of the main assistant's prompt
on its next request. Specialist agents retain their own role instructions. These preferences
do not change tool permissions. Like your About you profile, they are saved locally and sent
to the model you choose when it answers a conversation.

## Model Library

The three filters apply to both model cards and agent-routing profiles:

- **Local:** a model running on one computer, including a self-hosted source reached over a LAN.
- **Distributed:** a model using configured peers or explicitly assigned to this category.
- **Provider:** hosted/BYOK sources.

Use **Rename** directly on a card. **Edit settings** includes the card's category, model
metadata, instructions, context/output limits, tool-batch limit, compaction, and supported
thinking levels. The model's API identifier stays unchanged. **Hide** removes a card from the
ordinary view; enable **Show hidden models** to restore it. Server refreshes preserve these
choices. Removing an explicitly declared model removes its catalog entry, not its weight files.

Thinking controls appear only for recognized source/model combinations. **Default** leaves
the server's behavior unchanged. Other levels use the relevant protocol's effort or token-budget
control. Available levels vary by model; a model without an exposed thinking control does not
receive an invented parameter. Changes apply to subsequent requests using that model profile,
including agent and orchestrator runs.

## Tested workloads

The same catalog appears in two places: as step three of the wizard, and as **Models →
Workloads** afterwards, so a prepared setup stays reachable once first run is over.

It offers pinned Qwen3-Coder 30B, Qwen3-Omni 30B, DeepSeek V4 Flash 0731, and MiMo V2.6 Flash RL
downloads. Each card identifies its memory requirements, engine, every pinned file, and the scope
of previous testing. See [workload provenance](model-provenance/setup-workloads.md) for exact pins
and limits.

Qwen3-Omni is the one multimodal entry. Its projector (`mmproj`) is a second pinned file with its
own resumable queue record, downloaded and SHA-256 verified beside the weights and passed to the
runtime as `mmproj`. The card reads `ready` only once both files are verified, because a model
served without its projector starts normally, answers text, and reports no vision or audio support
rather than failing. Its preset pins the checkpoint's own 65,536-token window.

Downloads use the normal Hub queue, with resume, disk-space checks, and SHA-256 verification.
After verification, **Set up workload** creates its model card and runtime profile. MiMo requires
RPC peer addresses supplied by you; the other presets can also use peers. Peer runtimes must be
started separately with a matching llama.cpp build. Developer network addresses are never copied
into your settings.

Selecting a configured workload starts the bundled Vulkan router; its first request loads the
model. Antimatter refuses to replace an app-managed workload that is still serving another
request. No model download, peer provisioning, or inference starts just by opening the wizard.

## Inference servers

A stopped local engine that Antimatter can start on demand leaves the new-chat composer available.
The first prompt starts the service through the normal request preflight. Checking readiness does
not start or adopt a service: Antimatter verifies a matching local configuration first. Missing or
ambiguous services and unavailable external sources still report a problem, and a server actively
loading its model still holds requests until it is ready.

**Settings → Models & providers → Inference servers** lists the two servers this app starts on
the loopback and can stop or restart:

- **Beholdd (bundled CPU)** — the native engine, on port 6768.
- **llama.cpp router (Vulkan)** — port 6769. One router serves the compatibility source *and*
  every prepared workload, so this is where a wedged DeepSeek, Omni, or MiMo is recovered.

Each entry reports its state, endpoint, process id and uptime, the source it is currently
serving, the file it loaded, the last exit, and a log tail. Previously the router had no controls
at all: it was started only as a side effect of selecting a model, which leaves no way back when
a running server stops answering or its port is held.

**Restart** stops the server and starts it again with the selection it already holds, so a
crashed workload returns as itself instead of falling back to the packaged checkpoint. Credentials
are re-read by the next turn, which asks the engine to prepare again, so restarting under an idle
chat is safe. A workload whose files have gone missing is named rather than silently downgraded,
and nothing is stopped when the restart cannot be honoured.

A server serving a request refuses to stop; **Stop anyway** is the explicit choice to abandon
that turn, and it is never the default. A listener Antimatter did not spawn is never stopped from
here, with or without that override. An engine whose status cannot be read is reported as unknown
rather than stopped, is not acted on, and does not hide the other server's controls.

## Inference debug overlay

Use the activity icon in the conversation header to toggle **Inference debug**. It remembers
whether it is open. Each request within a tool loop has its own measurements; the request
selector lets you inspect previous rounds from this session, and the copy button exports the
timing records as JSON.

**Observed TTFT** measures the first text, reasoning, or tool fragment received by the app.
It is not a claim about a server's hidden first token. Prefill time/speed, decode time/speed,
input/output counts, reasoning tokens, and cached tokens are shown only when reported by the
server. An em dash means unreported. These measurements are separate from the older approximate
text-throughput display. The overlay stores bounded session diagnostics, not prompts or responses.
