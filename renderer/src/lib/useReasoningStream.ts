import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The model's thinking, while it is thinking.
 *
 * Kept apart from the transcript for two reasons. It is not the answer — streaming it into the
 * message would put a deliberation in the record as though the model had said it — and there is
 * far more of it than there is answer: a MiMo turn measured here decoded 12,400 tokens to emit
 * about 300. So this lives outside `threads`, is never persisted, and is dropped when the
 * conversation it belongs to is cleared.
 */

/**
 * How often the accumulated thinking is handed to React.
 *
 * Every arriving fragment is appended to a buffer, which is cheap; re-rendering on each one is
 * not. At 16 tok/s a frame arrives roughly every 60ms, and a 12,000-token turn would otherwise
 * be 12,000 renders, each rebuilding a string that ends up tens of kilobytes long. Six updates a
 * second is past the point where more would read as smoother.
 */
const FLUSH_MS = 160;

/**
 * Characters per token, for a label that says "about".
 *
 * The main process plans the real budget with the same ratio (see context.ts); this only has to
 * put a number next to a spinner, and is shown with a `~` because nothing here has a tokenizer.
 */
const CHARS_PER_TOKEN = 3.2;

/**
 * How many turns' thinking to keep.
 *
 * A session's deliberation is larger than its transcript — 195,000 tokens against 6,700 of
 * visible output, on the turn that prompted this — so holding all of it would grow without
 * limit for something almost nobody scrolls back to. Past this the count remains, which is what
 * a turn from an hour ago needs to say, and is also all it would have after a reload.
 */
const KEEP_TURNS = 8;

export const estimateReasoningTokens = (text: string): number => Math.round(text.length / CHARS_PER_TOKEN);

export interface ReasoningStream {
  /** What the model has thought so far on this message, or '' if it has not thought aloud. */
  read(messageId: string): string;
  /** Appends an arriving fragment. Safe to call at stream rate. */
  append(messageId: string, chunk: string): void;
  /** The whole thought, for the turn that has just ended, before it is forgotten. */
  take(messageId: string): string;
}

export function useReasoningStream(): ReasoningStream {
  // The buffer is the truth and `flushed` is a snapshot of it, so a render that arrives between
  // flushes shows slightly less than has arrived rather than nothing at all.
  const buffer = useRef(new Map<string, string>());
  const pending = useRef(false);
  const [flushed, setFlushed] = useState<Record<string, string>>({});

  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const append = useCallback((messageId: string, chunk: string) => {
    if (!chunk) return;
    const known = buffer.current.get(messageId);
    // A Map iterates in insertion order, so the first key is the oldest turn still held.
    if (known === undefined) {
      while (buffer.current.size >= KEEP_TURNS) {
        const oldest = buffer.current.keys().next().value;
        if (oldest === undefined) break;
        buffer.current.delete(oldest);
      }
    }
    buffer.current.set(messageId, `${known ?? ''}${chunk}`);
    if (pending.current) return;
    pending.current = true;
    timer.current = window.setTimeout(() => {
      pending.current = false;
      timer.current = null;
      setFlushed(Object.fromEntries(buffer.current));
    }, FLUSH_MS);
  }, []);

  const read = useCallback((messageId: string) => flushed[messageId] ?? '', [flushed]);

  // Reads the buffer rather than the snapshot: the last fragments of a turn usually arrive
  // inside the final flush window, and the count this feeds is the durable one.
  const take = useCallback((messageId: string) => buffer.current.get(messageId) ?? '', []);

  return { read, append, take };
}
