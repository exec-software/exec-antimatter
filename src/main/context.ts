import type { Message, ToolDefinition } from '../api/types';
import { conversationTokens, messageTokens, toolDefinitionTokens } from '../api/tokenEstimate';
import type { ModelProfile } from './modelProfiles';

export { CHARS_PER_TOKEN, estimateTokens, messageTokens, conversationTokens, toolDefinitionTokens } from '../api/tokenEstimate';

/**
 * Keeping a conversation inside the model's window.
 *
 * The renderer never loses anything: the thread keeps every message it ever had. This decides
 * only what is *sent*, and it decides it fresh on every turn — which is what makes it rolling
 * rather than a one-time truncation.
 *
 * What survives is chosen by what a model actually needs to keep working: the first user turn,
 * because it is the task and everything after it is in service of it; and the most recent turns,
 * because that is where the conversation actually is. The middle is what gets compacted.
 */

/** Leave the window this much slack, for the toolset growing and the estimate being an estimate. */
const SAFETY = 0.1;
/** Preferred recent tail; a tight budget may keep fewer rather than knowingly overflow. */
const MIN_RECENT = 4;

/**
 * When the window is exceeded, how much of it to refill — not all of it.
 *
 * Trimming to the brim means the next turn exceeds the window again, and the turn after that,
 * so every turn from then on removes another group from the middle. That is the expensive part:
 * a local engine caches the prompt it has already processed and reuses it when the next prompt
 * starts the same way, and removing something from the middle ends the match there. Measured on
 * this box, an unchanged prompt of 15,024 tokens came back in 0.5s against 62.4s cold, while the
 * same conversation with its middle folded away reused 6 tokens and reprocessed 10,036.
 *
 * Leaving headroom turns that from every turn into one turn in several: the compacted prefix
 * stays byte-identical while the conversation grows into the space, and each of those turns is a
 * cache hit. The cost is discarding some context that would still have fit, which is the cheaper
 * side of the trade — it is older context, and the alternative is paying to reprocess everything
 * that survived.
 */
const COMPACTION_TARGET = 0.7;

export interface FitResult {
  messages: Message[];
  /** How many of `messages` are the preserved opening, so a notice can be spliced after it. */
  headCount: number;
  /** How many messages were folded away; 0 when the whole conversation fit. */
  compacted: number;
  estimatedTokens: number;
  budgetTokens: number;
  /** Tokens the mandatory opening/current group exceed the budget by; zero in every normal fit. */
  overflowTokens: number;
  /** Whether the preferred conversational tail survived. It is a goal, never a reason to overflow. */
  minimumRecentMet: boolean;
  /** Set when the caller should summarize `dropped` and re-fit with the summary. */
  dropped: Message[];
}

/**
 * The room a prompt has: the window, less the reply, less the actual tools, less a safety margin.
 *
 * `boolean` is retained while call sites that discover tools after choosing a model migrate. It
 * cannot know the serialized toolset and therefore reserves none; callers with tools should pass
 * the definitions. The loop hands those definitions to its `fit` callback on every round.
 */
export function promptBudget(profile: ModelProfile, tools: boolean | readonly ToolDefinition[]): number {
  const reserved = profile.maxOutputTokens + (Array.isArray(tools) ? toolDefinitionTokens(tools) : 0);
  const cap = profile.maxEvaluatedTokens;
  if (typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0) {
    // Keep the full reply reservation: the server's final-token evaluation credit is not
    // extra room for an approximate tokenizer. An exhausted budget must remain exhausted.
    return Math.max(0, Math.floor((Math.min(profile.contextTokens, cap) - reserved) * (1 - SAFETY)));
  }
  return Math.max(512, Math.floor((profile.contextTokens - reserved) * (1 - SAFETY)));
}

/** Messages made by `compactionNotice`, including summaries inserted by the initial turn fit. */
export const isCompactionNotice = (message?: Message): boolean => !!message?.id.startsWith('compaction_');

const isSummaryNotice = (message: Message): boolean =>
  isCompactionNotice(message) && /messages, summarized\]/.test(message.content);

