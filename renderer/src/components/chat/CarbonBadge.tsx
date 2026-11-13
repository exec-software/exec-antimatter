import { useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle } from 'lucide-react';

/**
 * The conversation's carbon, named and exportable.
 *
 * Small and off to the side on purpose — it is a reference number, not a feature. It earns its
 * place by being the thing you quote when something went strangely, and by being two clicks from
 * the whole conversation as Markdown: every message, every tool call, the arguments each was
 * given and what it returned.
 */

interface Props {
  threadId: string;
  title: string;
}

export function CarbonBadge({ threadId, title }: Props) {
  const [state, setState] = useState<'idle' | 'copied' | 'saving' | 'saved' | 'error'>('idle');
  const [detail, setDetail] = useState('');
  const generation = useRef(0);
  const saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    generation.current += 1;
    saving.current = false;
    setState('idle');
    setDetail('');
    return () => {
      generation.current += 1;
      clearTimeout(timer.current);
    };
  }, [threadId]);

  const feedback = (next: 'copied' | 'saved' | 'error', text: string) => {
    clearTimeout(timer.current);
    setState(next);
    setDetail(text);
    if (next !== 'error') {
      timer.current = setTimeout(() => { setState('idle'); setDetail(''); }, 2200);
    }
  };

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'conversation';

  const save = async () => {
    if (saving.current) {
      return;
    }
    const current = generation.current;
    saving.current = true;
    clearTimeout(timer.current);
    setState('saving');
    try {
      const result = await window.electronAPI.carbon.export(threadId, `${slug}.md`);
      if (current !== generation.current) {
        return;
      }
      if (result.saved) {
        feedback('saved', result.path ? `Saved to ${result.path}` : 'Chat exported');
      } else {
        if (result.reason) {
          feedback('error', result.reason);
        } else {
          setState('idle');
          setDetail('');
        }
      }
    } catch (error) {
      if (current === generation.current) {
        feedback('error', (error as Error).message);
      }
    } finally {
      if (current === generation.current) {
        saving.current = false;
      }
    }
  };

  const copy = async () => {
    if (saving.current) {
      return;
    }
    const current = generation.current;
    try {
      await navigator.clipboard.writeText(threadId);
      if (current === generation.current && !saving.current) {
        feedback('copied', 'Carbon ID copied');
      }
    } catch (error) {
      if (current === generation.current && !saving.current) {
        feedback('error', `Could not copy the Carbon ID: ${(error as Error).message}`);
      }
    }
  };

  return (
    <button
      type="button"
      onClick={(event) => { if (event.detail < 2) { void copy(); } }}
      onDoubleClick={(event) => { event.preventDefault(); void save(); }}
      onKeyDown={(event) => {
        if (event.shiftKey && event.key === 'Enter') {
          event.preventDefault();
          void save();
        }
      }}
      aria-label={`Copy Carbon ID ${threadId}`}
      aria-keyshortcuts="Shift+Enter"
      aria-description="Click to copy the full ID. Double-click or press Shift+Enter to export the chat."
      aria-busy={state === 'saving'}
      title={
        state === 'error'
          ? detail
          : `Carbon ${threadId}\nClick to copy. Double-click or Shift+Enter to export.\n${detail}`
      }
      className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums transition ${
        state === 'saved' || state === 'copied' ? 'text-accent' : state === 'error' ? 'text-danger' : 'text-ink-3 hover:bg-surface-3 hover:text-ink-2'
      }`}
    >
      {state === 'saving' ? <LoaderCircle size={11} className="animate-spin" /> : state === 'saved' || state === 'copied' ? <Check size={11} /> : <Copy size={11} />}
      {threadId.slice(0, 8)}
      <span role="status" className="sr-only">{state === 'saving' ? 'Exporting chat' : detail}</span>
    </button>
  );
}
