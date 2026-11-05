# Recipes: models that need more than one machine

Some models do not fit on one box. Their weights are larger than local VRAM, so the inference
server is started with an RPC peer and the layers are split across two machines. When the peer is
not listening, the load fails — several minutes in, after the weights have been read — and what
reaches the person is an HTTP 500 from the *local* server. Nothing in that error says a second
machine was involved, let alone which one, or that it simply was not switched on.

A **recipe** is the missing half: the models that need company, and the machines they need. Before
a turn goes out on one of those models, Antimatter probes each peer, and starts the ones that are
down if the recipe says how.

Nothing about any particular network lives in the Antimatter source tree. Hosts, ports, unit names
and the command that starts a peer are read from your own configuration, for the same reason the
orchestration profiles beside them are: a topology is a fact about your machines, not about
Antimatter. **A checkout with no recipes behaves exactly as it did before** — models that fit on
one box never touch this code path.

## Where they live

`~/.antimatter/recipes/*.yaml`, one file per recipe, beside `~/.antimatter/profiles/`. These
directories are outside the repository and are never packaged into a build.

## The shape

```yaml
id: two-box
name: The big model across both boxes

# Model ids this recipe applies to, compared case-insensitively. List every id the model can
# arrive under: a server often advertises a configuration id on /v1/models and answers under an
# engine alias, and Antimatter may hold either depending on when the source was last probed.
models:
  - big-model
  - Big-Model-Weights-MXFP4

peers:
  - name: the second box          # what it is called when Antimatter has to talk about it
    host: 192.0.2.10              # an address or a hostname
    port: 50052                   # the port the peer listens on

    # Optional. Run when the port is not answering. {host} and {port} are substituted; nothing
    # else is. Omit it to have Antimatter report a peer that is down without trying to start it.
    start: ssh -o BatchMode=yes {host} systemctl --user start some-rpc.service

    # Optional, default 60. How long to wait for the port after running `start`.
    startTimeoutSeconds: 60
```

A recipe that names no models can never be selected, and one with no peers asks for nothing;
either is ignored. A peer whose host is not a plausible host name is dropped, so a typo in this
file cannot turn into a second command on the end of `start`.

## What happens on a turn

1. The model id is matched against every recipe. No match means no preflight — the ordinary path.
2. Each peer is probed with a short TCP connect.
3. A peer that answers is left alone.
4. A peer that does not, and has a `start`, is started; then the port is polled until it answers
   or `startTimeoutSeconds` runs out.
5. The outcome is written to the conversation's carbon. If a peer is still not ready, it is also
   said in the conversation, naming the host and port.

**A peer that will not come up does not cancel the turn.** Some models still answer from one box,
more slowly, and refusing outright would be the worse of the two outcomes. What the person gets
instead is a turn that says which machine is missing, before the failure rather than after it.

## On the `start` command

It runs through your shell, exactly as written, with `{host}` and `{port}` substituted.

It comes from this file and nowhere else. A model cannot reach it, a tool call cannot change it,
and no part of a conversation is interpolated into it. It is the same trust level as the rest of
your local configuration: if something can write to `~/.antimatter/recipes/`, it can already run
commands as you.

If you use SSH, `-o BatchMode=yes` is worth having — it makes a missing key fail immediately
instead of hanging on a password prompt that no one is watching.
