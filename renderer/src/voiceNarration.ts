/** Only answer-channel assistant prose belongs in playback. Never pass reasoning or tool output. */
export interface VoiceNarrationInput {
  messageId: string;
  role: string;
  content: string;
  streaming: boolean;
  failed?: boolean;
  channel?: 'commentary' | 'final' | 'analysis' | 'reasoning';
  tools?: readonly { contentOffset?: number; status?: string; awaitingApproval?: boolean }[];
}

export interface VoiceNarrationUtterance {
  id: string;
  messageId: string;
  kind: 'commentary' | 'final';
  text: string;
}

export interface VoiceNarrationState {
  messageId: string;
  /** Bounded, assistant-answer-only prefix used to detect transcript rewrites. */
  source: string;
  consumedOffset: number;
  commentaryCount: number;
  spoken: readonly string[];
  /** Sentences already flushed mid-stream, budgeted separately from tool commentary. */
  flushCount: number;
  finalEmitted: boolean;
  suppressed: boolean;
}

export interface VoiceNarrationUpdate {
  state: VoiceNarrationState;
  utterances: VoiceNarrationUtterance[];
}

const MAX_SOURCE = 128 * 1024;
const COMMENTARY_LIMIT = 240;
const FINAL_LIMIT = 480;
const MAX_COMMENTARY = 4;
/**
 * Sentence flushes get their own budget. They are not tool commentary and must not exhaust
 * MAX_COMMENTARY, or a long spoken reply would fall silent after four sentences and only
 * resume at completion — the exact stall this flushing exists to remove.
 */
const MAX_STREAM_FLUSH = 24;
const blank = (text: string): string => text.replace(/[^\r\n]/g, ' ');

/** Mask rather than delete so offsets remain the original UTF-16 stream coordinates. */
function proseMask(content: string): string {
  let masked = content;
  let fence: { mark: string; size: number } | null = null;
  masked = masked.split(/(?<=\n)/).map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.mark && marker[1].length >= fence.size) fence = null;
      return blank(line);
    }
    if (marker) {
      fence = { mark: marker[1][0], size: marker[1].length };
      return blank(line);
    }
    // Indented code, shell transcripts, diffs, markdown tables and obvious source lines.
    if (/^(?: {4}|\t|\s*(?:\$ |>>> |diff --git |@@ |[+-]{3} |[+-](?=\S)|\|))/.test(line) ||
        /^\s*(?:import |export |const |let |var |function |class |def |return |sudo |[{}\[\]]\s*$)/.test(line)) return blank(line);
    return line;
  }).join('');
  // An unterminated reasoning or executable markup block hides everything after its opener.
  for (const tag of ['think', 'analysis', 'reasoning', 'script', 'style', 'pre', 'code']) {
    masked = masked.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi'), blank);
    // Some providers omit the opening reasoning tag. A remaining closer makes that prefix
    // ambiguous, so discard it rather than speaking deliberation as an answer.
    masked = masked.replace(new RegExp(`^[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), blank);
  }
  masked = masked.replace(/<!--[\s\S]*?(?:-->|$)/g, blank);
  // Inline code is excluded too; an unmatched opener hides the remainder of its line.
  masked = masked.replace(/(`+)[^\n]*?(?:\1|(?=\n|$))/g, blank);
  return masked;
}

/** Deterministic local extraction, not an inference summary. Bounds include the ellipsis. */
export function speakableAssistantText(content: string, maximum = FINAL_LIMIT): string {
  if (typeof content !== 'string' || content.length > MAX_SOURCE) return '';
  return compactProse(proseMask(content), maximum);
}

function compactProse(masked: string, maximum: number): string {
  const limit = Number.isFinite(maximum) ? Math.max(0, Math.min(FINAL_LIMIT, Math.floor(maximum))) : FINAL_LIMIT;
  if (limit < 8) return '';
  let text = masked
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/gm, '')
    .replace(/\[\d+\]/g, '')
    .replace(/[*_~]+/g, '')
    .replace(/&(?:lt|gt|quot|apos|amp);/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return '';
  // Speak at most two sentences from a span, not a long final answer or checklist.
  const boundaries = /[.!?]+(?:["”’']+)?(?=\s|$)/g;
  let sentenceCount = 0;
  let boundary: RegExpExecArray | null;
  while ((boundary = boundaries.exec(text))) {
    sentenceCount += 1;
    if (sentenceCount === 2) { text = text.slice(0, boundary.index + boundary[0].length); break; }
  }
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit - 1);
  const lastSpace = prefix.lastIndexOf(' ');
  return `${(lastSpace > limit / 2 ? prefix.slice(0, lastSpace) : prefix).trimEnd()}…`;
}

/**
 * A streaming boundary needs following whitespace: a token ending in "3." may become "3.5"
 * on the next delta. Leave the very last token for another delta or the completion pass.
 */
function firstSentenceEnd(text: string): number {
  const boundaries = /[.!?\u2026]["')\]]*(?=\s)/g;
  let match: RegExpExecArray | null;
  while ((match = boundaries.exec(text))) {
    const prefix = text.slice(0, match.index + 1);
    if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)\.$/i.test(prefix) || /\b(?:[A-Za-z]\.)+$/.test(prefix)) continue;
    return match.index + match[0].length;
  }
  return -1;
}

