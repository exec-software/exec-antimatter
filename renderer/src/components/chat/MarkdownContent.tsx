import { Children, isValidElement, memo, type ReactElement, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { prepareMarkdownFragment } from '../../lib/markdown';
import { CodeBlock } from '../CodeBlock';
import { useConversationUi } from './conversationUi';

interface Props {
  content: string;
  /** Offsets into the complete assistant response, used to preserve fenced-code state across actions. */
  start?: number;
  end?: number;
  fullContent?: string;
  /** Muted is for the working notes folded above an answer, which are read second if at all. */
  tone?: 'default' | 'muted';
}

type CodeChild = ReactElement<{ className?: string; children?: ReactNode }>;

const codeFromPre = (children: ReactNode): { code: string; language: string } | null => {
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  if (!isValidElement(child)) return null;

  const codeChild = child as CodeChild;
  const language = /language-([^\s]+)/.exec(codeChild.props.className ?? '')?.[1] ?? '';
  return {
    code: String(codeChild.props.children ?? '').replace(/\n$/, ''),
    language,
  };
};

/** CommonMark/GFM prose with the restrained hierarchy used by the transcript. */
export function MarkdownContent(props: Props) {
  const { importedHistory } = useConversationUi();
  return <MarkdownDocument {...props} importedHistory={Boolean(importedHistory)} />;
}

// Context changes can reach this child even when its message is memoized. Parse only new prose
// or a changed import policy; the policy must still suppress images when viewing imported text.
const MarkdownDocument = memo(function MarkdownDocument({ content, start = 0, end = content.length, fullContent = content, tone = 'default', importedHistory,
}: Props & { importedHistory: boolean }) {
  const markdown = prepareMarkdownFragment(fullContent, start, end);

  return (
    <div
      // `font-chat-surface` carries the configured reading face and size. The muted tone keeps
      // its own `text-sm`, which sits in Tailwind's utilities layer and so still wins over it:
      // a subagent's aside should stay smaller than the answer it belongs to.
      className={`font-chat-surface min-w-0 break-words ${tone === 'muted' ? 'text-sm leading-6 text-ink-2' : 'leading-7 text-ink'}`}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          ...(importedHistory ? { img: ({ alt }: { alt?: string }) => <span className="text-xs text-ink-3">[Imported image{alt ? `: ${alt}` : ''} · not loaded]</span> } : {}),
          p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="mb-3 mt-6 text-xl font-semibold leading-7 text-ink first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-5 text-lg font-semibold leading-7 text-ink first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-4 text-base font-semibold leading-6 text-ink first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1.5 mt-4 text-sm font-semibold uppercase tracking-wide text-ink first:mt-0">
              {children}
            </h4>
          ),
          ul: ({ children }) => (
            <ul className="my-3 list-disc space-y-1 pl-5 marker:text-ink-3 first:mt-0 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 list-decimal space-y-1 pl-5 marker:text-ink-3 first:mt-0 last:mb-0">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-line pl-4 text-ink-2 first:mt-0 last:mb-0">
              {children}
            </blockquote>
          ),
          strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
          em: ({ children }) => <em className="text-ink">{children}</em>,
          del: ({ children }) => <del className="text-ink-3">{children}</del>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary-strong underline decoration-primary/40 underline-offset-2 hover:decoration-primary-strong focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              {children}
            </a>
          ),
          code: ({ children, className }) => (
            <code className={`${className ?? ''} rounded bg-surface-0 px-1.5 py-0.5 font-mono text-[0.88em] text-ink`}>
              {children}
            </code>
          ),
          pre: ({ children }) => {
            const block = codeFromPre(children);
            return block ? <CodeBlock code={block.code} language={block.language} /> : <pre>{children}</pre>;
          },
          hr: () => <hr className="my-5 border-line" />,
          table: ({ children }) => (
            <div className="my-4 max-w-full overflow-x-auto rounded-md border border-line-soft">
              <table className="w-full border-collapse text-left text-[13px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-surface-2 text-ink">{children}</thead>,
          th: ({ children }) => <th className="border-b border-line px-3 py-2 font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-b border-line-soft px-3 py-2 align-top">{children}</td>,
          input: (props) => (
            <input {...props} disabled className="mr-1.5 translate-y-px accent-primary" aria-label="Task status" />
          ),
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
});