const noticeCount = (message: Message): number => {
  if (!isCompactionNotice(message)) return 0;
  const generic = /^\[(\d+) earlier messages? (?:was|were) dropped\b/.exec(message.content);
  const summary = /^\[Earlier in this conversation — (\d+) messages, summarized\]/.exec(message.content);
  return Number(generic?.[1] ?? summary?.[1] ?? 0);
};

interface MessageGroup {
  messages: Message[];
  tokens: number;
}

/**
 * Protocol-atomic groups in the rolling tail. An assistant's tool calls and every consecutive
 * result belong together: keeping only one side makes the next OpenAI-compatible request invalid.
 */
function tailGroups(messages: Message[], from: number): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (let index = from; index < messages.length; ) {
    const first = messages[index];
    const grouped = [first];
    index += 1;

    if (first.role === 'assistant' && first.toolCalls?.length) {
      while (index < messages.length && messages[index].role === 'tool') {
        grouped.push(messages[index]);
        index += 1;
      }
    } else if (
      first.role === 'user' &&
      (first.id.startsWith('background_') || first.id.startsWith('steer_'))
    ) {
      // Reports consumed from completed agents and a simultaneous human steer enter at one
      // inference boundary. They must survive or compact together: `take()` has already marked
      // the reports delivered, so dropping just one would lose delegated work permanently.
      while (
        index < messages.length &&
        messages[index].role === 'user' &&
        (messages[index].id.startsWith('background_') || messages[index].id.startsWith('steer_'))
      ) {
        grouped.push(messages[index]);
        index += 1;
      }
    } else if (first.role === 'tool') {
      // Invalid source transcripts occasionally contain a run of orphaned results. Keep the run
      // atomic as well, so a boundary can discard it as a whole instead of exposing one orphan.
      while (index < messages.length && messages[index].role === 'tool') {
        grouped.push(messages[index]);
        index += 1;
      }
    }

    groups.push({ messages: grouped, tokens: conversationTokens(grouped) });
  }
  return groups;
}

/**
 * Drops from the middle until the conversation fits, keeping the opening and the most recent
 * exchanges. A tool result is never separated from the call it answers: an orphaned `role: tool`
 * message is a protocol error on most servers, not merely confusing.
 *
 * The opening is the system message, if there is one, plus the first user turn. The system
 * message has to survive at any length — it is what tells the model its tools are real, and a
 * long conversation is exactly when it is most likely to start doubting that.
 */
export function fitToBudget(messages: Message[], budgetTokens: number): FitResult {
  const head: Message[] = [];
  if (messages[0]?.role === 'system') head.push(messages[0]);
  const firstUser = messages[head.length];
  if (firstUser?.role === 'user') head.push(firstUser);

  // Notices sit beside the opening, but they cannot all become mandatory forever: a long-lived
  // conversation can accumulate several summaries and eventually leave no room for the current
  // request. Keep at most one below, preferring a model-written summary to a generic gap marker.
  const noticeStart = head.length;
  let bodyStart = noticeStart;
  while (isCompactionNotice(messages[bodyStart])) bodyStart += 1;
  const openingNotices = messages.slice(noticeStart, bodyStart);

  const total = conversationTokens(messages);
  if (total <= budgetTokens) {
    return {
      messages,
      headCount: 0,
      compacted: 0,
      estimatedTokens: total,
      budgetTokens,
      overflowTokens: 0,
      minimumRecentMet: messages.length - bodyStart >= MIN_RECENT,
      dropped: [],
    };
  }

  let headTokens = head.reduce((sum, message) => sum + messageTokens(message), 0);

  const groups = tailGroups(messages, bodyStart);
  const latestGroupTokens = groups.at(-1)?.tokens ?? 0;
  const preferredNotice =
    [...openingNotices].reverse().find(isSummaryNotice) ?? openingNotices.at(-1);
  if (
    preferredNotice &&
    headTokens + messageTokens(preferredNotice) + latestGroupTokens <= budgetTokens
  ) {
    head.push(preferredNotice);
    headTokens += messageTokens(preferredNotice);
  }

  // Walk backwards taking whole protocol groups until the next one would not fit. The newest
  // complete group is mandatory: silently dropping the current user request would produce a
  // numerically valid prompt that answers the wrong turn. MIN_RECENT remains a preference, not
  // permission for older history to overflow.
  //
  // Filled to COMPACTION_TARGET of the budget rather than to the budget, so the turns after this
  // one grow into the headroom instead of each forcing another fold. Only reached when the
  // conversation did not fit, so a conversation inside its window is never trimmed for this.
  const fillTo = Math.max(headTokens, Math.floor(budgetTokens * COMPACTION_TARGET));
  const tail: Message[] = [];
  let used = headTokens;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    // Headroom is taken out of old context, never out of recent context. Until the preferred
    // tail is there, the whole budget is available; past it, the target applies and what is
    // left over buys the next few turns an unchanged prefix.
    const limit = tail.length < MIN_RECENT ? budgetTokens : fillTo;
    if (used + group.tokens > limit && index !== groups.length - 1) break;
    tail.unshift(...group.messages);
    used += group.tokens;
  }

  // A malformed source transcript can already contain orphaned results. Never make one the first
  // message after compaction, even though valid assistant/result groups cannot reach this branch.
  while (tail.length && tail[0].role === 'tool') {
    used -= messageTokens(tail[0]);
    tail.shift();
  }

  const kept = new Set([...head, ...tail]);
  const dropped = messages.filter((message) => !kept.has(message));
  return {
    messages: [...head, ...tail],
    headCount: head.length,
    compacted: dropped.length,
    estimatedTokens: used,
    budgetTokens,
    overflowTokens: Math.max(0, used - budgetTokens),
    minimumRecentMet: tail.length >= MIN_RECENT,
    dropped,
  };
}

