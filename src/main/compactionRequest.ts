import type { ChatRequest, Message, ToolCall } from '../api/types';
import { CHARS_PER_TOKEN, estimateTokens, messageTokens } from '../api/tokenEstimate';
import { isCompactionNotice } from './context';
import type { ModelProfile } from './modelProfiles';

const INSTRUCTION = 'Summarize this earlier part of a conversation so it can replace the original and ' +
  'still be worked from. Keep decisions, file names, identifiers, and anything left ' +
  'unfinished. Drop pleasantries. Write prose, no preamble.\n\n';

/**
 * How much of one tool call's arguments is worth keeping.
 *
 * The instruction asks for file names and identifiers, and in a tool call those live in the
 * arguments — usually first, because a path is the first field of almost every call this app
 * makes. What follows can be a whole file, so a write_file would otherwise spend the entire
 * allowance on one call and push the rest of the session out.
 */
const ARGUMENT_CHARS = 240;

/**
 * How much of one tool result is worth keeping.
 *
 * Tool output is the bulk of a working session and the least dense part of it per character. Left
 * whole, a hundred results fill the allowance and the head/tail slice below keeps only the first
 * and last few, which is how a week of work comes back as "build artifacts present" — the two
 * things that happened to sit at the ends. Capped, every call in the fold is represented.
 */
const RESULT_CHARS = 600;

/** Transcript the summarizer is shown, bounded by the model's window rather than by this. */
const MAX_TRANSCRIPT_CHARS = 48_000;

/** A summary long enough for a short fold, and for a long one. */
const SUMMARY_FLOOR = 512;
const SUMMARY_CEILING = 2048;

/** Tool results name the call they answer, which is where the path or command is. */
const describe = (call: ToolCall): string => {
  const args = call.function.arguments.trim();
  return `${call.function.name}(${args.length > ARGUMENT_CHARS ? `${args.slice(0, ARGUMENT_CHARS)}…` : args})`;
};

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}\n[…${text.length - limit} more characters…]` : text;

/**
 * How one message reads to the summarizing model.
 *
 * An assistant turn that called a tool carries no prose at all: its content is empty and the work
 * is in `toolCalls`. Serializing content alone turned every such turn into a bare "assistant:"
 * line, so a session of reads, edits and builds reached the summarizer as a run of blank lines
 * followed by unattributed output — the one thing the instruction asks to keep, file names, was
 * in the arguments it never saw. In carbon 78eb0d98 a 237-message indexing session folded to two
 * paragraphs about build artifacts, and the model then spent eight turns narrating plans against
 * invented file names instead of calling a tool, because nothing in its history showed it ever
 * had.
 */
function transcribe(message: Message, names: ReadonlyMap<string, string>): string {
  if (message.role === 'tool') {
    const name = message.toolCallId ? names.get(message.toolCallId) : undefined;
    return `${name ?? 'tool'} result: ${clip(message.content, RESULT_CHARS)}`;
  }
  const calls = message.toolCalls ?? [];
  if (!calls.length) return `${message.role}: ${message.content}`;
  const prose = message.content.trim();
  return [`${message.role}:`, ...(prose ? [prose] : []), ...calls.map((call) => `calls ${describe(call)}`)].join('\n');
}

/** A handoff summary must itself fit the destination model, including its reply reservation. */
export function compactionRequest(profile: ModelProfile, dropped: readonly Message[]): ChatRequest | undefined {
  const window = Math.min(profile.contextTokens, profile.maxEvaluatedTokens ?? Infinity);
  // Reserved at the ceiling so the request still fits whatever length the fold turns out to
  // warrant, which is only known once the transcript is built.
  const reply = Math.min(SUMMARY_CEILING, profile.maxOutputTokens, Math.floor(window / 4));
  const budget = Math.max(0, Math.floor((window - reply) * 0.9));
  const allowance = Math.min(MAX_TRANSCRIPT_CHARS, Math.floor((budget - 4) * CHARS_PER_TOKEN) - INSTRUCTION.length);
  if (reply < 1 || allowance < 80) return undefined;
  // Retain previous summaries before bulky tool results, then bound the material to the new
  // window. Keep both ends of oversized material so unfinished recent work survives the handoff.
  const prioritized = [...dropped.filter(isCompactionNotice), ...dropped.filter((message) => !isCompactionNotice(message))];
  const names = new Map<string, string>();
  for (const message of dropped) {
    for (const call of message.toolCalls ?? []) names.set(call.id, call.function.name);
  }
  let transcript = prioritized.map((message) => transcribe(message, names)).join('\n\n');
  if (!transcript.trim()) return undefined;
  if (transcript.length > allowance) {
    const gap = '\n[…earlier material omitted…]\n';
    const head = Math.floor((allowance - gap.length) * 0.6);
    transcript = transcript.slice(0, head) + gap + transcript.slice(-(allowance - gap.length - head));
  }
  const message: Message = { id: 'compaction', role: 'user', content: INSTRUCTION + transcript };
  if (messageTokens(message) > budget) return undefined;
  // A three-message fold needs a sentence; a two-hundred-message one needs a page. A flat cap
  // here is what compressed four days of work into 786 characters.
  const maxTokens = Math.min(reply, Math.max(SUMMARY_FLOOR, Math.ceil(estimateTokens(transcript) / 6)));
  return { messages: [message], model: profile.modelId, providerId: '', maxTokens, useTools: false };
}
