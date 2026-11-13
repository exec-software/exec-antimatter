import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bold, CheckSquare, Code2, Heading2, Italic, Link2, List, ListOrdered, Quote, Redo2, Strikethrough, Undo2 } from 'lucide-react';
import { notesDocumentMarkdown, notesMarkdownHtml } from './notesMarkdown';

interface Props {
  value: string;
  onChange(value: string): void;
  onCompositionChange?(composing: boolean): void;
  disabled?: boolean;
}

const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function ChatNotesEditor({ value, onChange, onCompositionChange, disabled = false }: Props) {
  const [mode, setMode] = useState<'rich' | 'source'>('rich');
  const [link, setLink] = useState<string | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const lastValue = useRef<string | null>(null);
  const composing = useRef(false);
  const savedSelection = useRef<Range | null>(null);
  const compositionCallback = useRef(onCompositionChange);
  compositionCallback.current = onCompositionChange;

  useEffect(() => () => compositionCallback.current?.(false), []);

  useLayoutEffect(() => {
    if (!editor.current || composing.current) {
      return;
    }
    if (lastValue.current !== value || editor.current.dataset.initialized !== 'true') {
      editor.current.innerHTML = notesMarkdownHtml(value);
      editor.current.dataset.initialized = 'true';
      lastValue.current = value;
    }
  }, [value, mode]);

  const changed = () => {
    if (!editor.current || composing.current || disabled) {
      return;
    }
    const next = notesDocumentMarkdown(editor.current);
    lastValue.current = next;
    onChange(next);
  };

  const finishComposition = () => {
    composing.current = false;
    changed();
    compositionCallback.current?.(false);
  };

  const switchMode = (next: 'rich' | 'source') => {
    if (composing.current) {
      finishComposition();
    }
    setLink(null);
    setMode(next);
  };

  const selectEditor = () => {
    editor.current?.focus();
    const selection = window.getSelection();
    if (savedSelection.current && editor.current?.contains(savedSelection.current.commonAncestorContainer)) {
      selection?.removeAllRanges();
      selection?.addRange(savedSelection.current);
    }
  };

  const command = (name: string, argument?: string) => {
    if (disabled) {
      return;
    }
    editor.current?.focus();
    document.execCommand(name, false, argument);
    changed();
  };

  const selectedText = () => window.getSelection()?.toString() ?? '';
  const showLink = () => {
    const selection = window.getSelection();
    savedSelection.current = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    setLink('');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-1 border-b border-line p-2">
        <div className="mr-2 flex gap-1" role="group" aria-label="Notes editor mode">
          <button type="button" aria-pressed={mode === 'rich'} onClick={() => switchMode('rich')}
            className={`rounded px-2 py-1 text-xs ${mode === 'rich' ? 'bg-surface-3 text-ink' : 'text-ink-3'}`}>Write</button>
          <button type="button" aria-pressed={mode === 'source'} onClick={() => switchMode('source')}
            className={`rounded px-2 py-1 text-xs ${mode === 'source' ? 'bg-surface-3 text-ink' : 'text-ink-3'}`}>Markdown</button>
        </div>
        {mode === 'rich' && <div className="flex flex-wrap gap-0.5" role="toolbar" aria-label="Format notes">
          {[
            { title: 'Bold', icon: Bold, action: () => command('bold') },
            { title: 'Italic', icon: Italic, action: () => command('italic') },
            { title: 'Strikethrough', icon: Strikethrough, action: () => command('strikeThrough') },
            { title: 'Heading', icon: Heading2, action: () => command('formatBlock', 'h2') },
            { title: 'Bulleted list', icon: List, action: () => command('insertUnorderedList') },
            { title: 'Numbered list', icon: ListOrdered, action: () => command('insertOrderedList') },
            { title: 'Task list', icon: CheckSquare, action: () => command('insertHTML', `<ul><li><input type="checkbox" aria-label="Task complete"> ${escapeHtml(selectedText())}</li></ul>`) },
            { title: 'Quote', icon: Quote, action: () => command('formatBlock', 'blockquote') },
            { title: 'Code block', icon: Code2, action: () => command('insertHTML', `<pre><code>${escapeHtml(selectedText()) || '\n'}</code></pre>`) },
            { title: 'Link', icon: Link2, action: showLink },
            { title: 'Undo', icon: Undo2, action: () => command('undo') },
            { title: 'Redo', icon: Redo2, action: () => command('redo') },
          ].map(({ title, icon: Icon, action }) => <button key={title} type="button" title={title} aria-label={title}
            disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={action}
            className="rounded p-1.5 text-ink-2 hover:bg-surface-3 disabled:opacity-40"><Icon size={15} /></button>)}
        </div>}
      </div>
      {link !== null && <form className="flex items-center gap-2 border-b border-line p-2" onSubmit={(event) => {
        event.preventDefault();
        selectEditor();
        const label = selectedText() || link;
        command('insertHTML', `<span data-note-link="${escapeHtml(link)}" class="text-primary underline">${escapeHtml(label)}</span>`);
        savedSelection.current = null;
        setLink(null);
      }}>
        <label htmlFor="chat-note-link" className="text-xs text-ink-2">Link</label>
        <input id="chat-note-link" autoFocus value={link} onChange={(event) => setLink(event.target.value)}
          className="min-w-0 flex-1 rounded border border-line bg-surface-2 px-2 py-1 text-sm" placeholder="https://example.com" />
        <button type="submit" disabled={!link.trim()} className="rounded bg-primary px-2 py-1 text-xs text-on-primary disabled:opacity-40">Insert</button>
        <button type="button" onClick={() => { setLink(null); selectEditor(); }} className="px-2 text-xs text-ink-2">Cancel</button>
      </form>}
      {mode === 'source' ? <textarea aria-label="Chat notes Markdown" value={value} disabled={disabled} spellCheck
        onChange={(event) => onChange(event.target.value)}
        className="min-h-[220px] flex-1 resize-none bg-transparent p-4 font-mono text-sm text-ink outline-none" /> :
        <div ref={editor} role="textbox" aria-label="Chat notes" aria-multiline="true" aria-disabled={disabled}
          contentEditable={!disabled} suppressContentEditableWarning spellCheck
          onInput={changed} onCompositionStart={() => { composing.current = true; compositionCallback.current?.(true); }}
          onCompositionEnd={finishComposition}
          onPaste={(event) => {
            event.preventDefault();
            command('insertText', event.clipboardData.getData('text/plain'));
          }}
          onDrop={(event) => {
            event.preventDefault();
            command('insertText', event.dataTransfer.getData('text/plain'));
          }}
          onClick={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest('a')) {
              event.preventDefault();
            }
            if (target instanceof HTMLInputElement && target.type === 'checkbox') {
              changed();
            }
          }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
              event.preventDefault();
              showLink();
            }
          }}
          className="min-h-[220px] flex-1 overflow-y-auto whitespace-normal break-words p-4 text-sm leading-6 text-ink outline-none [&_p]:my-2 [&_h1]:my-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_pre]:my-2 [&_pre]:whitespace-pre [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-surface-0 [&_pre]:p-3 [&_code]:font-mono [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_input]:mr-1" />}
    </div>
  );
}
