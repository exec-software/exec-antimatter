# Prompt Studio

Prompt Studio is an editor for the message you are about to send, with the checks and the
scaffolding a long prompt deserves, and a way to run it without copying it anywhere. It is in the
sidebar under **Code**, and it can be hidden like any other sidebar section.

It is not a prompt generator. Nothing in it rewrites your words, scores them, or sends anything to
a model to "improve" them. It reads what you wrote and tells you what is in it.

## The editor is the chat's draft

The editor holds the open conversation's draft — the same text the composer holds. There is no
separate copy to keep in sync and nothing to lose by navigating away: type in the studio, switch to
the chat, and the composer has it; type in the composer and the studio has it when you come back.
Drafts already survive restarts, so a prompt left half-written survives one too.

Which conversation you are drafting for is named in the header. Open a different chat and the
editor follows it.

## Fields

Write `{{a field}}` anywhere in the prompt and it appears in **Fields** on the right. A prompt is
refused for sending while any field is empty, so a run never goes out with `{{customer}}` still in
it. Filling the fields does not change the prompt — the substitution happens on the way out, and
**As it will be sent** shows exactly what the model receives.

Field values stay with the conversation while the window is open, and are saved with the prompt
when you save it to the library, so a template reopens filled in the way you last used it.

**Apply fields** writes the values into the editor permanently, turning a template into a
one-off prompt. That is a one-way edit of your text, which is why it is a button rather than
something that happens on its own.

## Inspection

The panel on the right lists what the prompt says, worst first:

| Finding | Severity | What it means |
| --- | --- | --- |
| Placeholder | Problem | `TODO`, `TBD`, `FIXME`, `<module name>`, `[your name]` — the model reads these literally |
| Field | Problem | A `{{field}}` with nothing filled in |
| Over budget | Problem / Caution | The prompt claims more than half the model's context window, or does not fit at all |
| Nothing is asked | Problem | No imperative and no question anywhere: the prompt states facts and requests nothing |
| Vague wording | Caution | "etc.", "as needed", "clean it up" — words that read like instructions but name nothing checkable |
| Repeated word | Caution | "the the" |
| Wall of text | Caution | One unbroken block over 160 words |
| No output shape | Note | A long prompt that never says how long, or in what form, the answer should be |
| Shouting | Note | A long run of capitals, which carries no more weight than the same words in lower case |

Each finding names a line, and clicking it selects that line in the editor. Counts are capped per
kind, so one repeated habit cannot bury everything else, and a short prompt is held to less than a
long one: the output-shape note only applies past sixty words.

### Spelling

Spelling is Chromium's own, through Electron's spellchecker: misspelled words are underlined as
you type, and right-clicking one offers corrections and **Add to dictionary**, the same as in the
composer. The inspection panel deliberately has nothing to say about spelling — a dictionary
shipped inside it would be worse than the one already there.

## Blocks

The **Insert** row drops a heading at the cursor — Task, Context, Constraints, Output, Example,
Acceptance check — and a `{{field}}`. They are scaffolding, not templates: the value is having
somewhere to put the constraint you only remember once there is a line for it.

## Attachments

**Attach** adds text files to the prompt, with the same rules as the composer: 256 KB each, and a
file containing NUL bytes is refused by name rather than pasted in as mojibake. They travel with
the prompt when it is run, and with it into a new chat.

## Sending

- **Run in chat** sends the composed prompt on the conversation named in the header and takes you
  there to watch it. The draft is cleared, because it has become a message.
- **New chat** starts a fresh conversation holding the composed prompt, without sending it. The
  original chat keeps its draft, so nothing is destroyed by pressing it.

Both are refused, with the reason in the tooltip, while a field is empty, while that conversation
is already answering, or while its source is unreachable.

## The library

A draft dies with its conversation. A prompt you re-run against four models, or refine over a
month, does not belong to any one of them, so **Save** keeps it in a per-install library: at most
200 prompts, 64 KiB each, most recently touched first, searchable by name and body.

Saving over an open prompt keeps its id and creation time; **Duplicate** forks it. Opening a saved
prompt while the editor holds text that is not in the library asks first.

A prompt saved with no name is named from its first line, with Markdown headings and list markers
stripped — a prompt starting `## Task` is filed under "Task", not "## Task".

The library is stored at `prompt-library.json` in Antimatter's user data directory, 0600, written
whole and atomically. No tool reaches it: a model cannot read, rewrite or delete the prompts it is
given. An unreadable file is reported and left on disk rather than overwritten, so a prompt can
still be recovered by hand.
