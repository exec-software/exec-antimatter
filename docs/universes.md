# Universes

A universe is the workbench Antimatter is wearing.

Antimatter began as a coding tool with a chat down one side. That is one universe — **Code** — and
it is only the default because it was first. Someone cutting a film, mixing a record or grading
photographs needs a different surface, different tools and a different vocabulary, but the same
conversation, the same models, the same workspace and the same machine underneath. A universe is
that surface: a declared workbench the application assembles, not a second application you
alt-tab to.

Three properties make it a concept rather than another page.

**It is declared, not coded.** A universe is a manifest — stages, panels, generators — and the
workbench is built from it. Adding one means writing a manifest and, where it needs a surface
nothing else has, one panel implementation. It is not a fork of the shell. The built-in manifests
go through exactly the parser an expansion goes through, and there is a test that asserts it: if
Code or Movie needed a field the parser rejects, the format would be a fiction and the first
third-party universe would discover it the hard way.

**It is self-contained.** Everything a universe owns — documents, assets, licence, any weights it
was packaged with — lives under its own root and goes when it goes. That is what makes an
expansion shippable separately from the application, and what keeps uninstalling one from being
an archaeology exercise.

**It is entitled.** Some universes are built in and always there; others are expansions that may
one day be bought. Entitlement is a property of the manifest and is checked in exactly one place,
so "is this licensed" is never a question each panel answers for itself.

## What ships

| Universe | Entitlement | What it is |
| --- | --- | --- |
| Code | built-in | The workspace, file tree, language tools and terminal Antimatter started as. |
| Movie | included | A hybrid film workbench. The first expansion. |

Both are declared in `src/api/universeCatalog.ts`. Code is `built-in`, which means it can never be
closed by a licence check — see *Licensing* below.

## The parts

| File | What it holds |
| --- | --- |
| `src/api/universes.ts` | Manifests, panels, layouts, and the parser both built-ins and expansions go through. |
| `src/api/universeCatalog.ts` | The Code and Movie manifests, and the generator specs. Data only. |
| `src/api/universeLicences.ts` | Grants, entitlement, and the canonical payload a signature covers. Pure. |
| `src/api/generators.ts` | The generator contract: adapters, capabilities, requests, jobs. |
| `src/api/movie.ts` | The production document and its edits. |
| `src/main/universes.ts` | The registry: manifests, layouts, grants, bindings. The one enforcement point. |
| `src/main/movie.ts` | Production documents and their assets, one directory each. |
| `src/main/movieTools.ts` | The Movie tools, answered here because the store is here. |
| `mcp/tools/movie.ts` | The same tools as the model reads them. |
| `renderer/src/components/universes/` | The workbench, the Movie panels, and Atoma. |

Three kinds of state are kept deliberately apart under `userData/universes`:

```
universes/
  layouts/<id>.json      how the person arranged that workbench
  licences/<id>.json     the grant, if any
  expansions/<id>/       an installed expansion's own manifest and files
  generators.json        endpoints and units, per machine
  movie/
    productions/<id>.json
    assets/<id>/         every take for that production
```

Layouts are not inside the expansion's directory, so an expansion update cannot disturb how
someone arranged it. Grants are separate again, so reinstalling an expansion does not lose the
licence and removing a licence does not touch the work.

## The workbench

Panels dock into four regions — `left`, `main`, `right`, `bottom`. The manifest says where each
panel would like to be; the person's layout outranks it, and is remembered per universe.

Panel *implementations* are compiled into the application and selected by kind
(`UniversePanelKind`). A manifest cannot ship executable code. That is deliberate: an expansion is
data the app renders, not a plugin with the run of the process. An unknown kind is dropped at
parse time and the rest of the workbench opens, so a manifest from a newer expansion than the
installed build degrades instead of blanking.

**Stages** name the shape of the work and bring panels forward. They are not a wizard: entering a
stage opens what it asks for and closes nothing. Someone who keeps the render queue open through
every stage keeps it. A workbench that forbade going backwards would be wrong about the work.

## Movie, and why it is not Lightroom

The traditional shape — Lightroom's, and every NLE's — is a one-way ladder: import, organise,
select, edit, grade, export. It assumes the footage already exists and that the work is choosing
among it.

Generation breaks that assumption. When a shot can be *made* at any point, a pipeline that treats
media as the input and the cut as the output has the dependency backwards half the time: you cut
first to find out what is missing, generate the missing thing, then cut again.

So a production is built the other way round:

> **A shot is an intent that may or may not have media yet.**

