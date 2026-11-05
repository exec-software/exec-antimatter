import type { Message } from '../types';

export interface CodeSnippet {
  key: string;
  messageId: string;
  turn: number;
  block: number;
  role: Message['role'];
  time: number | null;
  source: string | null;
  model: string | null;
  language: string;
  info: string;
  code: string;
  complete: boolean;
}

/** Line-based fences preserve indentation and keep a streaming block's identity stable. */
export function collectCodeSnippets(messages: Message[]): CodeSnippet[] {
  return messages.flatMap((message, turn) => {
    const snippets: CodeSnippet[] = [];
    let fence: { marker: string; info: string; lines: string[] } | null = null;
    const emit = (complete: boolean) => {
      if (!fence) return;
      snippets.push({
        key: `${message.id}:${snippets.length}`, messageId: message.id, turn: turn + 1,
        block: snippets.length + 1, role: message.role, time: message.meta?.createdAt ?? null,
        source: message.meta?.sourceName ?? null, model: message.meta?.modelId ?? null,
        language: fence.info.split(/\s+/)[0]?.toLowerCase() || 'text', info: fence.info,
        code: fence.lines.join('\n'), complete,
      });
      fence = null;
    };
    for (const line of message.content.split(/\r?\n/)) {
      if (fence) {
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
        if (closing && closing[1][0] === fence.marker[0] && closing[1].length >= fence.marker.length) emit(true);
        else fence.lines.push(line);
      } else {
        const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
          fence = { marker: opening[1], info: opening[2].trim(), lines: [] };
        }
      }
    }
    emit(false);
    return snippets;
  });
}

export function filterCodeSnippets(snippets: CodeSnippet[], query: string, language: string, assistantName: string) {
  const needle = query.trim().toLocaleLowerCase();
  return snippets.filter((snippet) =>
    (language === 'all' || snippet.language === language) && (!needle || [
      snippet.code, snippet.info, snippet.source, snippet.model,
      snippet.role === 'user' ? 'You' : assistantName,
    ].join(' ').toLocaleLowerCase().includes(needle)));
}

/** A filtered-out selection returns when the filter clears; streamed text never changes its key. */
export function selectedCodeSnippet(snippets: CodeSnippet[], preferredKey: string | null) {
  return snippets.find((snippet) => snippet.key === preferredKey) ?? snippets[0] ?? null;
}
