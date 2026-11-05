/**
 * What is left of a write_file call that the reply's output limit cut off.
 *
 * The arguments arrive as JSON that stops partway through the content string. Everything before
 * the cut is what the model meant to write, and on a local model it took minutes to produce.
 * Thrown away, it taught nothing: asked for a GIMP clone, qwen3-coder-next-80b was told twice to
 * write the file in parts, and twice wrote the whole file again — shorter, and still cut off,
 * nine minutes of generation each time.
 */

export interface SalvagedWrite {
  path: string;
  /** The content as far as its last complete line, or all of it when it arrived whole. */
  content: string;
  /** Whether the call asked to append. Null when the flag never arrived. */
  append: boolean | null;
  /** How many lines were kept. */
  lines: number;
  /** The content arrived whole; the cut came after it. */
  complete: boolean;
  /** Set when it was taken for a rewrite of a file that already existed. */
  replaced?: boolean;
}

/** A JSON string literal starting just after its opening quote, and whether it was closed. */
function readLiteral(raw: string, from: number): { text: string; closed: boolean; end: number } {
  let index = from;
  while (index < raw.length) {
    if (raw[index] === '\\') {
      index += 2;
      continue;
    }
    if (raw[index] === '"') return { text: raw.slice(from, index), closed: true, end: index + 1 };
    index += 1;
  }
  return { text: raw.slice(from), closed: false, end: raw.length };
}

/** The longest prefix that ends between escapes: a cut can fall after a backslash or inside \uXXXX. */
function wholeEscapes(literal: string): string {
  let index = 0;
  while (index < literal.length) {
    if (literal[index] !== '\\') {
      index += 1;
      continue;
    }
    const next = literal[index + 1];
    if (next === undefined) break;
    if (next === 'u') {
      if (!/^[0-9a-fA-F]{4}$/.test(literal.slice(index + 2, index + 6))) break;
      index += 6;
    } else {
      index += 2;
    }
  }
  return literal.slice(0, index);
}

const decode = (literal: string): string | null => {
  try {
    return JSON.parse(`"${literal}"`) as string;
  } catch {
    return null;
  }
};

/** The flag as written outside the content, or null when it is not there to read. */
function appendFlag(outside: string): boolean | null {
  const flag = /"append"\s*:\s*(true|false)\b/.exec(outside);
  return flag ? flag[1] === 'true' : null;
}

/**
 * Reads what arrived of a write_file call's arguments. Null unless the path arrived whole and some
 * content after it did too: at least one complete line, or the whole string.
 */
export function salvageWrite(raw: string): SalvagedWrite | null {
  const contentKey = /"content"\s*:\s*"/.exec(raw);
  if (!contentKey) return null;
  const content = readLiteral(raw, contentKey.index + contentKey[0].length);
  // The other keys are read only outside the content, which can contain anything.
  const outside = raw.slice(0, contentKey.index) + (content.closed ? raw.slice(content.end) : '');

  const pathKey = /"path"\s*:\s*"/.exec(outside);
  if (!pathKey) return null;
  const pathLiteral = readLiteral(outside, pathKey.index + pathKey[0].length);
  const path = pathLiteral.closed ? decode(pathLiteral.text)?.trim() : null;
  if (!path) return null;

  const text = decode(content.closed ? content.text : wholeEscapes(content.text));
  if (text === null) return null;
  // Content that arrived whole is kept whole; one cut off loses its unfinished last line.
  const kept = content.closed ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  if (!kept) return null;
  const newlines = kept.split('\n').length - 1;
  return {
    path,
    content: kept,
    append: appendFlag(outside),
    lines: kept.endsWith('\n') ? newlines : newlines + 1,
    complete: content.closed,
  };
}

/**
 * Whether a cut-off write begins the way an existing file does, which makes it a rewrite of that
 * file rather than a part to add to it. qwen3-coder-next-80b writes "append" after "content", so
 * a call cut off in its content never says; twice it was rewriting the whole file from its first
 * line. The first two lines with anything on them must match, or one long first line.
 */
export function startsLike(fileHead: readonly string[], content: string): boolean {
  const filled = (lines: readonly string[]) =>
    lines
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .slice(0, 2);
  const file = filled(fileHead);
  const part = filled(content.split('\n'));
  if (!file.length || !part.length || file[0] !== part[0]) return false;
  if (file.length >= 2 && part.length >= 2) return file[1] === part[1];
  return file[0].trim().length >= 16;
}

/** The lines of a read_file result, without the numbers it puts in front of them. */
export const unnumbered = (text: string): string[] =>
  text.split('\n').flatMap((line) => {
    const match = /^\d+\t(.*)$/.exec(line);
    return match ? [match[1]] : [];
  });