Every shot carries what it is *for* — a slug, a line of intent, a prompt, references, a duration —
independently of any file. A shot with no takes is still a real shot: it occupies its place in the
cut, it has a length, it plays as a slug. Generating a take fills it in. Generating another gives
you a choice without disturbing the cut, because **the cut points at the shot, never at a file.**
Dragging in footage you shot yourself is the same operation as a generator finishing one; neither
is privileged.

Two consequences worth stating:

- **Re-generating never costs you the edit.** The timeline survives every take, including the one
  where you changed the prompt and started over. There is a test named after this claim.
- **The cut is meaningful before any pixels exist.** Lay out a five-minute film in slugs, feel its
  rhythm, and only then spend GPU-hours on the shots that survived.

A take records the prompt and seed it was *actually* made from, not the shot's current ones. The
shot's prompt moves on; the take's did not, and without that a take cannot be reproduced — which
is the whole reason for keeping takes.

The stages are Premise → Boards → Shots → Cut → Finish. That is the order work usually starts in,
not an order it has to proceed in.

## Generators

Antimatter's existing sources answer with tokens. Nothing in that stack can make a frame of video:
llama.cpp runs transformers, and a video model is a diffusion pipeline with a sampler, a VAE and a
scheduler that has no business inside a chat completion. So rather than bend the source
abstraction until it fits, a universe declares **generators** — a much smaller contract whose only
job is "take a prompt and some references, come back with a file".

Adapters, not one protocol, because there is no standard here and pretending otherwise would mean
a compatibility layer that is wrong for every backend:

| Adapter | What it talks to |
| --- | --- |
| `comfy` | A ComfyUI instance on this machine or the LAN — the one most people already run. |
| `openai-video` | Any OpenAI-shaped video endpoint, hosted or your own. |
| `unit` | A user systemd unit Antimatter probes and starts on demand, the same arrangement local inference engines already use. The path a packaged expansion takes. |

A generator is **never required**. Every universe has to be useful with none configured — you can
cut, arrange and annotate footage you shot yourself — because the alternative is an expansion that
is a brochure for a GPU you may not have.

Capabilities are carried per generator so the workbench offers what the backend can deliver rather
than what the marketing said. `fitRequest` trims a request to fit and *returns what it changed*:
someone who asked for 2K from a 768p model wants the render, and wants to be told it came out at
768p. Refusing outright would be correct and useless.

### The packaged model

**Wan 2.2 (`Wan-AI/Wan2.2-TI2V-5B`), Apache-2.0.**

Chosen on licence grounds as much as technical ones. Apache-2.0 means weights that can be
redistributed inside a paid expansion without negotiating terms, and of the current open video
models it is the only one where that is true. The alternatives are better on paper and worse on
paper's terms:

- **MiniMax H3 / Hailuo 3.0** does 15-second 2K clips with native stereo audio, which is the
  closest thing to what we actually want. But only H3-Base is open — reported as 33B and capping
  out near 768p locally, with Context-IR and 2K regenerate staying API-side — and reports of its
  weights licence describe both a revenue cap on commercial use and territory exclusions covering
  the US, EU, UK and KR. Not something we can ship. Perfectly usable through `openai-video` by
  someone who has accepted those terms themselves.
- **LTX-2.x** is the fastest, has audio, and LTX-2.3 is credited with 4K. VRAM claims across
  sources range from 8 GB to 32 GB, and it is a community licence with conditions.
- **HunyuanVideo 1.5** is strong per unit of hardware (~14 GB with offloading) under a custom
  community licence.

Because the catalogue is data, changing the packaged default is an edit to `GENERATOR_SPECS` and
nothing else. A test asserts that any spec which ships weights ships them under a
redistributable licence.

## Licensing

Every universe that ships today is included, so nothing in the licence machinery currently stands
between anyone and their work. It exists now anyway, because the alternative — bolting entitlement
on once something is for sale — is how applications end up asking the network for permission to
open a file the person already has.

- **Offline by construction.** A grant is a signed file; verification is an Ed25519 check against
  a key compiled into the application. There is no server to reach, so there is no state in which
  a working licence stops working because something else is down. The licence manager says this
  on screen, where someone is about to paste a licence.
- **It gates the universe, not the work.** An expired grant closes the workbench and never touches
  documents, media or weights, all of which are the person's. The closed-universe screen says so.
- **One check, one place.** `universes.assertOpen()` is called by every IPC handler that touches a
  universe's documents. No panel decides for itself whether it may draw, which is what keeps a
  half-licensed state from existing.
- **Free universes never consult a grant.** A `built-in` or `included` universe returns `granted`
  without looking at the licence directory at all. This is not an optimisation: it means a corrupt
  or expired file on disk can never close something that was free, which is precisely the failure
  that makes people distrust licensing.
- **A grant for a free universe is still checked.** Installing a bogus licence for Movie fails
  rather than being waved through — and still does not close Movie.

