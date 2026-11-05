# Conversation repair ("doctor mode")

Status: design proposal, not an implemented feature.

## First release: repair a copy

Enter **Repair conversation** from an idle conversation's menu. Work in a draft, compare
the recorded conversation with the context proposed for the next run, then choose
**Continue as repaired copy**. Preserve the original conversation and Carbon. Do not
automatically send a message or replay tools when saving the repaired copy.

The first useful slice allows editing user/assistant text, excluding complete exchanges,
truncating after a selected boundary, and inserting a corrective user message. Show the
diff and context size before committing. Mark manually authored assistant content as such.
Tool-bearing exchanges can be preserved only where their exact retained history is valid;
exclude complete tool-call/result groups together. Arbitrary tool-result surgery is a later
step, not a plain text field that silently becomes execution evidence.

## What the current architecture requires

- Visible messages live in `src/main/conversations.ts`; the expanded model history, tool
  calls/results, and compacted summaries live separately in `src/main/transcripts.ts`.
- Transcript resume uses visible message identities. Changing only displayed text while
  retaining those identities can bring the original hidden context back on the next run.
- Carbon is an audit view, not a lossless replay journal. Entries are bounded to 8,000
  characters and tool entries lack complete protocol identities. Compacted history cannot
  always be reconstructed exactly. Explain that limit and offer an explicit rebuild from
  visible messages, rather than pretending old tool context is still available.
- Assistant tool batches and their results must remain protocol-valid atomic groups.
  Editing prose also requires rebuilding tool/voice `contentOffset` anchors.

## Safety and persistence contract

Repair changes what the model sees; it does **not** undo filesystem writes, sent messages,
or other tool effects. Display this warning in the editor and before continuing. Repeated
commands may repeat side effects. Edited or synthetic tool results must never be displayed
as recorded execution or proof of success.

Keep real permission policy and system/developer authority host-owned. Inserted repair
messages cannot grant access, approve tools, or masquerade as higher-priority instructions.

Require an idle source conversation, including delegated agents, pending approvals,
remote-owned turns, and live voice. Commit through a host-owned revision-checked operation,
not the renderer's whole-thread compatibility save. Use fresh thread/run/message identities,
record parent thread/revision and the repair diff, and rebuild context/compaction caches.
Never copy live ownership, pending approval IDs, or provider replay identities.

The visible and expanded histories currently use separate files. A staged journal/commit
must make both durable before publishing a repaired branch. The best-effort transcript
writer is not sufficient for an acknowledged repair transaction.

## Follow-on: tool surgery

Add a durable ordered event journal with message/tool IDs, visible-to-model mappings,
original snapshots, revisions, and compaction lineage. Then support paired tool edits,
exclusions, and synthetic messages, with provider validation and clear manual provenance.
Keep the untouched original available and show downstream messages that became stale after
an earlier edit. Do not automatically retain them as if regenerated from the corrected prompt.

Suggested implementation seam: `conversationRepair.ts` for preview/validation/commit,
strict repository and transcript APIs, then a desktop repair editor. Regression tests must
inspect the actual next provider request—not just rendered bubbles—including restart,
compaction, conflicting phone saves, partial persistence, tool pairing, and Carbon preservation.
