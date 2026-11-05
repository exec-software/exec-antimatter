export type TextSegment = { kind: 'text'; text: string };
export type CodeSegment = { kind: 'code'; language: string; code: string };
export type Segment = TextSegment | CodeSegment;

const FENCE = '`'.repeat(3);

/** Splits a message on code fences; an unterminated trailing fence (mid-stream) still counts as code. */
export function parseSegments(content: string): Segment[] {
  return content.split(FENCE).map((part, index): Segment => {
    if (index % 2 === 0) return { kind: 'text', text: part };
    const [language, ...codeLines] = part.split('\n');
    return { kind: 'code', language: language.trim(), code: codeLines.join('\n').trim() };
  });
}

export const codeSegments = (content: string) =>
  parseSegments(content).filter((segment): segment is CodeSegment => segment.kind === 'code');

interface FenceState {
  marker: string;
  info: string;
}

const openingFence = (line: string): FenceState | null => {
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
  if (!match) return null;
  return { marker: match[1], info: match[2].trim() };
};

const closesFence = (line: string, state: FenceState): boolean => {
  const character = state.marker[0];
  const match = new RegExp(`^ {0,3}(${character === '`' ? '`' : '~'}{${state.marker.length},})[ \\t]*$`).exec(line);
  return Boolean(match);
};

/** Returns the open fenced-code block at a UTF-16 offset, if the offset is inside one. */
function fenceAtOffset(content: string, offset: number): FenceState | null {
  const boundary = Math.max(0, Math.min(content.length, offset));
  const lines = content.slice(0, boundary).split(/\r?\n/);
  let state: FenceState | null = null;

  for (const line of lines) {
    if (state) {
      if (closesFence(line, state)) state = null;
    } else {
      state = openingFence(line);
    }
  }
  return state;
}

/**
 * Makes an independently rendered transcript slice valid Markdown without exposing synthetic
 * fence markers. A model can request a tool between two chunks of the same code fence; wrapping
 * each side with the active fence keeps both chunks code while the action stays between them.
 */
export function prepareMarkdownFragment(content: string, start: number, end: number): string {
  const safeStart = Math.max(0, Math.min(content.length, Math.trunc(start)));
  const safeEnd = Math.max(safeStart, Math.min(content.length, Math.trunc(end)));
  const startsInside = fenceAtOffset(content, safeStart);
  const endsInside = fenceAtOffset(content, safeEnd);
  let fragment = content.slice(safeStart, safeEnd);

  if (startsInside) {
    fragment = `${startsInside.marker}${startsInside.info}\n${fragment}`;
  }
  if (endsInside) {
    const separator = fragment.endsWith('\n') ? '' : '\n';
    fragment = `${fragment}${separator}${endsInside.marker}`;
  }
  return fragment;
}