/** A long sentence can start speaking at a clause or word boundary without dropping its tail. */
function streamingEnd(text: string): number {
  // URLs, Markdown link targets and unfinished markup are not stable prose yet. Their raw
  // punctuation must not become a spoken chunk before compactProse can remove them in full.
  const unstable = /(?:!?\[[^\]\n]*(?:\]\([^)]*)?|<[^>\n]*|https?:\/\/\S*|www\.\S*)$/.exec(text);
  const stable = unstable ? text.slice(0, unstable.index) : text;
  const sentence = firstSentenceEnd(stable);
  if (sentence >= 0 && stable.slice(0, sentence).trim().length <= COMMENTARY_LIMIT) return sentence;
  const clause = /[,;:](?=\s)|\s[—–]\s/g;
  let match: RegExpExecArray | null;
  while ((match = clause.exec(stable))) {
    const end = match.index + match[0].length;
    const length = stable.slice(0, end).trim().length;
    if (length >= 70 && length <= 180) return end;
  }
  if (stable.trim().length < 180) return -1;
  // Trim only for measuring. Original offsets still account for masked code and whitespace.
  const leading = stable.length - stable.trimStart().length;
  const prefix = stable.slice(leading, leading + 181);
  const boundary = prefix.lastIndexOf(' ');
  return boundary >= 70 ? leading + boundary + 1 : -1;
}

function fresh(messageId: string): VoiceNarrationState {
  return { messageId, source: '', consumedOffset: 0, commentaryCount: 0, spoken: [], flushCount: 0, finalEmitted: false, suppressed: false };
}

/**
 * Feed only the current voice-session response, never the loaded conversation history. Keep the
 * returned state even when playback is interrupted: cancelling speech must not replay old text.
 * Tool anchors, complete sentences and bounded clauses release answer prose during streaming.
 */
export function nextVoiceNarration(previous: VoiceNarrationState | undefined, input: VoiceNarrationInput): VoiceNarrationUpdate {
  let state = previous?.messageId === input.messageId ? { ...previous } : fresh(input.messageId);
  const utterances: VoiceNarrationUtterance[] = [];
  if (input.role !== 'assistant' || input.channel === 'analysis' || input.channel === 'reasoning') return { state, utterances };
  if (state.suppressed || state.finalEmitted) return { state, utterances };
  if (input.failed || input.content.length > MAX_SOURCE) return { state: { ...state, suppressed: true }, utterances };
  if (!input.content.startsWith(state.source)) {
    // Once spoken, revised text cannot safely be reconciled with what the person already heard.
    if (state.spoken.length) return { state: { ...state, suppressed: true }, utterances };
    state = fresh(input.messageId);
  }
  state.source = input.content;
  const masked = proseMask(input.content);
  const offsets = [...new Set((input.tools ?? []).map((tool) => tool.contentOffset).filter((offset): offset is number =>
    typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 && offset <= input.content.length,
  ))].sort((a, b) => a - b);

  const emit = (kind: VoiceNarrationUtterance['kind'], start: number, end: number, raw: string, tally = true): boolean => {
    // Mask once over the full source: code/reasoning spans may cross an event boundary.
    const text = compactProse(raw, kind === 'commentary' ? COMMENTARY_LIMIT : FINAL_LIMIT);
    const key = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!text || state.spoken.includes(key)) return false;
    utterances.push({ id: `${input.messageId}:voice:${kind}:${start}:${end}`, messageId: input.messageId, kind, text });
    state.spoken = [...state.spoken, key];
    if (kind === 'commentary' && tally) state.commentaryCount += 1;
    return true;
  };

  if (input.streaming) {
    for (const offset of offsets) {
      if (offset <= state.consumedOffset) continue;
      if (state.commentaryCount < MAX_COMMENTARY) emit('commentary', state.consumedOffset, offset, masked.slice(state.consumedOffset, offset));
      state.consumedOffset = offset;
    }
    // A tool anchor used to be the only thing that released speech mid-stream, so a reply
    // that called no tools said nothing at all until it was finished. Finished sentences
    // are a boundary too: the text before a terminator is complete and will not be rewritten
    // by the rest of this delta, which is what makes it safe to speak now rather than later.
    while ((state.flushCount ?? 0) < MAX_STREAM_FLUSH) {
      const pending = masked.slice(state.consumedOffset);
      const end = streamingEnd(pending);
      if (end < 0) break;
      if (emit('commentary', state.consumedOffset, state.consumedOffset + end, pending.slice(0, end), false)) {
        state.flushCount = (state.flushCount ?? 0) + 1;
      }
      // Advance even when nothing was emitted: a masked span is code or reasoning, and
      // re-examining it every delta would spin without ever making progress.
      state.consumedOffset += end;
    }
  } else {
    // A separately delivered pending tool/approval means completion has not been confirmed.
    if ((input.tools ?? []).some((tool) => tool.awaitingApproval || tool.status === 'pending' || tool.status === 'running')) return { state, utterances };
    const start = Math.max(state.consumedOffset, offsets[offsets.length - 1] ?? 0);
    let tail = masked.slice(start);
    if ((input.tools?.length ?? 0) > 0 && !offsets.length) {
      // Legacy tool rows have no trustworthy boundary. Prefer the last prose paragraph.
      const paragraphs = tail.split(/\n\s*\n/).filter((part) => part.trim());
      tail = paragraphs[paragraphs.length - 1] ?? '';
    }
    emit('final', start, input.content.length, tail);
    state.finalEmitted = true;
    state.consumedOffset = input.content.length;
  }
  return { state, utterances };
}
