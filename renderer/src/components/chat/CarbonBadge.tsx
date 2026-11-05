import { useState } from 'react';
import { Check, FileDown } from 'lucide-react';

/**
 * The conversation's carbon, named and exportable.
 *
 * Small and off to the side on purpose — it is a reference number, not a feature. It earns its
 * place by being the thing you quote when something went strangely, and by being one click from
 * the whole conversation as Markdown: every message, every tool call, the arguments each was
 * given and what it returned.
 */

interface Props {
  threadId: string;
  title: string;
}

export function CarbonBadge({ threadId, title }: Props) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [detail, setDetail] = useState('');

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'conversation';

  const save = async () => {
    setState('saving');
    try {
      const result = await window.electronAPI.carbon.export(threadId, `${slug}.md`);
      if (result.saved) {
        setState('saved');
        setDetail(result.path ?? '');
        window.setTimeout(() => setState('idle'), 2200);
      } else {
        setState(result.reason ? 'error' : 'idle');
        setDetail(result.reason ?? '');
      }
    } catch (error) {
      setState('error');
      setDetail((error as Error).message);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void save()}
      title={
        state === 'error'
          ? detail
          : `Carbon ${threadId}\nExport this conversation — every message and tool call — as Markdown.`
      }
      className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums transition ${
        state === 'saved' ? 'text-accent' : state === 'error' ? 'text-danger' : 'text-ink-3 hover:bg-surface-3 hover:text-ink-2'
      }`}
    >
      {state === 'saved' ? <Check size={11} /> : <FileDown size={11} />}
      {state === 'saved' ? 'exported' : threadId.slice(0, 8)}
    </button>
  );
}
