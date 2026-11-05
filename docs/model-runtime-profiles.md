# Engine profiles on model cards

> Publication note: host labels and local storage paths are anonymized. Raw workstation
> captures are not distributed with this note; historical measurements retain their original
> scope and are not a fresh qualification of another machine.


Open **Model Library → Engine profiles** on a model card. Supported local llama.cpp user services expose separate saved configurations for the same model, so copying a profile does not duplicate its weights, source, or model ID.

**Create engine profiles** captures the current service command as a protected **Straight shot** baseline and creates an editable **Orchestration** copy with two slots and up to 32,768 context tokens per slot. Capturing and saving profiles do not change the running engine.

Select a saved profile to edit its name, **Context per slot**, and **Parallel slots**. Use **Make a copy** to preserve a configuration before changing it. The original baseline and the active profile are protected; inactive copies can be edited or deleted.

Choose **Apply profile** to reload the engine with the saved configuration. The card shows verified per-slot context, slot count, and the total context allocation. Applying Straight shot restores the original service command and removes only Antimatter's own runtime override. Existing model assignments and agent routing bindings stay the same.

Context is per slot: 32,768 tokens × 2 slots allocates a 65,536-token pool. More slots allow concurrent inference requests, including subagents; additional requests queue at the engine. They do not create agents automatically. The prompt budget used by chats, delegated agents, and orchestrated runs is capped to the active engine's context, even if an older prompt override was larger. A reduced allocation also caps the reply reservation to one quarter of that context so project instructions and tool results still fit. Switching back restores the original capacity and reply budget without rewriting saved preferences.

## Changing models within a chat

Stop the current response, choose a model, then send a message or use **Continue**.
Selection alone does not start inference. The next request starts the selected
app-managed engine and retires idle app-owned siblings automatically. Stop also
cancels cold startup; the next engine waits for owned startup cleanup to finish.
Readiness is refreshed before deciding that an older service is still running.
A service started outside Antimatter remains externally owned and is not stopped
on behalf of another model.

Conversation history and tool results carry forward. Every request is fitted to
the selected model's current context and output limits. When history must be
compacted, the summary request also fits that destination window. The original
visible conversation remains available. A mandatory prompt that cannot fit still
requires a shorter request or a larger model.

Service failures appear as toasts and in the chat's collapsed **Diagnostics**
audit. They are saved separately from assistant prose and excluded from model
context. Partial generated responses remain intact; cancellation and runtime
pause notices likewise do not become assistant messages.

## Switching and recovery

Changing context allocation requires an engine reload, which can take time for a large model. Antimatter requires chats, agents, and inference requests to be idle before switching, then verifies the engine's model, context, and slot count. New model requests are held out while a switch is in progress. The engine's own slots must also be idle, including requests from other clients.

Failed activation restores the previous configuration when it can do so safely. A failed restoration blocks inference through the saved profile until the engine is verified again. A durable pending-switch record protects prompt budgets if the application exits between reloading the model and saving the new active selection.

Runtime profiles currently support direct loopback HTTP endpoints served by user-owned Linux systemd services whose main process is `llama-server`. Unsupported or remote providers display a reason instead of controls that merely change a label. Registration verifies the service, executable, model, and endpoint; later switches refuse unexpected changes to the original unit, other drop-ins, or the executable. Antimatter never accepts a service command from a model or renderer.

Profiles and their private service bindings live in `model-runtime-profiles.json` under Electron's user-data directory. The temporary service override is `zz-antimatter-runtime-profile.conf` in that service's user drop-in directory. Other service configuration files remain intact.

## DeepSeek on host B

The existing `local-deepseek-v4-flash` source now has these independent profiles:

| Profile | Context per slot | Parallel slots | Total context |
| --- | ---: | ---: | ---: |
| Straight shot | 131,072 | 1 | 131,072 |
| Orchestration | 32,768 | 2 | 65,536 |

On October 8, 2026, the orchestration configuration passed a live two-request smoke test using the existing DeepSeek V4 Flash 0731 UD-Q2_K_XL model. Both requests completed successfully. Straight shot was then restored and verified, with the original service file unchanged. This checks basic concurrent inference; it is not a maximum-context endurance benchmark.
