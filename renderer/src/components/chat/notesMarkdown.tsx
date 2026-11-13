import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

/** Raw HTML is editable text, never a DOM fragment or a network request. */
function literalHtml() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode): void => {
      if (node.type === 'html') {
        node.type = /^<br\s*\/?>$/i.test(node.value?.trim() ?? '') ? 'break' : 'text';
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export function notesMarkdownHtml(markdown: string): string {
  return renderToStaticMarkup(
    <Markdown remarkPlugins={[remarkGfm, literalHtml]} urlTransform={(url) => url}
      components={{
        // A note never contacts a URL merely because its editor was opened. Link destinations
        // stay inert data while editing, including when pasted through Markdown source mode.
        a: ({ href, title, children }) => <span data-note-link={href ?? ''} data-note-link-title={title}
          className="text-primary underline" title={href}>{children}</span>,
        img: ({ src, alt, title }) => <span data-note-image={src ?? ''} data-note-image-alt={alt ?? ''}
          data-note-image-title={title} contentEditable={false} className="rounded bg-surface-3 px-1 text-ink-2">
          Image: {alt || src || 'Untitled'}
        </span>,
        input: ({ checked }) => <input type="checkbox" defaultChecked={checked} aria-label="Task complete" />,
      }}>
      {markdown}
    </Markdown>
  ).replace(/<br\/>\n/g, '<br/>');
}

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([`*_{}\[\]<>#|])/g, '\\$1')
    .replace(/^([ \t]*)([+-]|\d+[.)])(?=\s)/gm, '$1\\$2');
}

function destination(value: string): string {
  return `<${value.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\r|\n/g, '')}>`;
}

function titleSuffix(title: string | null): string {
  return title ? ` "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"` : '';
}

function codeSpan(value: string): string {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const padding = value.startsWith('`') || value.endsWith('`') || (/^ .* $/.test(value) && /[^ ]/.test(value)) ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
}

function emphasis(content: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content)!;
  return match[2] ? `${match[1]}${marker}${match[2]}${marker}${match[3]}` : content;
}

const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR']);

/** Serialize only Markdown's known structure, ignoring pasted browser styling and attributes. */
export function notesDocumentMarkdown(root: HTMLElement): string {
  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeText((node.textContent ?? '').replace(/\u00a0/g, ' '));
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }
    const element = node as HTMLElement;
    const tag = element.tagName;
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'IMG'].includes(tag)) {
      return '';
    }
    if (element.hasAttribute('data-note-image')) {
      return `![${escapeText(element.getAttribute('data-note-image-alt') ?? '')}](${destination(element.getAttribute('data-note-image') ?? '')}${titleSuffix(element.getAttribute('data-note-image-title'))})`;
    }
    const content = [...element.childNodes].map(inline).join('');
    if (tag === 'B' || tag === 'STRONG') {
      return emphasis(content, '**');
    }
    if (tag === 'I' || tag === 'EM') {
      return emphasis(content, '*');
    }
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') {
      return emphasis(content, '~~');
    }
    if (tag === 'CODE') {
      return codeSpan(element.textContent ?? '');
    }
    if (tag === 'BR') {
      return '  \n';
    }
    if (tag === 'INPUT') {
      return (element as HTMLInputElement).type === 'checkbox' ? `[${(element as HTMLInputElement).checked ? 'x' : ' '}] ` : '';
    }
    if (tag === 'A' || element.hasAttribute('data-note-link')) {
      const href = element.getAttribute('data-note-link') ?? element.getAttribute('href') ?? '';
      const title = element.hasAttribute('data-note-link') ? element.getAttribute('data-note-link-title') : element.getAttribute('title');
      return `[${content}](${destination(href)}${titleSuffix(title)})`;
    }
    if (BLOCK.has(tag)) {
      return `\n\n${block(element)}\n\n`;
    }
    return content;
  };

  const children = (element: Element): string => [...element.childNodes].map(inline).join('');
  const block = (element: HTMLElement): string => {
    const tag = element.tagName;
    if (tag === 'PRE') {
      const code = element.querySelector('code');
      const text = (code ?? element).textContent ?? '';
      const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
      const fence = '`'.repeat(longest + 1);
      const language = /(?:^|\s)language-([^\s]+)/.exec(code?.className ?? '')?.[1] ?? '';
      // Protect blank code lines from prose whitespace normalization. NUL is rejected by
      // the note store, so this marker cannot collide with saved note content.
      const content = text.replace(/\n$/, '').split('\n').map((line) => line || '\0').join('\n');
      return `${fence}${language}\n${content}\n${fence}`;
    }
    if (tag === 'UL' || tag === 'OL') {
      const start = Number(element.getAttribute('start')) || 1;
      const items = [...element.children].filter((child) => child.tagName === 'LI');
      const loose = items.some((item) => [...item.children].some((child) => child.tagName === 'P'));
      return items.map((item, index) => {
        const marker = tag === 'OL' ? `${start + index}. ` : '- ';
        let body = '';
        for (const child of item.childNodes) {
          if (child.nodeType === Node.ELEMENT_NODE && ['UL', 'OL'].includes((child as HTMLElement).tagName)) {
            body = body.replace(/\n+$/, '') + '\n' + block(child as HTMLElement);
          } else {
            body += inline(child);
          }
        }
        body = body.trim().replace(/\n{3,}/g, '\n\n').replace(/^(\[[ x]\])\s+/, '$1 ');
        return marker + body.replace(/\n/g, `\n${' '.repeat(marker.length)}`);
      }).join(loose ? '\n\n' : '\n');
    }
    if (tag === 'BLOCKQUOTE') {
      return children(element).trim().replace(/\n{3,}/g, '\n\n').split('\n').map((line) => `> ${line}`).join('\n');
    }
    if (tag === 'HR') {
      return '---';
    }
    if (tag === 'TABLE') {
      const rows = [...element.querySelectorAll('tr')].filter((row) => row.closest('table') === element);
      if (!rows.length) {
        return '';
      }
      const width = Math.max(...rows.map((row) => row.children.length));
      const rowText = (row: HTMLTableRowElement): string => {
        const cells = [...row.children].map((cell) => children(cell).trim().replace(/ *\n/g, '<br>')
          .replace(/(\\*)\|/g, (match, escapes: string) => escapes.length % 2 ? match : `\\${match}`));
        while (cells.length < width) {
          cells.push('');
        }
        return `| ${cells.join(' | ')} |`;
      };
      const align = Array.from({ length: width }, (_, index) => {
        const alignment = (rows[0].children[index] as HTMLElement | undefined)?.style.textAlign;
        return alignment === 'center' ? ':---:' : alignment === 'right' ? '---:' : alignment === 'left' ? ':---' : '---';
      });
      return [rowText(rows[0]), `| ${align.join(' | ')} |`, ...rows.slice(1).map(rowText)].join('\n');
    }
    const content = children(element).replace(/\n{3,}/g, '\n\n').trim();
    if (/^H[1-6]$/.test(tag)) {
      return `${'#'.repeat(Number(tag[1]))} ${content}`;
    }
    return content;
  };

  const result = [...root.childNodes].map((node) => {
    if (node.nodeType === Node.ELEMENT_NODE && BLOCK.has((node as HTMLElement).tagName)) {
      return `\n\n${block(node as HTMLElement)}\n\n`;
    }
    return inline(node);
  }).join('');
  return result.replace(/\n{3,}/g, '\n\n').trim().replace(/\0/g, '');
}