The signature covers a canonical, field-ordered serialization rather than the file bytes, so a
grant can be pretty-printed or reflowed by a form and still verify. What is signed is the meaning,
not the whitespace. **The field order in `canonicalGrant` must never be sorted or derived from
`Object.keys`** — every existing grant would stop verifying.

`SIGNING_KEYS` in `src/main/universes.ts` is empty while everything ships included. There is
nothing to verify yet, and a key published before it is needed is a key that has to be rotated
before it is used. Adding the first paid expansion means adding its key and shipping a release.
An unknown key id fails closed.

## Atoma

The floating assistant over a workbench. What matters about it is what it is *not*: not a second
assistant, no history of its own, and it does not start a fresh thread when you open it. It is the
conversation you already had open in the chat view — same thread, same model, same tools, same
memory of what you worked out ten minutes ago.

That is the entire reason it is worth building. An assistant living inside the video workbench that
knows nothing about the chat where you decided what the film was is a worse assistant than the one
you just navigated away from, and people would simply navigate back. Sharing the thread means
leaving the chat for the workbench costs nothing.

It is a presentation layer over state `App.tsx` owns: messages arrive as props, and submitting
calls the same handler the real composer does. Nothing about a turn is duplicated, because two
code paths that run turns are two code paths that drift. The conversation is application state and
the panel's placement is part of a universe's layout, so `UniversePage` takes Atoma as a render
callback and each side owns the half it knows about.

## Keeping the workbench and the document in step

The production is one document with two writers: the person at the workbench and the model
mid-turn. Main owns it and broadcasts `movie:changed` after every edit, including the ones its own
tools make, and the workbench re-reads. Without that a tool call changes the film under a stale
page and the next thing the person does writes their old copy back over the model's work.

The other half of that is text fields. Every edit is a round trip, so a textarea bound straight to
the document is replaced mid-sentence by what the disk had a moment ago, and under any IPC delay
characters land out of order. The brief, the look, notes, slugs, intents and prompts are therefore
buffered locally and committed on a pause or on blur — and while a field is dirty an update from
elsewhere does not overwrite the sentence being typed; it lands as soon as the typing stops.

## Media

Takes are tens of megabytes. The existing preview path answers with a data URL, which is right for
a screenshot in a transcript and wrong here — it would copy every clip through IPC as base64 on
every draw. So universe media is served over its own scheme:

```
antimatter-media://movie/<productionId>/<path>
```

Registered with `stream` privileges so a long take can be seeked rather than re-downloaded on
every timeline drag. It resolves only inside one production's assets directory, after
`realpathSync`, so a symbolic link planted there cannot reach out of it. Failures return a uniform
404 for both "not there" and "not allowed", so the scheme cannot be used to discover what exists
elsewhere on the disk.

Asset paths in a production are stored **relative** to its assets directory, so copying the
directory to another machine — or pointing Antimatter at a different root — leaves every take
resolving.

## Tools

The Movie tools are declared in `mcp/tools/movie.ts` and answered in `src/main/movieTools.ts`,
intercepted before they reach the tool server. The store is in the main process and an edit has to
be serialised against the person dragging a shot on the same timeline.

**Which production is not a tool argument.** It is whichever one the person has open in the
workbench, read from `UniverseLayout.documentId`. A model that could name a production could name
one belonging to work it was never shown. A test asserts no tool declares a `production*`
argument.

Every refusal names what to do instead. These are called mid-turn by a model that cannot see the
screen, so "no shot sc-3" is a dead end and "no shot sc-3; call movie_read again" is a turn that
recovers.

`test/movie-tools.test.ts` checks the seam in both directions — every intercepted name is
declared, every declared name is intercepted, and all of them are in `ALL_TOOLS`. A tool declared
and never intercepted reaches a stub that throws "route your turn through the app", which reads as
a bug in the app rather than a missing registration; a tool intercepted and never declared is
simply invisible to every model. Neither shows up in a test of the handler alone.

## Not built yet

- **The render queue.** Generators are declared, configured, capability-checked and persisted, and
  the workbench reports which are ready. Nothing submits a job yet: `GeneratorJob` is defined and
  the adapters are not implemented. The Render control in the shot inspector is disabled and says
  so rather than failing on press.
- **Ingesting your own footage.** A take can be added to a production by a tool or by the store,
  but there is no drag-and-drop import, no probe for duration and dimensions, and no poster
  extraction.
- **Export.** The cut can be laid out but not rendered to a file.
- **Audio, photo and other universes.** The framework takes them; nothing declares them.
- **Expansions as installable packages.** `expansions/<id>/universe.json` is read if it is there,
  but nothing installs, verifies or removes one.
