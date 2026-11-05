import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  return (
    <div className="my-3 overflow-hidden rounded-md border border-line-soft bg-surface-0 first:mt-0 last:mb-0">
      <div className="flex items-center justify-between border-b border-line-soft bg-surface-2 px-3 py-1.5 text-[11px] text-ink-3">
        <span>{language || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy code"
          className="flex items-center gap-1 rounded px-1 py-0.5 text-ink-2 transition hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
        >
          {copied ? <Check size={12} className="text-accent" /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre tabIndex={0} className="max-h-[32rem] overflow-auto p-3 font-mono text-xs leading-5 text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70">
        <code>{code}</code>
      </pre>
    </div>
  );
}