let noticeSequence = 0;

/** The marker that stands in for what was dropped, so the model knows the gap is there. */
export const compactionNotice = (count: number, summary?: string): Message => {
  noticeSequence += 1;
  return {
    id: `compaction_${Date.now()}_${noticeSequence}`,
    role: 'user',
    content: summary
      ? `[Earlier in this conversation — ${count} messages, summarized]\n\n${summary}`
      : `[${count} earlier ${count === 1 ? 'message was' : 'messages were'} dropped to stay inside this model's context window. ` +
        `Ask if you need something from them.]`,
  };
};

/** A tool argument worth naming in a digest line, in the order most tools put the useful one. */
const DIGEST_ARGUMENT = ['path', 'command', 'directory', 'query', 'pattern', 'url', 'agent', 'name'];

const digestSubject = (rawArguments: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments || '{}');
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const args = parsed as Record<string, unknown>;
  for (const name of DIGEST_ARGUMENT) {
    const value = args[name];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text) return text.length > 96 ? `${text.slice(0, 95)}…` : text;
  }
  return '';
};

/** How many action lines a digest carries. The rest become a count, so it cannot grow forever. */
const DIGEST_LINES = 24;
/**
 * How many of those lines come from the beginning of the span.
 *
 * Keeping only the most recent calls is what lets a long session forget where it
 * is working. The oldest calls are the ones that establish the ground — which
 * directory the work lives in, which file was made first — and the newest only
 * show where the conversation has most recently drifted. A model reading a
 * digest of nothing but recent calls infers the project directory from the
 * drift, and starts writing somewhere else.
 *
 * So the digest keeps both ends and elides the middle, which is the same shape
 * `fitToBudget` already uses on the messages themselves: preserve the opening,
 * preserve the recent tail, compact what is between them.
 */
const DIGEST_OLDEST = 8;
const DIGEST_HEADING = 'Actions from the compacted part of this conversation, oldest first:';

/**
 * What happened in a span that is about to fall out of the window, written from the span itself.
 *
 * A bare "12 messages were dropped" is read by a model as an absence, and an absence is easily
 * read as "that was never done" — which is the failure this is for. A turn that had already
 * cloned an SDK compacted the proof, then reported the SDK as missing while it sat in the
 * directory it was told to work in, and went off to fetch it again.
 *
 * Each line is one call the conversation actually made, with the path or command it was given.
 * No inference runs: those calls are in the messages being dropped, so this costs nothing and
 * cannot be refused, be cut off, or invent a step that never happened. Lines already carried by
 * the marker this one replaces come through unchanged, so the account stays cumulative while
 * the window rolls.
 */
