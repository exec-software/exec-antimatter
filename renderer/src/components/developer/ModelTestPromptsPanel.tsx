import { useRef, useState } from 'react';
import { Check, Copy, TextCursorInput } from 'lucide-react';
import { copyModelTestPrompt, MODEL_TEST_CATEGORIES, MODEL_TEST_PROMPTS, type ModelTestPrompt } from './modelTestPrompts';

function PromptCard({ item }: { item: ModelTestPrompt }) {
  const promptText = useRef<HTMLTextAreaElement>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'manual'>('idle');
  const select = () => { promptText.current?.focus(); promptText.current?.select(); };
  const copy = async () => {
    setCopyState('copying');
    const copied = await copyModelTestPrompt(item, navigator.clipboard);
    setCopyState(copied ? 'copied' : 'manual');
    if (!copied) select();
  };
  return <details className="rounded-md border border-line bg-surface">
    <summary className="cursor-pointer rounded-md px-3 py-2 text-xs font-medium text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
      {item.title}
    </summary>
    <div className="border-t border-line-soft px-3 pb-3 pt-2">
      <p className="text-xs leading-relaxed text-ink-2">{item.description}</p>
      <p className="mt-1 text-[11px] text-ink-3">Exercises: {item.focus.join(' · ')}</p>
      <div className="my-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void copy()} disabled={copyState === 'copying'}
          aria-label={`Copy full prompt: ${item.title}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[11px] text-ink hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50">
          {copyState === 'copied' ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          {copyState === 'copying' ? 'Copying…' : copyState === 'copied' ? 'Copied full prompt' : 'Copy full prompt'}
        </button>
        <button type="button" onClick={select} aria-label={`Select full prompt: ${item.title}`}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-ink-2 hover:bg-surface-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <TextCursorInput size={12} aria-hidden="true" />Select text
        </button>
        <span className="text-[10px] text-ink-3">{item.prompt.length.toLocaleString()} characters · no automatic send</span>
      </div>
      <p role="status" aria-live="polite" className={`mb-2 text-[11px] ${copyState === 'manual' ? 'text-warning' : 'text-ink-2'}`}>
        {copyState === 'manual' ? 'Clipboard unavailable. The full prompt is selected below; press Ctrl+C or ⌘C to copy it manually.'
          : copyState === 'copied' ? 'Copied. Paste into a new chat in your scratch workspace, review it, then send when ready.' : 'Expand, read, and copy the complete project request below.'}
      </p>
      <textarea ref={promptText} readOnly spellCheck={false} value={item.prompt} rows={12}
        aria-label={`Full prompt: ${item.title}`}
        className="min-h-64 w-full resize-y rounded-md border border-line bg-surface-0 p-3 font-mono text-[11px] leading-relaxed text-ink focus:border-accent focus:outline-none" />
    </div>
  </details>;
}

/** Copy-only examples: selecting a prompt never creates a chat or starts tools/inference. */
export function ModelTestPromptsPanel() {
  return <section aria-labelledby="model-test-prompts-title" className="mt-8 border-t border-line pt-6">
    <h2 id="model-test-prompts-title" className="text-xs font-medium uppercase tracking-wide text-ink-3">Model test prompts</h2>
    <p className="mt-1 text-xs leading-relaxed text-ink-2">
      Eight complete project requests, from small tools to integrated applications. Use a disposable scratch workspace,
      copy a prompt, and paste it into a new chat with the model you want to test. This page does not run tools, install
      dependencies, create chats, or send messages.
    </p>
    <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
      Each prompt includes workspace boundaries, verification, and bounded delegation where useful. Compare actual artifacts,
      tool use, test results, and honest failure reports—not answer length. Browser and agent checks depend on available capabilities.
    </p>
    <div className="mt-4 space-y-3">
      {MODEL_TEST_CATEGORIES.map((category, index) => <details key={category.id} open={index === 0} className="rounded-lg border border-line bg-surface-2">
        <summary className="cursor-pointer rounded-lg px-3 py-3 text-xs font-medium text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          {category.title}
        </summary>
        <div className="space-y-2 px-3 pb-3">
          <p className="pb-1 text-[11px] text-ink-2">{category.description}</p>
          {MODEL_TEST_PROMPTS.filter((item) => item.category === category.id).map((item) => <PromptCard key={item.id} item={item} />)}
        </div>
      </details>)}
    </div>
  </section>;
}
