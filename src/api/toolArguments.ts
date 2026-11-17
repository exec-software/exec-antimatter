import type { ToolCall } from './types';

export type InvalidToolArgumentReason = 'invalid_json' | 'output_limit';

/** Private transport argument understood only by Antimatter's bundled write_file implementation. */
export const CREATE_ONLY_TOOL_ARGUMENT = '_antimatter_create_only';

/**
 * Which turn is calling, carried to the bundled tools that need to know.
 *
 * Two features depend on it. Local file history joins a stored version back to the carbon that
 * explains it, and the whiteboard records which turn put an object on the board and marks it as
 * the model's rather than the person's.
 *
 * An argument rather than an environment variable because the tool server is long-lived and
 * shared: the turn changes on every call, the process does not. Stripped before anything records
 * or replays the call, exactly as the create-only flag is.
 */
export const TURN_CONTEXT_TOOL_ARGUMENT = '_antimatter_turn';

export interface TurnToolContext {
  thread?: string;
  turn?: string;
  /** The delegated agent, when one is running rather than the conversation itself. */
  actor?: string;
  /** The model answering, so a board can record which one put an object down. */
  model?: string;
}

/** Function-call arguments are always one JSON object, never a scalar, array, or null. */
export function isToolArgumentObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Tool-call arguments are replayed as JSON on every later request. Keeping a truncated fragment
 * there makes an otherwise recovered turn poison its history forever, so invalid text is replaced
 * with a small, explicit JSON sentinel. The original call's result still contains the useful
 * error or salvage explanation.
 */
export function normalizedToolArguments(
  raw: string,
  reason: InvalidToolArgumentReason = 'invalid_json'
): string {
  const candidate = raw.trim() || '{}';
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (isToolArgumentObject(parsed)) return candidate;
  } catch {
    // The sentinel below is also used for valid JSON whose top level is not an argument object.
  }
  return JSON.stringify({
    _antimatter: {
      invalidToolArguments: true,
      reason,
      originalCharacters: raw.length,
    },
  });
}

/** A history-safe copy; the raw call remains available to the executor for salvage. */
export function toolCallForHistory(call: ToolCall, reason?: InvalidToolArgumentReason): ToolCall {
  const args = normalizedToolArguments(call.function.arguments, reason);
  return args === call.function.arguments
    ? call
    : { ...call, function: { ...call.function, arguments: args } };
}

/**
 * The most tool calls one reply may ask for when nothing model-specific says otherwise.
 *
 * Rounds were bounded; a single round was not. An assistant message and the results answering it
 * are one protocol group — an orphaned `role: tool` message is invalid on most servers — so the
 * rolling window can only move whole groups, and the newest group is mandatory because dropping
 * it would answer the wrong turn. A reply carrying enough calls therefore builds a group larger
 * than the window, which nothing downstream can compact: the fit drops everything it is allowed
 * to and still overflows.
 *
 * Observed rather than theorised. One reply spent thirty-four minutes emitting 1,363 `read_file`
 * calls; their results came to roughly 899k tokens in a single group against a 131k window, and
 * the turn died on the server's own 400 with compaction having worked exactly as designed.
 *
 * The remainder is not lost work — the model is told its batch was cut and asks again on the next
 * round, which is a boundary the window can actually move at.
 */
export const DEFAULT_MAX_TOOL_CALLS = 32;

/**
 * The widest a cap may be set to.
 *
 * Not a guess about models: it is the point past which the cap stops protecting anything, since
 * a group this size already exceeds what a 128k window can hold once the results arrive. An
 * override above it is a request for the failure the cap exists to prevent.
 */
export const MAX_TOOL_CALL_CAP = 128;

/** Reads a configured cap, falling back to the default and refusing a nonsensical one. */
export function toolCallCap(configured?: number | null): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 1) {
    return DEFAULT_MAX_TOOL_CALLS;
  }
  return Math.min(MAX_TOOL_CALL_CAP, Math.trunc(configured));
}