/** A part size that fits: half of what fitted before the cut, in round numbers. */
export const partLines = (keptLines: number): number => Math.max(20, Math.round(keptLines / 2 / 10) * 10);

/** The last lines of what was written, as they are in the file. */
export const tailOf = (content: string, count: number): string[] => content.replace(/\n$/, '').split('\n').slice(-count);

/**
 * The end of what was kept, so the model knows exactly where to carry on. Numbered the way
 * read_file numbers lines when the line numbers are known, which marks them as already written.
 */
export function lastLines(content: string, count = 3, firstNumber?: number): string {
  return tailOf(content, count)
    .map((line) => (line.length > 200 ? `${line.slice(0, 200)}…` : line))
    .map((line, index) => (firstNumber === undefined ? line : `${firstNumber + index}\t${line}`))
    .join('\n');
}

/** How much of a file's end is kept to recognise a next part that starts by repeating it. */
export const SEAM_LINES = 40;

/**
 * How many lines at the start of `content` repeat the end of the file (`tail`).
 *
 * Shown the three lines a cut-off file ended with, qwen3-coder-next-80b began its next part with
 * those very lines, and the file then had its last block header twice and would not compile. A
 * repeat counts when it is at least two lines with something on them, or one long line: a lone
 * closing brace at both ends is more likely meant than repeated.
 */
export function repeatedAtSeam(tail: readonly string[], content: string): number {
  const lines = content.split('\n');
  const same = (a: string, b: string | undefined) => b !== undefined && a.trimEnd() === b.trimEnd();
  for (let count = Math.min(tail.length, lines.length); count >= 1; count -= 1) {
    const end = tail.slice(tail.length - count);
    if (!end.every((line, index) => same(line, lines[index]))) continue;
    const filled = end.filter((line) => line.trim());
    if (filled.length >= 2 || filled.some((line) => line.trim().length >= 24)) return count;
  }
  return 0;
}

const limitOf = (maxTokens?: number) =>
  maxTokens ? `the reply's output limit of ${maxTokens} tokens` : "the reply's output limit";

const lines = (count: number) => `${count} line${count === 1 ? '' : 's'}`;

/** What the model is told once the part of a cut-off write that arrived has been written. */
export function keptReason(salvaged: SalvagedWrite, maxTokens?: number): string {
  const { path, append, complete } = salvaged;
  const one = salvaged.lines === 1;
  const where = append
    ? `${one ? 'was' : 'were'} added to the end of ${path}`
    : `${one ? 'is' : 'are'} now in ${path}${salvaged.replaced ? ', in place of what it held before' : ''}`;
  const kept = complete
    ? `the call was cut off just after its content, which had arrived whole, so Antimatter wrote it: all ${lines(salvaged.lines)} ${where}.`
    : `its content was cut off. Antimatter kept what had arrived: the first ${lines(salvaged.lines)} ${where}, ` +
      'and the unfinished line after them was dropped.';
  // Numbered from the top of the file when this part is the whole file so far.
  const shown = Math.min(3, salvaged.lines);
  const first = append ? undefined : salvaged.lines - shown + 1;
  return [
    `This write_file call reached ${limitOf(maxTokens)}, and ${kept} Do not write the file again from the start. ` +
      `These are its last lines${first === undefined ? '' : ', numbered as read_file numbers them'}, and they are already written:`,
    '```',
    lastLines(salvaged.content, shown, first),
    '```',
    `${complete ? 'If the file has more to come, carry on' : 'Carry on'} with the line that comes after them: call ` +
      `write_file with "path": ${JSON.stringify(path)}, then "append": true, then "content" holding the next part, ` +
      'starting at that next line — do not repeat any line shown above. Keep each part to about ' +
      `${partLines(salvaged.lines)} lines so that it fits in one reply, and append the parts in order until the file ` +
      'is complete.',
  ].join('\n');
}

/** Added to whatever stopped a cut-off write from being written, so the model still learns to split. */
export function notKeptReason(salvaged: SalvagedWrite, maxTokens?: number): string {
  const cut = salvaged.complete
    ? `the call was cut off just after its ${lines(salvaged.lines)} of content`
    : `its content was cut off after ${lines(salvaged.lines)}`;
  return (
    `This call had also reached ${limitOf(maxTokens)}, and ${cut}, so nothing of it was written. A reply cannot ` +
    `hold a file that size: write it in parts of about ${partLines(salvaged.lines)} lines — create the file with ` +
    'write_file, then add each further part with write_file and "append": true.'
  );
}