export function compactionDigest(dropped: readonly Message[]): string | undefined {
  const prose: string[] = [];
  const lines: string[] = [];
  let elided = 0;

  for (const message of dropped) {
    if (isCompactionNotice(message)) {
      // Carry what this marker already held rather than writing a new account over the top of it:
      // a model-written summary from the turn's opening fit, and the actions listed since.
      const body = message.content.split('\n').slice(1).join('\n');
      const [carriedProse, carriedActions = ''] = body.split(DIGEST_HEADING);
      if (carriedProse.trim()) prose.push(carriedProse.trim());
      for (const line of carriedActions.split('\n')) {
        const action = /^- (.+)$/.exec(line.trim());
        if (action) {
          lines.push(action[1]);
          continue;
        }
        const older = /^\(and (\d+) earlier /.exec(line.trim());
        if (older) elided += Number(older[1]);
      }
      continue;
    }
    for (const call of message.toolCalls ?? []) {
      const subject = digestSubject(call.function.arguments);
      lines.push(subject ? `${call.function.name} ${subject}` : call.function.name);
    }
  }

  if (!prose.length && !lines.length) return undefined;

  // Elide from the middle, keeping both ends. See DIGEST_OLDEST.
  let gap: string[] = [];
  if (lines.length > DIGEST_LINES) {
    elided += lines.length - DIGEST_LINES;
    lines.splice(DIGEST_OLDEST, lines.length - DIGEST_LINES);
  }
  if (elided) {
    // Wording and leading shape are load-bearing: the carry-forward parser above
    // recognises an elision line by this prefix, so a later digest that replaces
    // this one keeps the count instead of silently resetting it to zero.
    gap = [`(and ${elided} earlier ${elided === 1 ? 'call' : 'calls'} not listed)`];
  }

  const rendered = elided && lines.length > DIGEST_OLDEST
    ? [
        ...lines.slice(0, DIGEST_OLDEST).map((line) => `- ${line}`),
        ...gap,
        ...lines.slice(DIGEST_OLDEST).map((line) => `- ${line}`),
      ]
    : [...lines.map((line) => `- ${line}`), ...gap];

  const actions = lines.length
    ? [
        DIGEST_HEADING,
        ...rendered,
        'These ran. Their output is gone, not their effect — check the workspace before ' +
          'concluding that work described here was never done.',
      ].join('\n')
    : '';

  return [...prose, ...(actions ? [actions] : [])].join('\n\n');
}

/**
 * Fit a conversation and insert its durable gap marker without letting that marker (or a model
 * summary) push the request back over budget. If a summary alone makes the preserved opening too
 * large, the compact generic marker wins: an optional summary is never permission to overflow.
 */
export function fitWithCompactionNotice(
  messages: Message[],
  budgetTokens: number,
  summary?: string
): FitResult {
  const base = fitToBudget(messages, budgetTokens);
  if (!base.compacted) return base;

  const newlyDroppedCount = base.dropped.filter((message) => !isCompactionNotice(message)).length;

  const assemble = (noticeSummary?: string): FitResult => {
    // A fresh model summary replaces every older notice because the caller summarized those too.
    // A generic marker retains the preferred old summary, and only carries counts from notices
    // that no longer survive. This avoids claiming the same summarized history twice.
    const seed = noticeSummary
      ? base.messages.filter((message) => !isCompactionNotice(message))
      : base.messages.filter((message) => !isCompactionNotice(message) || isSummaryNotice(message));
    const retainedNoticeIds = new Set(seed.filter(isCompactionNotice).map((message) => message.id));
    const carriedNoticeCount = messages
      .filter((message) => isCompactionNotice(message) && !retainedNoticeIds.has(message.id))
      .reduce((total, message) => total + noticeCount(message), 0);
    let totalCompacted = newlyDroppedCount + carriedNoticeCount;
    const dropped = [...base.dropped];
    let notice = compactionNotice(totalCompacted, noticeSummary);
    let insertion = seed[0]?.role === 'system' ? 1 : 0;
    if (seed[insertion]?.role === 'user') insertion += 1;
    while (isCompactionNotice(seed[insertion])) insertion += 1;
    let candidate = [
      ...seed.slice(0, insertion),
      notice,
      ...seed.slice(insertion),
    ];
    let previous = '';

    // Every non-terminal pass removes at least one message or changes the marker count once, so
    // this bound is defensive rather than a normal exit.
    for (let pass = 0; pass <= messages.length + 2; pass += 1) {
      const fitted = fitToBudget(candidate, budgetTokens);
      const extra = fitted.dropped.filter((message) => !isCompactionNotice(message));
      if (extra.length) {
        dropped.push(...extra);
        totalCompacted += extra.length;
      }

      const replacement = compactionNotice(totalCompacted, noticeSummary);
      notice = { ...notice, content: replacement.content };
      // Only the marker created by this fit changes as more tail messages fall out. Replacing all
      // compaction notices here used to duplicate this id and erase earlier model-written summaries.
      candidate = fitted.messages.map((message) => (message.id === notice.id ? notice : message));
      const estimatedTokens = conversationTokens(candidate);
      const overflowTokens = Math.max(0, estimatedTokens - budgetTokens);
      const signature = `${totalCompacted}:${candidate.length}:${estimatedTokens}:${notice.content}`;

      if (!overflowTokens || signature === previous) {
        let headCount = candidate[0]?.role === 'system' ? 1 : 0;
        if (candidate[headCount]?.role === 'user') headCount += 1;
        while (isCompactionNotice(candidate[headCount])) headCount += 1;
        return {
          ...fitted,
          messages: candidate,
          headCount,
          compacted: totalCompacted,
          estimatedTokens,
          overflowTokens,
          dropped,
        };
      }
      previous = signature;
    }

    // Unreachable for finite input, but keep the safety property explicit if the grouping rules
    // ever change: report the actual final size instead of claiming it fit.
    const estimatedTokens = conversationTokens(candidate);
    return {
      ...base,
      messages: candidate,
      compacted: totalCompacted,
      estimatedTokens,
      overflowTokens: Math.max(0, estimatedTokens - budgetTokens),
      dropped,
    };
  };

  const preservesBaseMessages = (candidate: FitResult): boolean => {
    if (candidate.overflowTokens > base.overflowTokens) return false;
    const candidateIds = new Map<string, number>();
    for (const message of candidate.messages) {
      if (!isCompactionNotice(message)) {
        const key = `${message.role}\0${message.id}\0${message.toolCallId ?? ''}`;
        candidateIds.set(key, (candidateIds.get(key) ?? 0) + 1);
      }
    }
    return base.messages
      .filter((message) => !isCompactionNotice(message))
      .every((message) => {
        const key = `${message.role}\0${message.id}\0${message.toolCallId ?? ''}`;
        const count = candidateIds.get(key) ?? 0;
        if (!count) return false;
        candidateIds.set(key, count - 1);
        return true;
      });
  };

  const withSummary = assemble(summary);
  const originalIds = new Set(messages.map((message) => message.id));
  const summaryPersisted = withSummary.messages.some(
    (message) => isSummaryNotice(message) && !originalIds.has(message.id)
  );
  if ((!summary || summaryPersisted) && preservesBaseMessages(withSummary)) return withSummary;

  // A large summary may technically fit only by displacing useful tail history. Try the compact
  // marker before giving up on a notice entirely; it often fits in exactly that leftover space.
  const withGeneric = summary ? assemble(undefined) : withSummary;
  if (preservesBaseMessages(withGeneric)) return withGeneric;

  // Nothing here is free, so this is a trade rather than a preference: the compact marker costs
  // about thirty tokens, and paying for it with one more old exchange is the better side of that
  // trade. An unmarked gap is not a neutral omission — the model reads it as a conversation in
  // which the compacted work never happened, and sets about doing it again.
  if (withGeneric.overflowTokens <= base.overflowTokens) return withGeneric;

  // Overflowing is the one thing it is never worth: a marker that pushed the current request out
  // of the window would cost the turn instead of a memory of it.
  return base;
}
