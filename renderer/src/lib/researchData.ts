import { describeTurn, isActiveReply, type TurnTelemetry } from './telemetry';
import type { Message } from '../types';
import { collectCodeSnippets } from './codeSnippets';

export type ResearchMetric = Exclude<keyof TurnTelemetry, 'role' | 'source' | 'failed'>;
export interface ResearchRow { message: Message; turn: TurnTelemetry; active: boolean }
export interface ResearchSort { key: ResearchMetric; descending: boolean }

export function researchRows(messages: Message[], isStreaming: boolean, now: number): ResearchRow[] {
  return messages.map((message, index) => {
    const active = isActiveReply(message, index === messages.length - 1, isStreaming);
    const turn = describeTurn(message, index, now);
    turn.codeBlocks = collectCodeSnippets([message]).length;
    // Restored/imported replies without a finish time do not have a measured duration.
    const start = message.meta?.createdAt;
    const first = message.meta?.firstTokenAt;
    const finish = message.meta?.finishedAt ?? (active ? now : undefined);
    const secondsBetween = (a: number | undefined, b: number | undefined) =>
      a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : null;
    turn.ttft = message.role === 'assistant' ? secondsBetween(start, first) : null;
    turn.latency = message.role === 'assistant' ? secondsBetween(start, finish) : null;
    const generation = secondsBetween(first, finish);
    turn.rate = turn.tokens !== null && generation !== null && generation >= 0.25 ? turn.tokens / generation : null;
    return { message, turn, active };
  });
}

export function filterResearchRows(rows: ResearchRow[], query: string, role: 'all' | Message['role'], assistantName: string) {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(({ message, turn }) => (role === 'all' || turn.role === role) && (!needle || [
    message.content, turn.model, turn.source, turn.role === 'user' ? 'You' : assistantName,
  ].join(' ').toLocaleLowerCase().includes(needle)));
}

export function sortResearchRows(rows: ResearchRow[], sort: ResearchSort) {
  return [...rows].sort((a, b) => {
    const x = a.turn[sort.key];
    const y = b.turn[sort.key];
    if (x === null || y === null) return x === y ? a.turn.index - b.turn.index : x === null ? 1 : -1;
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return (sort.descending ? -order : order) || a.turn.index - b.turn.index;
  });
}

/** Missing observations stay missing; averages include only turns with that observation. */
export function summarizeResearchRows(rows: ResearchRow[]): Partial<Record<ResearchMetric, number | null>> {
  const turns = rows.map(({ turn }) => turn);
  const values = (key: ResearchMetric) => turns.map((turn) => turn[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const total = (key: ResearchMetric) => values(key).reduce((sum, value) => sum + value, 0);
  const mean = (key: ResearchMetric) => values(key).length ? total(key) / values(key).length : null;
  const weighted = (key: 'avgWord' | 'functionWordPct') => {
    const known = turns.filter((turn) => turn[key] !== null && turn.words > 0);
    const count = known.reduce((sum, turn) => sum + turn.words, 0);
    return count ? known.reduce((sum, turn) => sum + turn[key]! * turn.words, 0) / count : null;
  };
  const rated = turns.filter((turn) => turn.tokens !== null && turn.rate !== null && turn.rate > 0);
  const seconds = rated.reduce((sum, turn) => sum + turn.tokens! / turn.rate!, 0);
  return {
    ttft: mean('ttft'), latency: mean('latency'), tokens: values('tokens').length ? total('tokens') : null,
    rate: seconds ? rated.reduce((sum, turn) => sum + turn.tokens!, 0) / seconds : null,
    chars: total('chars'), words: total('words'), avgWord: weighted('avgWord'), functionWordPct: weighted('functionWordPct'),
    codeBlocks: total('codeBlocks'), files: total('files'),
  };
}

const TSV_HEADER = ['turn', 'role', 'time', 'source', 'model', 'ttft_s', 'latency_s', 'tokens_estimated', 'tok_per_s_estimated', 'chars', 'words', 'avg_word', 'fn_pct', 'code_blocks', 'files', 'message'];
const tsvCell = (value: string | number | null | undefined) => value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
const isoTime = (time: number | null) => {
  const date = time === null ? null : new Date(time);
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** Export every metric, independent of the visible column preset. Blank cells mean unmeasured. */
export function researchTsv(rows: ResearchRow[]) {
  return [TSV_HEADER.join('\t'), ...rows.map(({ message, turn: t }) => [
    t.index + 1, t.role, isoTime(t.time),
    t.source, t.model, t.ttft, t.latency, t.tokens, t.rate, t.chars, t.words, t.avgWord,
    t.functionWordPct, t.codeBlocks, t.files, message.content,
  ].map(tsvCell).join('\t'))].join('\n');
}
