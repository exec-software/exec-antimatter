import { HAG_SOURCE_ID, HAG_PREVIEW_MAX_EVALUATED_TOKENS, HAG_PREVIEW_MAX_OUTPUT_TOKENS } from '../../../../src/api/hag';

/** Source identity, not the model's display name, selects this restricted experiment. */
export function HagPreviewNotice({ sourceId, onManage }: { sourceId?: string; onManage?(): void }) {
  if (sourceId !== HAG_SOURCE_ID) return null;
  return <aside aria-label="HAG text preview" className="mb-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-[11px] leading-4 text-ink-2">
    <div className="flex items-center gap-2"><strong className="font-medium text-primary">HAG text preview · Qwen3-0.6B</strong>
      {onManage && <button type="button" onClick={onManage} className="ml-auto shrink-0 rounded px-1 text-ink-3 underline underline-offset-2 hover:text-ink focus-visible:outline-primary">HAG settings</button>}
    </div>
    <p className="mt-1">Tools and file attachments are off. Prompt, history and reply share a {HAG_PREVIEW_MAX_EVALUATED_TOKENS.toLocaleString('en-US')}-token preview budget; replies are limited to {HAG_PREVIEW_MAX_OUTPUT_TOKENS} tokens.</p>
    <p className="mt-1 text-ink-3">Uses a minimal prompt without workspace or memory context. History that is too long or contains tool calls is refused; start a new chat or choose your usual model.</p>
  </aside>;
}
